import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "./patchworkConfig.js";
import { validateRecipeDefinition } from "./recipes/validation.js";

/**
 * Per-recipe disabled marker — must match the constant in
 * `src/commands/recipeInstall.ts` and `src/recipes/scheduler.ts` (kept inline
 * here to avoid a circular import via commands → recipesHttp → commands).
 *
 * Absence on a recipe's install dir = enabled (legacy default).
 * Presence = disabled — `runRecipeInstall` writes one on every fresh install.
 */
const DISABLED_MARKER = ".disabled";

/**
 * Returns true unless `filePath` lives inside an install dir whose
 * `.disabled` marker is present. Top-level legacy recipes (direct children
 * of `recipesDir`) are always considered enabled — there's no install dir
 * to put a marker in. Used by every trigger surface (webhook, manual fire,
 * automation) so the marker means the same thing everywhere.
 */
export function isRecipeFileEnabled(
  filePath: string,
  recipesDir: string,
): boolean {
  const rel = path.relative(recipesDir, filePath);
  // Top-level file in recipesDir → no install dir → enabled by default.
  if (rel === "" || rel.startsWith("..") || !rel.includes(path.sep)) {
    return true;
  }
  const installDirName = rel.split(path.sep)[0];
  if (!installDirName) return true;
  const installDir = path.join(recipesDir, installDirName);
  return !existsSync(path.join(installDir, DISABLED_MARKER));
}

/**
 * Iterate one level of subdirectories under `recipesDir` that look like
 * install dirs (directory containing `recipe.json` or at least one `.yaml`).
 * Skips dirs whose `.disabled` marker is present so callers automatically
 * honor the marker without having to remember.
 *
 * Yields `{ installDir, entrypointPath }` pairs where `entrypointPath` is the
 * file the caller should parse:
 *   - `recipe.json`'s `recipes.main` if a manifest exists
 *   - otherwise the first `*.yaml` / `*.yml` in the dir
 *
 * Used by webhook + manual-fire path resolvers to find recipes installed
 * via `runRecipeInstall`.
 */
function* iterateInstallDirs(
  recipesDir: string,
  options: { includeDisabled?: boolean } = {},
): Generator<{ installDir: string; entrypointPath: string; enabled: boolean }> {
  const includeDisabled = options.includeDisabled === true;
  let entries: string[];
  try {
    entries = readdirSync(recipesDir);
  } catch {
    return;
  }
  for (const f of entries) {
    const fullPath = path.join(recipesDir, f);
    let isDir = false;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const enabled = !existsSync(path.join(fullPath, DISABLED_MARKER));
    if (!enabled && !includeDisabled) continue;

    let entrypoint: string | null = null;
    const manifestPath = path.join(fullPath, "recipe.json");
    if (existsSync(manifestPath)) {
      try {
        const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
          recipes?: { main?: string };
        };
        if (m.recipes?.main) {
          const candidate = path.join(fullPath, m.recipes.main);
          if (existsSync(candidate)) entrypoint = candidate;
        }
      } catch {
        // malformed manifest — fall through to first-yaml fallback
      }
    }
    if (!entrypoint) {
      try {
        const yaml = readdirSync(fullPath).find((x) => /\.ya?ml$/i.test(x));
        if (yaml) entrypoint = path.join(fullPath, yaml);
      } catch {
        // unreadable
      }
    }
    if (entrypoint) {
      yield { installDir: fullPath, entrypointPath: entrypoint, enabled };
    }
  }
}

/**
 * Locate an install dir by the *recipe name* declared inside its entrypoint
 * (not the directory name). The dashboard reports recipes by the parsed
 * `name` field, while `runRecipeEnable` looks them up by dir name —
 * the two are usually different (`morning-pkg` vs `morning-brief`). Includes
 * disabled dirs so re-enabling actually finds them.
 */
function findInstallDirByRecipeName(
  recipesDir: string,
  name: string,
): string | null {
  for (const { installDir, entrypointPath } of iterateInstallDirs(recipesDir, {
    includeDisabled: true,
  })) {
    try {
      const ext = path.extname(entrypointPath).toLowerCase();
      const raw = readFileSync(entrypointPath, "utf-8");
      const parsed = (ext === ".json" ? JSON.parse(raw) : parseYaml(raw)) as {
        name?: string;
      };
      if (parsed.name === name) return installDir;
    } catch {
      // skip malformed
    }
  }
  return null;
}

/**
 * Unified enable/disable for install-dir AND legacy top-level recipes.
 *
 * Routing:
 *   1. Try to find an install dir whose entrypoint declares this `name`.
 *      If found, write/remove the `.disabled` marker on that dir. This
 *      matches CLI `recipe enable/disable` and the trigger-side
 *      enforcement landed in PRs #43 / #49.
 *   2. Otherwise the recipe is a top-level legacy file — fall back to
 *      the legacy `cfg.recipes.disabled` config-file array, which the
 *      scheduler already honors as a parallel mechanism (it checks both).
 *
 * Replaces the old dashboard-only `setRecipeEnabledFn` that wrote ONLY to
 * the legacy config — which silently did nothing for install-dir recipes.
 */
export function setRecipeEnabled(
  name: string,
  enabled: boolean,
  options: {
    recipesDir?: string;
    loadConfigFn?: typeof loadConfig;
    saveConfigFn?: (cfg: unknown) => void;
  } = {},
): { ok: boolean; error?: string } {
  const recipesDir =
    options.recipesDir ?? path.join(os.homedir(), ".patchwork", "recipes");

  try {
    const installDir = findInstallDirByRecipeName(recipesDir, name);
    if (installDir) {
      const markerPath = path.join(installDir, DISABLED_MARKER);
      if (enabled) {
        if (existsSync(markerPath)) rmSync(markerPath);
      } else {
        writeFileSync(markerPath, "");
      }
      return { ok: true };
    }

    // Legacy top-level path — fall back to config-file disabled list
    const cfg = (options.loadConfigFn ?? loadConfig)();
    const disabled = new Set<string>(
      (cfg as { recipes?: { disabled?: string[] } }).recipes?.disabled ?? [],
    );
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    const next = {
      ...(cfg as object),
      recipes: {
        ...((cfg as { recipes?: Record<string, unknown> }).recipes ?? {}),
        disabled: [...disabled],
      },
    };
    if (options.saveConfigFn) options.saveConfigFn(next);
    else {
      // Dynamic import to avoid coupling at module-load time and to keep
      // tests able to swap the saver via options.saveConfigFn.
      // biome-ignore lint/suspicious/noExplicitAny: dynamic require shape
      const mod = require("./patchworkConfig.js");
      mod.savePatchworkConfig(next);
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Patchwork recipes HTTP surface — reads installed recipes from disk so the
 * dashboard Recipes page can list what's available. The bridge does not yet
 * run recipes natively; this endpoint is strictly read-only today.
 */

export interface RecipeDraft {
  name: string;
  description?: string;
  trigger: {
    type: "manual" | "webhook" | "schedule" | "cron";
    path?: string;
    cron?: string;
    schedule?: string;
  };
  steps: Array<{ id: string; agent: boolean; prompt: string }>;
  vars?: Array<{
    name: string;
    description?: string;
    required?: boolean;
    default?: string;
  }>;
}

function normalizeRecipeDraftTrigger(
  trigger: RecipeDraft["trigger"],
): Record<string, string> {
  if (trigger.type === "schedule" || trigger.type === "cron") {
    const schedule =
      typeof trigger.schedule === "string" && trigger.schedule.trim()
        ? trigger.schedule.trim()
        : typeof trigger.cron === "string" && trigger.cron.trim()
          ? trigger.cron.trim()
          : "";

    return {
      type: "cron",
      ...(schedule ? { schedule } : {}),
    };
  }

  if (trigger.type === "webhook") {
    const pathValue =
      typeof trigger.path === "string" ? trigger.path.trim() : "";
    return {
      type: "webhook",
      ...(pathValue ? { path: pathValue } : {}),
    };
  }

  return { type: "manual" };
}

function validateRecipeDraft(draft: RecipeDraft): string | null {
  if (!draft || typeof draft !== "object") {
    return "Invalid recipe draft";
  }

  if (!draft.trigger || typeof draft.trigger !== "object") {
    return "trigger required";
  }

  if (
    draft.trigger.type !== "manual" &&
    draft.trigger.type !== "webhook" &&
    draft.trigger.type !== "schedule" &&
    draft.trigger.type !== "cron"
  ) {
    return "Invalid trigger type";
  }

  const normalizedTrigger = normalizeRecipeDraftTrigger(draft.trigger);
  if (normalizedTrigger.type === "webhook") {
    if (
      typeof normalizedTrigger.path !== "string" ||
      !normalizedTrigger.path.startsWith("/")
    ) {
      return "webhook trigger requires a path starting with /";
    }
  }

  if (normalizedTrigger.type === "cron") {
    if (
      typeof normalizedTrigger.schedule !== "string" ||
      !normalizedTrigger.schedule.trim()
    ) {
      return "cron trigger requires a schedule";
    }
  }

  if (!Array.isArray(draft.steps) || draft.steps.length === 0) {
    return "Recipe must have at least one step";
  }

  const stepIds = new Set<string>();
  for (let i = 0; i < draft.steps.length; i++) {
    const step = draft.steps[i];
    const index = i + 1;
    const id = typeof step?.id === "string" ? step.id.trim() : "";
    if (!id) {
      return `Step ${index} is missing an id`;
    }
    if (stepIds.has(id)) {
      return `Step ${index} has a duplicate id`;
    }
    stepIds.add(id);
    if (typeof step?.prompt !== "string" || !step.prompt.trim()) {
      return `Step ${index} is missing a prompt`;
    }
  }

  if (draft.vars !== undefined) {
    if (!Array.isArray(draft.vars)) {
      return "vars must be an array";
    }
    const varNames = new Set<string>();
    for (let i = 0; i < draft.vars.length; i++) {
      const item = draft.vars[i];
      const index = i + 1;
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      if (!name) {
        return `Variable ${index} is missing a name`;
      }
      if (varNames.has(name)) {
        return `Variable ${index} has a duplicate name`;
      }
      varNames.add(name);
    }
  }

  return null;
}

export function saveRecipe(
  recipesDir: string,
  draft: RecipeDraft,
): { ok: boolean; path?: string; error?: string } {
  const safeName = draft.name.toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(safeName)) {
    return { ok: false, error: "Invalid recipe name" };
  }
  const candidate = path.resolve(recipesDir, `${safeName}.json`);
  const base = path.resolve(recipesDir);
  if (!candidate.startsWith(base + path.sep)) {
    return { ok: false, error: "Invalid path" };
  }
  const validationError = validateRecipeDraft(draft);
  if (validationError) {
    return { ok: false, error: validationError };
  }
  try {
    mkdirSync(recipesDir, { recursive: true });
    const payload = {
      name: safeName,
      description: draft.description,
      trigger: normalizeRecipeDraftTrigger(draft.trigger),
      steps: draft.steps.map((s) => ({
        id: s.id.trim(),
        agent: s.agent,
        prompt: s.prompt,
      })),
      ...(draft.vars && draft.vars.length > 0
        ? {
            vars: draft.vars.map((item) => ({
              ...item,
              name: item.name.trim(),
            })),
          }
        : {}),
      createdAt: Date.now(),
    };
    const deepValidation = validateRecipeDefinition(payload);
    const deepError = deepValidation.issues.find(
      (issue) =>
        issue.level === "error" &&
        issue.message.startsWith("Step ") &&
        issue.message.includes("Unknown template reference"),
    );
    if (deepError) {
      return { ok: false, error: deepError.message };
    }
    writeFileSync(candidate, JSON.stringify(payload, null, 2), "utf-8");
    return { ok: true, path: candidate };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface RecipeContentResult {
  content: string;
  path: string;
}

function resolveJsonRecipePathByName(
  recipesDir: string,
  safeName: string,
): string | null {
  const candidate = path.resolve(recipesDir, `${safeName}.json`);
  const base = path.resolve(recipesDir);
  if (!candidate.startsWith(base + path.sep)) return null;
  if (existsSync(candidate)) return candidate;

  try {
    for (const entry of readdirSync(recipesDir)) {
      if (!entry.endsWith(".json") || entry.endsWith(".permissions.json")) {
        continue;
      }
      const entryPath = path.join(recipesDir, entry);
      try {
        const entryRaw = readFileSync(entryPath, "utf-8");
        const entryParsed = JSON.parse(entryRaw) as { name?: string };
        if (entryParsed.name?.toLowerCase() !== safeName) {
          continue;
        }
        return entryPath;
      } catch {
        // skip malformed candidate
      }
    }
  } catch {
    return null;
  }

  // Also search install dirs from `recipeInstall`. Skips dirs with
  // `.disabled` marker so the manual-fire / orchestrator path can't
  // resolve a recipe the user has explicitly disabled.
  for (const { entrypointPath } of iterateInstallDirs(recipesDir)) {
    if (!entrypointPath.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(entrypointPath, "utf-8")) as {
        name?: string;
      };
      if (parsed.name?.toLowerCase() === safeName) {
        return entrypointPath;
      }
    } catch {
      // skip malformed
    }
  }

  return null;
}

export function loadRecipeContent(
  recipesDir: string,
  name: string,
): RecipeContentResult | null {
  const safeName = name.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(safeName)) return null;

  const yamlPath = findYamlRecipePath(recipesDir, safeName);
  if (yamlPath) {
    try {
      return {
        content: readFileSync(yamlPath, "utf-8"),
        path: yamlPath,
      };
    } catch {
      return null;
    }
  }

  const jsonPath = resolveJsonRecipePathByName(recipesDir, safeName);
  if (!jsonPath) {
    return null;
  }

  try {
    return {
      content: readFileSync(jsonPath, "utf-8"),
      path: jsonPath,
    };
  } catch {
    return null;
  }
}

export function saveRecipeContent(
  recipesDir: string,
  name: string,
  content: string,
): { ok: boolean; path?: string; error?: string } {
  const safeName = name.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(safeName)) {
    return { ok: false, error: "Invalid recipe name" };
  }
  if (!content.trim()) {
    return { ok: false, error: "Recipe content is required" };
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

  const validation = validateRecipeDefinition(parsed);
  const warnings = validation.issues
    .filter((issue) => issue.level === "warning")
    .map((issue) => issue.message);
  const validationError = validation.issues.find(
    (issue) => issue.level === "error",
  );
  if (validationError) {
    return {
      ok: false,
      error: validationError.message,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  try {
    mkdirSync(recipesDir, { recursive: true });
    const base = path.resolve(recipesDir);
    const candidate =
      findYamlRecipePath(recipesDir, safeName) ??
      path.resolve(recipesDir, `${safeName}.yaml`);
    if (!candidate.startsWith(base + path.sep)) {
      return { ok: false, error: "Invalid path" };
    }
    writeFileSync(
      candidate,
      content.endsWith("\n") ? content : `${content}\n`,
      "utf-8",
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

/**
 * Deletes a recipe file (yaml/yml or json) plus any sidecar permissions file.
 * Returns ok=false with a 404-style error when the recipe cannot be located.
 */
export function deleteRecipeContent(
  recipesDir: string,
  name: string,
): { ok: boolean; path?: string; error?: string } {
  const safeName = name.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(safeName)) {
    return { ok: false, error: "Invalid recipe name" };
  }
  const base = path.resolve(recipesDir);
  const target =
    findYamlRecipePath(recipesDir, safeName) ??
    resolveJsonRecipePathByName(recipesDir, safeName);
  if (!target) {
    return { ok: false, error: "Recipe not found" };
  }
  const resolved = path.resolve(target);
  if (!resolved.startsWith(base + path.sep)) {
    return { ok: false, error: "Invalid path" };
  }
  try {
    rmSync(resolved, { force: true });
    const sidecar = `${resolved}.permissions.json`;
    if (existsSync(sidecar)) {
      try {
        rmSync(sidecar, { force: true });
      } catch {
        // sidecar removal best-effort
      }
    }
    return { ok: true, path: resolved };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Duplicate a recipe as a variant. Copies the source YAML, rewrites the
 * `name:` field to `<original>-v<N>` (first available suffix), and writes
 * the copy to disk. Returns the new variant name and path on success.
 *
 * The variant name follows the same validation rules as recipe names.
 * Suffixes v2..v9 are tried before returning an error.
 */
export function duplicateRecipe(
  recipesDir: string,
  sourceName: string,
): {
  ok: boolean;
  variantName?: string;
  path?: string;
  error?: string;
} {
  const safeName = sourceName.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(safeName)) {
    return { ok: false, error: "Invalid recipe name" };
  }
  const source = loadRecipeContent(recipesDir, safeName);
  if (!source) {
    return { ok: false, error: "Recipe not found" };
  }

  // Determine next available variant name: strip any existing -vN suffix,
  // then try -v2 through -v9.
  const base = safeName.replace(/-v\d+$/, "");
  let variantName: string | null = null;
  for (let n = 2; n <= 9; n++) {
    const candidate = `${base}-v${n}`;
    if (!findYamlRecipePath(recipesDir, candidate)) {
      variantName = candidate;
      break;
    }
  }
  if (!variantName) {
    return {
      ok: false,
      error: "Too many variants already exist (v2–v9 taken)",
    };
  }

  // Rewrite the name: field in the YAML. Simple line-by-line replacement
  // is safe here: the name field is always a scalar on its own line.
  const newContent = source.content.replace(
    /^name:\s*.+$/m,
    `name: ${variantName}`,
  );

  const saveResult = saveRecipeContent(recipesDir, variantName, newContent);
  if (!saveResult.ok) {
    return { ok: false, error: saveResult.error };
  }
  return { ok: true, variantName, path: saveResult.path };
}

/**
 * Promote a variant recipe to become the canonical name.
 *
 * Steps:
 *   1. Load the variant's YAML.
 *   2. Rewrite its `name:` field to `targetName`.
 *   3. Save under `targetName` (overwrites any existing file at that name).
 *   4. Delete the variant file so only one copy exists.
 *
 * The caller supplies `variantName` (e.g. "morning-brief-v2") and
 * `targetName` (e.g. "morning-brief"). Both must pass the recipe name
 * validation regex. Returns `{ ok, path }` on success.
 */
export function promoteRecipeVariant(
  recipesDir: string,
  variantName: string,
  targetName: string,
): { ok: boolean; path?: string; error?: string } {
  const safeVariant = variantName.toLowerCase();
  const safeTarget = targetName.toLowerCase();
  const nameRe = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  if (!nameRe.test(safeVariant) || !nameRe.test(safeTarget)) {
    return { ok: false, error: "Invalid recipe name" };
  }
  if (safeVariant === safeTarget) {
    return { ok: false, error: "Variant and target names must differ" };
  }

  const source = loadRecipeContent(recipesDir, safeVariant);
  if (!source) {
    return { ok: false, error: "Variant recipe not found" };
  }

  const newContent = source.content.replace(
    /^name:\s*.+$/m,
    `name: ${safeTarget}`,
  );

  const saveResult = saveRecipeContent(recipesDir, safeTarget, newContent);
  if (!saveResult.ok) {
    return { ok: false, error: saveResult.error };
  }

  // Delete the variant file — best-effort; don't fail the promote if cleanup fails.
  deleteRecipeContent(recipesDir, safeVariant);

  return { ok: true, path: saveResult.path };
}

/**
 * Lints raw YAML/JSON recipe content without writing to disk. Used by the
 * dashboard edit UI to surface validateRecipeDefinition warnings live, in
 * addition to the warnings returned by saveRecipeContent on save.
 */
export function lintRecipeContent(content: string): {
  ok: boolean;
  errors: string[];
  warnings: string[];
} {
  if (!content.trim()) {
    return { ok: false, errors: ["Recipe content is required"], warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content) as unknown;
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      warnings: [],
    };
  }

  const validation = validateRecipeDefinition(parsed);
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const issue of validation.issues) {
    if (issue.level === "error") errors.push(issue.message);
    else warnings.push(issue.message);
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Recipe trust levels
// ---------------------------------------------------------------------------

export const TRUST_LEVELS = [
  "draft",
  "manual_run",
  "ask_every_time",
  "ask_novel",
  "mostly_trusted",
  "fully_trusted",
] as const;

export type TrustLevel = (typeof TRUST_LEVELS)[number];

const TRUST_LEVELS_FILE = "trust_levels.json";

function trustLevelsPath(recipesDir: string): string {
  return path.join(recipesDir, TRUST_LEVELS_FILE);
}

function loadTrustLevels(recipesDir: string): Record<string, TrustLevel> {
  const p = trustLevelsPath(recipesDir);
  try {
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as Record<string, TrustLevel>;
  } catch {
    return {};
  }
}

function saveTrustLevels(
  recipesDir: string,
  levels: Record<string, TrustLevel>,
): void {
  const p = trustLevelsPath(recipesDir);
  mkdirSync(recipesDir, { recursive: true });
  writeFileSync(p, JSON.stringify(levels, null, 2), "utf-8");
}

export function getTrustLevel(recipesDir: string, name: string): TrustLevel {
  const levels = loadTrustLevels(recipesDir);
  return levels[name] ?? "draft";
}

export function setTrustLevel(
  recipesDir: string,
  name: string,
  level: TrustLevel,
): { ok: boolean; error?: string } {
  if (!TRUST_LEVELS.includes(level)) {
    return { ok: false, error: `Invalid trust level: ${level}` };
  }
  try {
    const levels = loadTrustLevels(recipesDir);
    levels[name] = level;
    saveTrustLevels(recipesDir, levels);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface RecipeSummary {
  name: string;
  description?: string;
  trigger?: string;
  /** For webhook triggers, the configured path (e.g. "/github-pr"). */
  webhookPath?: string;
  stepCount: number;
  path: string;
  installedAt: number;
  source: "user" | "project" | "unknown";
  enabled: boolean;
  trustLevel?: TrustLevel;
  vars?: Array<{
    name: string;
    description?: string;
    required?: boolean;
    default?: string;
  }>;
  /** Lint summary so the dashboard list can flag invalid recipes without N+1 fetches. */
  lint?: {
    ok: boolean;
    errorCount: number;
    warningCount: number;
    firstError?: string;
  };
}

export interface ListRecipesResult {
  recipesDir: string;
  recipes: RecipeSummary[];
}

export interface WebhookRecipeMatch {
  name: string;
  path: string;
  filePath: string;
  format: "json" | "yaml";
}

export function listInstalledRecipes(recipesDir: string): ListRecipesResult {
  let entries: string[];
  try {
    entries = readdirSync(recipesDir);
  } catch {
    return { recipesDir, recipes: [] };
  }

  const cfg = loadConfig();
  const disabledSet = new Set<string>(
    (cfg as { recipes?: { disabled?: string[] } }).recipes?.disabled ?? [],
  );
  const trustLevels = loadTrustLevels(recipesDir);

  const recipes: RecipeSummary[] = [];
  for (const f of entries) {
    const isYaml = f.endsWith(".yaml") || f.endsWith(".yml");
    const isJson = f.endsWith(".json") && !f.endsWith(".permissions.json");
    if (!isYaml && !isJson) continue;
    const fullPath = path.join(recipesDir, f);
    try {
      const raw = readFileSync(fullPath, "utf-8");
      const parsed = (isYaml ? parseYaml(raw) : JSON.parse(raw)) as {
        name?: string;
        description?: string;
        trigger?: { type?: string; path?: string };
        steps?: unknown[];
        vars?: Array<{
          name: string;
          description?: string;
          required?: boolean;
          default?: string;
        }>;
      };
      const stat = statSync(fullPath);
      const resolvedRecipesDir = path.resolve(recipesDir);
      let source: RecipeSummary["source"];
      if (
        fullPath.startsWith(resolvedRecipesDir + path.sep) ||
        fullPath === resolvedRecipesDir
      ) {
        source = "user";
      } else if (fullPath.includes(`${path.sep}.patchwork${path.sep}recipes`)) {
        source = "project";
      } else {
        source = "unknown";
      }
      const ext = isYaml ? (f.endsWith(".yml") ? ".yml" : ".yaml") : ".json";
      const parsedName = parsed.name ?? path.basename(f, ext);
      const lintRes = validateRecipeDefinition(parsed);
      let errCount = 0;
      let warnCount = 0;
      let firstError: string | undefined;
      for (const issue of lintRes.issues) {
        if (issue.level === "error") {
          errCount++;
          if (!firstError) firstError = issue.message;
        } else {
          warnCount++;
        }
      }
      const webhookPath =
        parsed.trigger?.type === "webhook" &&
        typeof parsed.trigger?.path === "string"
          ? parsed.trigger.path
          : undefined;
      recipes.push({
        name: parsedName,
        description: parsed.description,
        trigger: parsed.trigger?.type,
        ...(webhookPath ? { webhookPath } : {}),
        stepCount: Array.isArray(parsed.steps) ? parsed.steps.length : 0,
        path: fullPath,
        installedAt: stat.mtimeMs,
        source,
        // Top-level legacy recipes don't have install dirs to put a marker
        // in, so the `enabled` field still comes from the legacy config list.
        enabled: !disabledSet.has(parsedName),
        trustLevel: (trustLevels[parsedName] ?? "draft") as TrustLevel,
        ...(Array.isArray(parsed.vars) && parsed.vars.length > 0
          ? { vars: parsed.vars }
          : {}),
        lint: {
          ok: errCount === 0,
          errorCount: errCount,
          warningCount: warnCount,
          ...(firstError ? { firstError } : {}),
        },
      });
    } catch {
      // skip malformed recipe file
    }
  }

  // Second pass — recipes installed via `runRecipeInstall` into subdirs.
  // `enabled` reflects the per-install `.disabled` marker; the legacy
  // config disabled list is a top-level concern (we still apply it as a
  // safety belt in case a name collides).
  for (const {
    installDir,
    entrypointPath,
    enabled: installEnabled,
  } of iterateInstallDirs(recipesDir, { includeDisabled: true })) {
    try {
      const ext = path.extname(entrypointPath).toLowerCase();
      const isYaml = ext === ".yaml" || ext === ".yml";
      const isJson = ext === ".json";
      if (!isYaml && !isJson) continue;

      const raw = readFileSync(entrypointPath, "utf-8");
      const parsed = (isYaml ? parseYaml(raw) : JSON.parse(raw)) as {
        name?: string;
        description?: string;
        trigger?: { type?: string; path?: string };
        steps?: unknown[];
        vars?: Array<{
          name: string;
          description?: string;
          required?: boolean;
          default?: string;
        }>;
      };
      const stat = statSync(entrypointPath);
      const parsedName =
        parsed.name ??
        path.basename(entrypointPath, path.extname(entrypointPath));
      const lintRes = validateRecipeDefinition(parsed);
      let errCount = 0;
      let warnCount = 0;
      let firstError: string | undefined;
      for (const issue of lintRes.issues) {
        if (issue.level === "error") {
          errCount++;
          if (!firstError) firstError = issue.message;
        } else {
          warnCount++;
        }
      }
      const webhookPath =
        parsed.trigger?.type === "webhook" &&
        typeof parsed.trigger?.path === "string"
          ? parsed.trigger.path
          : undefined;
      recipes.push({
        name: parsedName,
        description: parsed.description,
        trigger: parsed.trigger?.type,
        ...(webhookPath ? { webhookPath } : {}),
        stepCount: Array.isArray(parsed.steps) ? parsed.steps.length : 0,
        path: entrypointPath,
        installedAt: stat.mtimeMs,
        source: "user",
        // Disabled if EITHER the install marker is set OR the legacy config
        // names this recipe — defence-in-depth so a stale config entry can't
        // accidentally re-enable a recipe the user explicitly disabled, and
        // the dashboard can't accidentally enable one disabled by an admin
        // through the legacy file.
        enabled: installEnabled && !disabledSet.has(parsedName),
        trustLevel: (trustLevels[parsedName] ?? "draft") as TrustLevel,
        ...(Array.isArray(parsed.vars) && parsed.vars.length > 0
          ? { vars: parsed.vars }
          : {}),
        lint: {
          ok: errCount === 0,
          errorCount: errCount,
          warningCount: warnCount,
          ...(firstError ? { firstError } : {}),
        },
      });
      void installDir;
    } catch {
      // skip malformed install dir
    }
  }

  recipes.sort((a, b) => a.name.localeCompare(b.name));
  return { recipesDir, recipes };
}

export function findYamlRecipePath(
  recipesDir: string,
  name: string,
): string | null {
  const safeName = name.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(safeName)) return null;

  const base = path.resolve(recipesDir);
  const candidates = [
    path.resolve(recipesDir, `${safeName}.yaml`),
    path.resolve(recipesDir, `${safeName}.yml`),
  ];
  for (const candidate of candidates) {
    if (!candidate.startsWith(base + path.sep)) return null;
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  let entries: string[];
  try {
    entries = readdirSync(recipesDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const entryPath = path.join(recipesDir, entry);
    try {
      const entryRaw = readFileSync(entryPath, "utf-8");
      const entryParsed = parseYaml(entryRaw) as { name?: string };
      if (entryParsed.name?.toLowerCase() !== safeName) {
        continue;
      }
      return entryPath;
    } catch {
      // skip malformed candidate
    }
  }

  // Also search install dirs from `recipeInstall`. Skips dirs with
  // `.disabled` marker so the manual-fire / orchestrator path can't
  // resolve a recipe the user has explicitly disabled.
  for (const { entrypointPath } of iterateInstallDirs(recipesDir)) {
    if (!/\.ya?ml$/i.test(entrypointPath)) continue;
    try {
      const parsed = parseYaml(readFileSync(entrypointPath, "utf-8")) as {
        name?: string;
      };
      if (parsed.name?.toLowerCase() === safeName) {
        return entrypointPath;
      }
    } catch {
      // skip malformed
    }
  }

  return null;
}

/**
 * Scan recipes and return the first webhook-triggered recipe whose
 * trigger.path matches the requested path. Returns null on miss.
 * Path match is exact (leading-slash required) — no wildcards yet.
 */
export function findWebhookRecipe(
  recipesDir: string,
  requestPath: string,
): WebhookRecipeMatch | null {
  let entries: string[];
  try {
    entries = readdirSync(recipesDir);
  } catch {
    return null;
  }
  // Pass 1 — top-level files (legacy)
  for (const f of entries) {
    const isYaml = f.endsWith(".yaml") || f.endsWith(".yml");
    const isJson = f.endsWith(".json") && !f.endsWith(".permissions.json");
    if (!isYaml && !isJson) continue;
    try {
      const filePath = path.join(recipesDir, f);
      const raw = readFileSync(filePath, "utf-8");
      const parsed = (isYaml ? parseYaml(raw) : JSON.parse(raw)) as {
        name?: string;
        trigger?: { type?: string; path?: string };
      };
      if (parsed.trigger?.type !== "webhook") continue;
      if (parsed.trigger.path === requestPath) {
        return {
          name: parsed.name ?? path.basename(f, path.extname(f)),
          path: requestPath,
          filePath,
          format: isYaml ? "yaml" : "json",
        };
      }
    } catch {
      // skip malformed
    }
  }
  // Pass 2 — install dirs (skips dirs marked .disabled).
  for (const { entrypointPath } of iterateInstallDirs(recipesDir)) {
    const ext = path.extname(entrypointPath).toLowerCase();
    const isYaml = ext === ".yaml" || ext === ".yml";
    const isJson = ext === ".json";
    if (!isYaml && !isJson) continue;
    try {
      const raw = readFileSync(entrypointPath, "utf-8");
      const parsed = (isYaml ? parseYaml(raw) : JSON.parse(raw)) as {
        name?: string;
        trigger?: { type?: string; path?: string };
      };
      if (parsed.trigger?.type !== "webhook") continue;
      if (parsed.trigger.path === requestPath) {
        return {
          name:
            parsed.name ??
            path.basename(entrypointPath, path.extname(entrypointPath)),
          path: requestPath,
          filePath: entrypointPath,
          format: isYaml ? "yaml" : "json",
        };
      }
    } catch {
      // skip malformed
    }
  }
  return null;
}

/**
 * Load a recipe by name and render a plain-text prompt suitable for
 * enqueueing to the Claude orchestrator. Returns null when the recipe
 * can't be found.
 */
export function loadRecipePrompt(
  recipesDir: string,
  name: string,
): { prompt: string; path: string } | null {
  const safeName = name.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(safeName)) return null;

  const recipePath = resolveJsonRecipePathByName(recipesDir, safeName);
  if (!recipePath) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(recipePath, "utf-8");
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as {
    name?: string;
    description?: string;
    steps?: Array<{
      id?: string;
      kind?: string;
      prompt?: string;
      tool?: string;
      description?: string;
    }>;
  };
  const lines: string[] = [];
  lines.push(`You are running the Patchwork recipe "${parsed.name ?? name}".`);
  if (parsed.description)
    lines.push(`\nRecipe description: ${parsed.description}`);
  if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
    lines.push(
      "\nCarry out each step in order and report progress after every step:\n",
    );
    for (let i = 0; i < parsed.steps.length; i++) {
      const s = parsed.steps[i];
      if (!s) continue;
      const label = s.id ?? `step-${i + 1}`;
      const body =
        s.prompt ??
        s.description ??
        (s.tool ? `Use tool ${s.tool}.` : "(no description)");
      lines.push(`${i + 1}. [${label}] ${body}`);
    }
  }
  lines.push(
    "\nWhen finished, print a one-line summary prefixed with 'RECIPE DONE:'.",
  );
  return { prompt: lines.join("\n"), path: recipePath };
}

/**
 * Append a webhook payload to a base prompt so the agent can reference
 * the request body. Payload is JSON-stringified and truncated so a
 * runaway caller can't blow up the orchestrator prompt budget.
 */
export function renderWebhookPrompt(
  basePrompt: string,
  payload: unknown,
): string {
  if (payload === undefined) return basePrompt;
  const MAX = 8_000;
  let body: string;
  try {
    body = JSON.stringify(payload, null, 2);
  } catch {
    body = String(payload);
  }
  if (body.length > MAX) body = `${body.slice(0, MAX)}\n…[truncated]`;
  return `${basePrompt}\n\nWebhook payload:\n\`\`\`json\n${body}\n\`\`\``;
}
