/**
 * Plugin policy — may THIS recipe load THAT plugin?
 *
 * A recipe's `servers:` list names code that is imported into the bridge
 * process and handed the tool registry. Before the governed profile,
 * installing a recipe therefore equalled arbitrary in-process code execution:
 * nothing between "a YAML file arrived" and "its `index.mjs` ran" asked the
 * operator anything. Under `governed` (`profile.pluginPolicy === "allowlist"`)
 * a spec is loaded only when it appears in `config.plugins.allow`, and the
 * check is made at FOUR points — install, dashboard save, `recipe lint` and
 * runtime load — because a file on disk may have arrived by any route, so the
 * runtime never trusts that something upstream validated it.
 *
 * Under `compat` every spec is allowed, byte-identical to the previous
 * behaviour. This module holds no state: every verdict is a pure function of
 * (spec, profile, allowlist) plus, for integrity, the entrypoint bytes.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { PatchworkConfig } from "../patchworkConfig.js";
import type { GovernanceProfile } from "./profile.js";

export interface AllowEntry {
  spec: string;
  version?: string;
  integrity?: string;
}

export interface PluginPolicyInput {
  profile: Pick<GovernanceProfile, "mode" | "pluginPolicy">;
  allow: AllowEntry[] | undefined;
}

export interface PluginVerdict {
  spec: string;
  allowed: boolean;
  reason: string;
  entry?: AllowEntry;
}

/** The governed posture, for "what WOULD happen" evaluations under compat. */
export const GOVERNED_PLUGIN_POLICY_PROFILE: PluginPolicyInput["profile"] =
  Object.freeze({ mode: "governed", pluginPolicy: "allowlist" });

export const PLUGIN_NOT_ALLOWLISTED = "plugin_not_allowlisted";
export const PLUGIN_INTEGRITY_MISMATCH = "plugin_integrity_mismatch";

/** Error thrown by the runtime when a spec is refused. `code` is stable. */
export class PluginPolicyError extends Error {
  readonly code: string;
  readonly specs: string[];
  constructor(code: string, message: string, specs: string[]) {
    super(message);
    this.name = "PluginPolicyError";
    this.code = code;
    this.specs = specs;
  }
}

function isPathSpec(spec: string): boolean {
  return (
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec === "." ||
    spec === ".." ||
    path.isAbsolute(spec)
  );
}

/**
 * Canonical form of a spec for comparison. Path specs resolve to an absolute
 * path with the trailing separator dropped, so `./x`, `x/` written as `./x/`
 * and the absolute form all agree. Package specs are compared verbatim after
 * trimming — a package name has no equivalent spellings.
 */
export function normalisePluginSpec(spec: string, cwd = process.cwd()): string {
  const trimmed = spec.trim();
  if (isPathSpec(trimmed)) {
    const resolved = path.resolve(cwd, trimmed);
    return resolved.length > 1 ? resolved.replace(/[\\/]+$/, "") : resolved;
  }
  return trimmed;
}

/**
 * Pure: (spec, profile, allowlist) → verdict. Exact match on the normalised
 * spec; no globbing, no prefix matching — a policy that matches loosely is
 * a policy an attacker can satisfy by naming a sibling directory.
 */
export function evaluatePluginSpec(
  spec: string,
  input: PluginPolicyInput,
  cwd = process.cwd(),
): PluginVerdict {
  const trimmed = spec.trim();
  if (input.profile.pluginPolicy !== "allowlist") {
    return { spec: trimmed, allowed: true, reason: "compat profile: open" };
  }
  const wanted = normalisePluginSpec(trimmed, cwd);
  for (const entry of input.allow ?? []) {
    if (typeof entry?.spec !== "string") continue;
    if (normalisePluginSpec(entry.spec, cwd) === wanted) {
      return {
        spec: trimmed,
        allowed: true,
        reason: `allowlisted as "${entry.spec}"`,
        entry,
      };
    }
  }
  const size = (input.allow ?? []).length;
  return {
    spec: trimmed,
    allowed: false,
    reason:
      size === 0
        ? "governed profile: plugins.allow is empty — no recipe plugin may load"
        : `governed profile: "${trimmed}" is not in plugins.allow (${size} entr${size === 1 ? "y" : "ies"})`,
  };
}

/** Per-spec verdicts for `policy explain` / `doctor`. */
export function explainPluginPolicy(
  specs: string[],
  cfg: { profile: PluginPolicyInput["profile"]; allow?: AllowEntry[] },
  cwd = process.cwd(),
): PluginVerdict[] {
  return specs.map((s) =>
    evaluatePluginSpec(s, { profile: cfg.profile, allow: cfg.allow }, cwd),
  );
}

/** Convenience: the refused subset, for callers that build one error. */
export function refusedPluginSpecs(
  specs: string[],
  input: PluginPolicyInput,
  cwd = process.cwd(),
): PluginVerdict[] {
  return specs
    .map((s) => evaluatePluginSpec(s, input, cwd))
    .filter((v) => !v.allowed);
}

/** Build the runtime error for a set of refused verdicts. */
export function pluginNotAllowlistedError(
  refused: PluginVerdict[],
): PluginPolicyError {
  const names = refused.map((v) => v.spec);
  return new PluginPolicyError(
    PLUGIN_NOT_ALLOWLISTED,
    `recipe plugin${names.length === 1 ? "" : "s"} ${names.map((n) => `"${n}"`).join(", ")} ` +
      "not allowlisted under the governed profile — add to config.json " +
      "`plugins.allow` (spec, optional integrity) or switch to the compat profile",
    names,
  );
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

export interface IntegrityResult {
  ok: boolean;
  /** "verified" | "skipped" | "mismatch" | "unreadable" | "malformed" */
  status: "verified" | "skipped" | "mismatch" | "unreadable" | "malformed";
  reason: string;
  actual?: string;
}

export function sha256Integrity(bytes: Buffer): string {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

/**
 * `sha256-<base64>` over the entrypoint file bytes. Absent integrity is
 * SKIPPED (and says so) rather than failed: the allowlist entry itself is the
 * operator's decision, and integrity is an optional tightening of it.
 */
export function verifyPluginIntegrity(
  entrypointPath: string,
  integrity: string | undefined,
): IntegrityResult {
  if (integrity === undefined || integrity === null || integrity === "") {
    return {
      ok: true,
      status: "skipped",
      reason: "no integrity recorded on the allowlist entry",
    };
  }
  const m = /^sha256-([A-Za-z0-9+/]+={0,2})$/.exec(integrity.trim());
  if (!m) {
    return {
      ok: false,
      status: "malformed",
      reason: `integrity must be "sha256-<base64>", got ${JSON.stringify(integrity)}`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(entrypointPath);
  } catch (err) {
    return {
      ok: false,
      status: "unreadable",
      reason: `cannot read entrypoint ${entrypointPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const actual = sha256Integrity(bytes);
  if (actual !== `sha256-${m[1]}`) {
    return {
      ok: false,
      status: "mismatch",
      reason: `entrypoint ${entrypointPath} hashes to ${actual}, allowlist says ${integrity.trim()}`,
      actual,
    };
  }
  return { ok: true, status: "verified", reason: "sha256 matches", actual };
}

// ---------------------------------------------------------------------------
// Recipe scanning (install / save / doctor)
// ---------------------------------------------------------------------------

/** Extract `servers:` from a parsed recipe object; non-list ⇒ []. */
export function pluginSpecsOf(recipe: unknown): string[] {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) return [];
  const servers = (recipe as Record<string, unknown>).servers;
  if (!Array.isArray(servers)) return [];
  return servers.filter((s): s is string => typeof s === "string");
}

/** Extract `servers:` from recipe YAML text; unparseable ⇒ []. */
export function pluginSpecsOfYaml(text: string): string[] {
  try {
    return pluginSpecsOf(parseYaml(text));
  } catch {
    return [];
  }
}

export function policyInputFromConfig(
  profile: PluginPolicyInput["profile"],
  cfg: Pick<PatchworkConfig, "plugins"> | undefined,
): PluginPolicyInput {
  return { profile, allow: cfg?.plugins?.allow };
}

export interface RecipePluginScanRow {
  /** Recipe file, relative to `recipesDir`. */
  file: string;
  /** Recipe `name:` when parseable. */
  name?: string;
  verdicts: PluginVerdict[];
}

export interface RecipePluginScan {
  recipesDir: string;
  /** Recipe files inspected (the denominator). */
  recipesScanned: number;
  /** Recipes declaring at least one `servers:` entry. */
  recipesWithPlugins: number;
  refusedSpecs: number;
  rows: RecipePluginScanRow[];
}

function walkRecipeFiles(dir: string, out: string[], depth = 0): void {
  if (depth > 4) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkRecipeFiles(full, out, depth + 1);
    else if (/\.(ya?ml|json)$/i.test(name)) out.push(full);
  }
}

/**
 * Every installed recipe's `servers:` specs with their verdicts, for the
 * doctor governance section. Reports only recipes that declare plugins, but
 * counts every file read so an empty result is distinguishable from an
 * unreadable directory.
 */
export function scanInstalledRecipePlugins(
  recipesDir: string,
  cfg: { profile: PluginPolicyInput["profile"]; allow?: AllowEntry[] },
  cwd = process.cwd(),
): RecipePluginScan {
  const files: string[] = [];
  if (existsSync(recipesDir)) walkRecipeFiles(recipesDir, files);
  const rows: RecipePluginScanRow[] = [];
  let refused = 0;
  for (const file of files) {
    let parsed: unknown;
    try {
      const text = readFileSync(file, "utf-8");
      parsed = file.toLowerCase().endsWith(".json")
        ? JSON.parse(text)
        : parseYaml(text);
    } catch {
      continue;
    }
    const specs = pluginSpecsOf(parsed);
    if (specs.length === 0) continue;
    const verdicts = explainPluginPolicy(specs, cfg, cwd);
    refused += verdicts.filter((v) => !v.allowed).length;
    const name = (parsed as Record<string, unknown>).name;
    rows.push({
      file: path.relative(recipesDir, file),
      ...(typeof name === "string" ? { name } : {}),
      verdicts,
    });
  }
  return {
    recipesDir,
    recipesScanned: files.length,
    recipesWithPlugins: rows.length,
    refusedSpecs: refused,
    rows,
  };
}
