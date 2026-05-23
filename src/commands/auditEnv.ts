/**
 * auditEnv — statically scan a recipe YAML for {{env.FOO}} references
 * and verify those vars exist in process.env (or an optional .env file).
 *
 * Fills a gap that `recipe preflight` does NOT cover: preflight checks
 * lint/tools/write-steps but silently produces empty string at runtime
 * for missing {{env.FOO}} references. auditEnv catches that statically.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveFilePath } from "../tools/utils.js";

export interface AuditEnvOptions {
  /** Path to a .env file to check against (workspace-scoped only). */
  envFile?: string;
  /** Required when envFile is provided — used for path-jail check. */
  workspace?: string;
}

export interface AuditEnvResult {
  ok: boolean;
  /** Recipe name (from YAML) or the path used to load it. */
  recipe: string;
  /** Env vars referenced in the recipe but not present. */
  missing: string[];
  /** Env vars referenced in the recipe and present. */
  present: string[];
  /** Non-fatal issues (e.g. value looks like a placeholder). */
  warnings: string[];
}

// ── Pattern ──────────────────────────────────────────────────────────────────

/** Matches {{env.FOO}} and {{env.foo}} references in template strings. */
const ENV_REF_RE = /\{\{env\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/**
 * Walk every string value in an arbitrary JSON/YAML-parsed object and collect
 * all unique env var names referenced via {{env.NAME}}.
 */
function collectEnvRefs(
  value: unknown,
  seen: Set<string> = new Set(),
): Set<string> {
  if (typeof value === "string") {
    for (const m of value.matchAll(ENV_REF_RE)) {
      // m[1] is always defined — the regex has exactly one capture group
      seen.add(m[1] as string);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectEnvRefs(item, seen);
    }
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectEnvRefs(v, seen);
    }
  }
  return seen;
}

// ── .env file parser ──────────────────────────────────────────────────────────

/**
 * Parse a simple KEY=VALUE .env file.  Lines starting with # and blank lines
 * are ignored.  Values may be optionally quoted with ' or ".  Does NOT expand
 * variable references — only static values are relevant for presence checks.
 */
function parseDotEnv(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!key) continue;
    let val = line.slice(eqIdx + 1).trim();
    // Strip surrounding quotes if present
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    map.set(key, val);
  }
  return map;
}

// ── Placeholder heuristic ─────────────────────────────────────────────────────

/** Values that look like placeholders rather than real secrets. */
const PLACEHOLDER_RE =
  /^(changeme|replace[-_]?me|todo|fixme|<[^>]+>|\[.*\]|your[-_]?.*here|placeholder|example|xxx+|dummy|fake|test)$/i;

function looksLikePlaceholder(val: string): boolean {
  return PLACEHOLDER_RE.test(val.trim());
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan `recipeRef` (file path or installed recipe name) for {{env.FOO}}
 * references and report which env vars are present / missing.
 *
 * `recipeRef` is resolved exactly like `recipe lint` — absolute/relative file
 * paths are used directly; bare names are looked up under the default recipes
 * dir.  We intentionally do NOT re-import the heavy `resolveRecipePath` helper
 * from recipe.ts (would pull in the entire 2 400-line module).  Instead we do
 * a minimal two-step: try direct path first, then give a clear error.
 */
export async function runAuditEnv(
  recipeRef: string,
  options: AuditEnvOptions = {},
): Promise<AuditEnvResult> {
  // ── 1. Resolve recipe path ─────────────────────────────────────────────────
  const directPath = resolve(recipeRef);
  let recipePath: string;

  if (existsSync(directPath) && statSync(directPath).isFile()) {
    recipePath = directPath;
  } else {
    return {
      ok: false,
      recipe: recipeRef,
      missing: [],
      present: [],
      warnings: [`Recipe file not found: ${recipeRef}`],
    };
  }

  // ── 2. Load + parse YAML ───────────────────────────────────────────────────
  let raw: unknown;
  try {
    const text = readFileSync(recipePath, "utf-8");
    raw = parseYaml(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      recipe: recipeRef,
      missing: [],
      present: [],
      warnings: [`Failed to parse recipe YAML: ${msg}`],
    };
  }

  // Prefer recipe.name for display; fall back to path.
  const recipeName =
    raw !== null &&
    typeof raw === "object" &&
    typeof (raw as Record<string, unknown>).name === "string"
      ? ((raw as Record<string, unknown>).name as string)
      : recipeRef;

  // ── 3. Collect {{env.FOO}} references ─────────────────────────────────────
  const refs = collectEnvRefs(raw);

  if (refs.size === 0) {
    return {
      ok: true,
      recipe: recipeName,
      missing: [],
      present: [],
      warnings: [],
    };
  }

  // ── 4. Build env lookup map ────────────────────────────────────────────────
  // Start with process.env as baseline.
  let envMap: Map<string, string | undefined> = new Map(
    Object.entries(process.env),
  );

  if (options.envFile) {
    // Security: envFile must stay within workspace.
    if (!options.workspace) {
      return {
        ok: false,
        recipe: recipeName,
        missing: [],
        present: [],
        warnings: [
          "envFile provided but workspace is required for path validation",
        ],
      };
    }
    try {
      resolveFilePath(options.envFile, options.workspace);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        recipe: recipeName,
        missing: [],
        present: [],
        warnings: [`envFile path rejected: ${msg}`],
      };
    }

    const envFilePath = resolve(options.workspace, options.envFile);
    if (!existsSync(envFilePath)) {
      return {
        ok: false,
        recipe: recipeName,
        missing: [],
        present: [],
        warnings: [`envFile not found: ${options.envFile}`],
      };
    }

    const dotEnvContent = readFileSync(envFilePath, "utf-8");
    const dotEnvMap = parseDotEnv(dotEnvContent);
    // envFile entries supplement (and override) process.env entries.
    envMap = new Map([...envMap, ...dotEnvMap]);
  }

  // ── 5. Split refs into present / missing ──────────────────────────────────
  const missing: string[] = [];
  const present: string[] = [];
  const warnings: string[] = [];

  for (const name of Array.from(refs).sort()) {
    const val = envMap.get(name);
    if (val === undefined || val === null) {
      missing.push(name);
    } else {
      present.push(name);
      // Warn if the value looks like an unfilled placeholder.
      if (looksLikePlaceholder(val)) {
        warnings.push(
          `${name} is set but value looks like a placeholder ("${val}")`,
        );
      }
    }
  }

  return {
    ok: missing.length === 0,
    recipe: recipeName,
    missing,
    present,
    warnings,
  };
}
