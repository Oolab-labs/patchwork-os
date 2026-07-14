/**
 * Worker manifest (*.worker.yaml) file-system read/write + validation,
 * mirroring recipesHttp.ts's saveRecipeContent/loadRecipeContent shape.
 *
 * Workers had no HTTP write path at all before this — manifests were purely
 * hand-authored text files, loaded read-only via workers/workerLoader.ts's
 * loadWorkersFromDir(). This module adds the save/lint side so the dashboard
 * (and eventually the copilot chat pane) can create one.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { findYamlRecipePath } from "./recipesHttp.js";
import { knownActionDomains } from "./workers/actionClass.js";
import {
  parseWorker,
  WORKER_ID_RE,
  type WorkerManifest,
  WorkerParseError,
} from "./workers/worker.js";
import { writeFileAtomicSync } from "./writeFileAtomic.js";

export interface WorkerLintIssue {
  level: "error" | "warning";
  message: string;
}

/**
 * Validate a parsed worker manifest against the fixed action-class
 * vocabulary and the referenced recipe's existence. Schema-shape errors
 * (bad id, missing name, malformed autonomyCeiling) are already thrown by
 * parseWorker() itself — callers should catch WorkerParseError separately.
 * This only covers the checks parseWorker can't: cross-referencing another
 * file (the recipe) and comparing against a vocabulary parseWorker doesn't
 * know about (action-class domains live in a sibling module to avoid a
 * worker.ts <-> actionClass.ts import cycle).
 */
export function lintWorkerManifest(
  worker: WorkerManifest,
  recipesDir: string,
): WorkerLintIssue[] {
  const issues: WorkerLintIssue[] = [];

  if (worker.recipe) {
    const recipePath = findYamlRecipePath(recipesDir, worker.recipe);
    if (!recipePath) {
      issues.push({
        level: "error",
        message: `worker.recipe "${worker.recipe}" does not match any installed recipe.`,
      });
    }
  } else {
    issues.push({
      level: "warning",
      message:
        "worker.recipe is unset — this worker has no body (nothing to run).",
    });
  }

  if (worker.owns.length === 0) {
    issues.push({
      level: "warning",
      message:
        "worker.owns is empty — this worker is gated on every action-class by default.",
    });
  }

  const domains = new Set(knownActionDomains());
  for (const pattern of worker.owns) {
    // A pattern may be a bare domain (`fs-write`) or an exact/prefix
    // class-key (`fs-write:reversible:medium`) — only the bare-domain form
    // is checked against the closed vocabulary; a class-key's domain is its
    // first `:`-delimited segment.
    const domain = pattern.split(":")[0];
    if (domain && !domains.has(domain)) {
      issues.push({
        level: "warning",
        message: `owns pattern "${pattern}" does not match any known action-class domain (${[...domains].join(", ")}).`,
      });
    }
  }

  return issues;
}

/** Parse + lint raw worker YAML content without saving. Mirrors
 *  lintRecipeContentFn's shape in recipeRoutes.ts. */
export function lintWorkerContent(
  content: string,
  recipesDir: string,
): { ok: boolean; errors: WorkerLintIssue[]; warnings: WorkerLintIssue[] } {
  let parsed: unknown;
  try {
    parsed = parseYaml(content) as unknown;
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          level: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      ],
      warnings: [],
    };
  }

  let worker: WorkerManifest;
  try {
    worker = parseWorker(parsed);
  } catch (err) {
    const message =
      err instanceof WorkerParseError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ok: false,
      errors: [{ level: "error", message }],
      warnings: [],
    };
  }

  const issues = lintWorkerManifest(worker, recipesDir);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  return { ok: errors.length === 0, errors, warnings };
}

export function loadWorkerContent(
  workersDir: string,
  id: string,
): { content: string; path: string } | null {
  const safeId = id.toLowerCase();
  if (!WORKER_ID_RE.test(safeId)) return null;
  const candidate = path.resolve(workersDir, `${safeId}.worker.yaml`);
  const base = path.resolve(workersDir);
  if (!candidate.startsWith(base + path.sep) && candidate !== base) return null;
  if (!existsSync(candidate)) return null;
  try {
    return { content: readFileSync(candidate, "utf-8"), path: candidate };
  } catch {
    return null;
  }
}

export function listWorkers(workersDir: string): {
  workersDir: string;
  workers: WorkerManifest[];
} {
  let entries: string[];
  try {
    entries = readdirSync(workersDir);
  } catch {
    return { workersDir, workers: [] };
  }
  const workers: WorkerManifest[] = [];
  for (const f of entries) {
    if (!/\.worker\.ya?ml$/i.test(f)) continue;
    try {
      workers.push(
        parseWorker(parseYaml(readFileSync(path.join(workersDir, f), "utf-8"))),
      );
    } catch {
      // Fail-soft, same as loadWorkersFromDir — one malformed manifest must
      // not blind the whole list.
    }
  }
  return {
    workersDir,
    workers: workers.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * Save worker manifest content to `<workersDir>/<id>.worker.yaml`. Validates
 * the YAML parses, the schema is well-formed (parseWorker), and the
 * cross-reference/vocabulary lint (recipe exists, owns patterns recognized)
 * — the last of these are warnings-only, matching lintWorkerManifest's
 * severity split, so a worker referencing a not-yet-installed recipe can
 * still be saved (e.g. saved before its recipe, or intentionally disabled).
 */
export function saveWorkerContent(
  workersDir: string,
  recipesDir: string,
  id: string,
  content: string,
): { ok: boolean; path?: string; error?: string; warnings?: string[] } {
  const safeId = id.toLowerCase();
  if (!WORKER_ID_RE.test(safeId)) {
    return { ok: false, error: "Invalid worker id" };
  }
  if (!content.trim()) {
    return { ok: false, error: "Worker content is required" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content) as unknown;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let worker: WorkerManifest;
  try {
    worker = parseWorker(parsed);
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof WorkerParseError || err instanceof Error
          ? err.message
          : String(err),
    };
  }

  const issues = lintWorkerManifest(worker, recipesDir);
  const warnings = issues
    .filter((i) => i.level === "warning")
    .map((i) => i.message);
  const error = issues.find((i) => i.level === "error");
  if (error) {
    return {
      ok: false,
      error: error.message,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  // Same drift-prevention as saveRecipeContent: rewrite `id:` to match the
  // filename if the body disagrees, via parse -> mutate -> stringify (robust
  // against duplicate/quoted keys a text-replace would miss).
  let normalizedContent = content;
  if (worker.id !== safeId) {
    const oldId = worker.id;
    const rewritten = { ...(parsed as Record<string, unknown>), id: safeId };
    try {
      normalizedContent = stringifyYaml(rewritten);
      warnings.push(
        `Worker body id "${oldId}" was rewritten to "${safeId}" to match the filename.`,
      );
    } catch {
      normalizedContent = content.replace(/^id:\s*.+$/m, `id: ${safeId}`);
      warnings.push(
        `Worker body id "${oldId}" was rewritten to "${safeId}" to match the filename (text-replace fallback).`,
      );
    }
  }

  try {
    mkdirSync(workersDir, { recursive: true });
    const base = path.resolve(workersDir);
    const candidate = path.resolve(workersDir, `${safeId}.worker.yaml`);
    if (!candidate.startsWith(base + path.sep)) {
      return { ok: false, error: "Invalid path" };
    }
    writeFileAtomicSync(
      candidate,
      normalizedContent.endsWith("\n")
        ? normalizedContent
        : `${normalizedContent}\n`,
      { encoding: "utf-8" },
    );
    return {
      ok: true,
      path: candidate,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
