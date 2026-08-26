/**
 * `patchwork workers list` / `workers validate` — read-only.
 *
 * `workers` shipped with `shadow` and `backtest` only, so a worker reached a
 * running bridge by hand-copying a file and there was no way to ask whether it
 * had landed correctly. Three failure modes are silent, and all three end the
 * same way — the autonomy gate does not govern that worker at all:
 *
 *  1. **A manifest that does not parse is SKIPPED.** `loadWorkersFromDir` is
 *     fail-soft by design (one bad file must not blind the whole dial), and it
 *     logs only when the caller passes a logger. The bridge does not pass one
 *     on the resolution path.
 *  2. **A `recipe:` naming something not installed** binds the worker to
 *     nothing.
 *  3. **Two manifests claiming the same recipe** resolve to `undefined` —
 *     deliberately, since guessing would apply the wrong worker's policy — so
 *     BOTH are ignored rather than one winning.
 *
 * In every case `resolveWorkerIdForRecipe` returns undefined, the caller falls
 * back to the tier-based approval fn, and the worker ramp never runs. The worker
 * gate is composed as a FLOOR over the tier fn — it can only ADD approvals — so
 * losing it means the recipe is governed LESS, not more. Most sharply, a
 * manifest's ADR-0017 `forbids` list, whose whole point is that no trust and no
 * approval can unlock the action, becomes inert without a word.
 *
 * Manifest drift has the opposite problem: `detectWorkerManifestDrift` is wired,
 * but only into the bridge's STARTUP report. A real signal that appears once, in
 * a log, at the moment nobody is watching. This makes it something an operator
 * can ask for.
 *
 * Read-only and deliberately no `install` verb: a package format has to answer
 * the third-copy problem (`templates/workers/` and `~/.patchwork/workers/`
 * already diverge, which is why `manifestDrift` exists at all), and that is a
 * design decision, not a missing function.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { patchworkPath } from "../patchworkHome.js";
import { parseForbidRules } from "./forbidPolicy.js";
import {
  detectWorkerManifestDrift,
  formatWorkerManifestDrift,
} from "./manifestDrift.js";
import { parseWorker, type WorkerManifest } from "./worker.js";

const MANIFEST_RE = /\.worker\.ya?ml$/i;

export interface LoadedWorker {
  file: string;
  worker: WorkerManifest;
}

export interface BrokenWorker {
  file: string;
  reason: string;
}

export interface WorkersScan {
  dir: string;
  loaded: LoadedWorker[];
  /** Files that exist and do NOT load. The population `loadWorkersFromDir` drops. */
  broken: BrokenWorker[];
}

/**
 * Like `loadWorkersFromDir`, but KEEPS what it could not parse instead of
 * discarding it. That difference is the entire point: the loader's job is to
 * keep the bridge running, this one's job is to tell an operator what the
 * bridge silently ignored.
 */
export function scanWorkers(dir: string): WorkersScan {
  const loaded: LoadedWorker[] = [];
  const broken: BrokenWorker[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { dir, loaded, broken };
  }
  for (const file of entries.sort()) {
    if (!MANIFEST_RE.test(file)) continue;
    try {
      loaded.push({
        file,
        worker: parseWorker(
          parseYaml(readFileSync(path.join(dir, file), "utf-8")),
        ),
      });
    } catch (err) {
      broken.push({
        file,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { dir, loaded, broken };
}

/** Recipe names installed in `dir`, for the dangling-reference check. */
export function installedRecipeNames(dir: string): Set<string> {
  const names = new Set<string>();
  if (!existsSync(dir)) return names;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return names;
  }
  for (const f of entries) {
    if (!/\.ya?ml$/i.test(f)) continue;
    try {
      const parsed = parseYaml(readFileSync(path.join(dir, f), "utf-8")) as
        | { name?: unknown }
        | undefined;
      if (typeof parsed?.name === "string") names.add(parsed.name);
    } catch {
      // An unreadable recipe is the recipe subsystem's problem to report, not
      // this one's. Skipping it can only make the dangling check MORE likely to
      // fire, never less — it cannot hide a real finding.
    }
  }
  return names;
}

export interface WorkersFinding {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
}

export interface ValidateResult {
  findings: WorkersFinding[];
  healthy: boolean;
  counts: { loaded: number; broken: number };
}

export function validateWorkers(opts: {
  workersDir: string;
  recipesDir: string;
  templatesDir?: string;
}): ValidateResult {
  const scan = scanWorkers(opts.workersDir);
  const findings: WorkersFinding[] = [];

  for (const b of scan.broken) {
    findings.push({
      level: "error",
      code: "unparseable-manifest",
      message:
        `${b.file} does not parse, so the bridge SKIPS it — no worker owns its ` +
        `recipe and the autonomy gate (including any forbids) never runs for it. ${b.reason}`,
    });
  }

  const recipes = installedRecipeNames(opts.recipesDir);
  const claims = new Map<string, string[]>();
  for (const { worker } of scan.loaded) {
    if (!worker.recipe) {
      findings.push({
        level: "warning",
        code: "no-recipe",
        message: `${worker.id} declares no \`recipe:\`, so nothing binds it to a run. Its owns/forbids govern nothing.`,
      });
      continue;
    }
    if (recipes.size > 0 && !recipes.has(worker.recipe)) {
      findings.push({
        level: "error",
        code: "dangling-recipe",
        message: `${worker.id} names recipe "${worker.recipe}", which is not installed. The worker governs nothing.`,
      });
    }
    claims.set(worker.recipe, [
      ...(claims.get(worker.recipe) ?? []),
      worker.id,
    ]);
  }

  for (const { worker } of scan.loaded) {
    // `forbids` is held raw on the manifest and parsed at point of use, because
    // a deny-list that silently loses a rule fails OPEN: the banned action
    // degrades to merely gated, and a human can then approve it. That is the
    // one direction ADR-0017's terminal `forbid` must never degrade in, so an
    // unparseable entry is an ERROR here rather than a warning.
    const parsed = parseForbidRules(worker.forbids);
    if (parsed.invalid.length > 0) {
      findings.push({
        level: "error",
        code: "unparseable-forbid-rule",
        message:
          `${worker.id} has ${parsed.invalid.length} unparseable forbids entr${parsed.invalid.length === 1 ? "y" : "ies"} ` +
          `(index ${parsed.invalid.join(", ")}). A dropped deny-rule fails OPEN — the action becomes merely gated, ` +
          "which a human can approve.",
      });
    }
  }

  for (const [recipe, ids] of claims) {
    if (ids.length > 1) {
      findings.push({
        level: "error",
        code: "ambiguous-recipe",
        message:
          `recipe "${recipe}" is claimed by ${ids.length} workers (${ids.join(", ")}). ` +
          "Resolution refuses to guess, so ALL of them are ignored — not one of them wins.",
      });
    }
  }

  if (opts.templatesDir) {
    const drift = detectWorkerManifestDrift({
      templatesDir: opts.templatesDir,
      liveDir: opts.workersDir,
    });
    for (const line of formatWorkerManifestDrift(drift)) {
      findings.push({
        level: "warning",
        code: "manifest-drift",
        message: line,
      });
    }
  }

  return {
    findings,
    healthy: !findings.some((f) => f.level === "error"),
    counts: { loaded: scan.loaded.length, broken: scan.broken.length },
  };
}

export function formatWorkersList(scan: WorkersScan): string {
  const out: string[] = [];
  out.push(`Workers in ${scan.dir}`);
  out.push("─".repeat(40));
  if (scan.loaded.length === 0 && scan.broken.length === 0) {
    out.push("  (none installed)");
    out.push("");
    return `${out.join("\n")}\n`;
  }
  for (const { worker } of scan.loaded) {
    out.push(
      `  ${worker.id}  —  ${worker.name}\n` +
        `      recipe: ${worker.recipe ?? "(none)"}   ceiling: L${worker.autonomyCeiling}   ` +
        `owns: ${worker.owns.length}   forbids: ${parseForbidRules(worker.forbids).rules.length}`,
    );
  }
  // Broken files are listed WITH the healthy ones, not hidden behind a flag.
  // The whole failure mode is that they are invisible.
  for (const b of scan.broken) {
    out.push(
      `  ✗ ${b.file}  —  NOT LOADED (the bridge ignores it): ${b.reason}`,
    );
  }
  out.push("");
  out.push(
    `  ${scan.loaded.length} loaded${scan.broken.length > 0 ? `, ${scan.broken.length} IGNORED` : ""}`,
  );
  out.push("");
  return `${out.join("\n")}\n`;
}

export function formatWorkersValidate(result: ValidateResult): string {
  const out: string[] = [];
  out.push("Worker manifest validation");
  out.push("─".repeat(40));
  // Lead with the denominator, like `privacy receipts` and `halts`: "0 problems"
  // over an empty directory is not the same statement as "0 problems" over eight
  // manifests, and reporting them identically is how an empty install reads as a
  // clean one.
  out.push(
    `  ${result.counts.loaded} manifest(s) load, ${result.counts.broken} ignored`,
  );
  if (result.findings.length === 0) {
    out.push("");
    out.push(
      result.counts.loaded === 0
        ? "  nothing to check — no worker manifests are installed"
        : "  ✓ no problems found",
    );
    out.push("");
    return `${out.join("\n")}\n`;
  }
  out.push("");
  for (const f of result.findings) {
    const mark = f.level === "error" ? "✗" : f.level === "warning" ? "⚠" : "·";
    out.push(`  ${mark} [${f.code}] ${f.message}`);
  }
  out.push("");
  return `${out.join("\n")}\n`;
}

export function defaultWorkersDir(): string {
  return patchworkPath("workers");
}
export function defaultRecipesDir(): string {
  return patchworkPath("recipes");
}
