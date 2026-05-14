import type { RecipeMigration, WarnFn } from "./types.js";
import { v1Migration } from "./v1.js";

export type { RecipeMigration, WarnFn } from "./types.js";
export { v1Migration } from "./v1.js";

/**
 * Default deprecation-warning sink for the runtime/validation/fmt callers.
 * Forwards to `console.warn` outside of tests so users see migration
 * prompts in CLI output, but stays silent under vitest so the dozens of
 * intentional legacy-shape regression fixtures don't flood stderr. Tests
 * that need to assert warnings still pass their own `vi.fn()` directly.
 */
export const defaultDeprecationWarn: WarnFn = (msg) => {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  console.warn(msg);
};

/** apiVersion produced by the most recent migration. */
export const CURRENT_API_VERSION = "patchwork.sh/v1";

/**
 * Ordered list of available migrations. Each step's `to` is consumed
 * by the next step's `from` (or matches `CURRENT_API_VERSION`).
 */
const REGISTRY: ReadonlyArray<RecipeMigration> = [v1Migration];

export interface MigrationResult {
  /** Migrated recipe object. Same reference if no migrations applied. */
  recipe: unknown;
  /** Sequence of "<from> -> <to>" strings describing applied migrations. */
  applied: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readApiVersion(recipe: Record<string, unknown>): string | null {
  return typeof recipe.apiVersion === "string" ? recipe.apiVersion : null;
}

/**
 * Migrate a recipe object up to `CURRENT_API_VERSION`.
 *
 * Behavior:
 * - Non-record inputs are returned as-is with no migrations applied.
 * - Each iteration looks for a registered migration whose `from`
 *   matches the current `apiVersion` and applies it.
 * - The loop stops when the recipe declares `CURRENT_API_VERSION`,
 *   when no matching migration exists for an unversioned recipe (no-op),
 *   or when the recipe declares an unknown future apiVersion (passed
 *   through unchanged so downstream schema lint can flag it).
 */
export function migrateRecipeToCurrent(
  recipe: unknown,
  warn?: WarnFn,
): MigrationResult {
  if (!isRecord(recipe)) {
    return { recipe, applied: [] };
  }

  let current: Record<string, unknown> = { ...recipe };
  const applied: string[] = [];
  // Bound the loop defensively so a malformed registry can never
  // produce an infinite cycle.
  const maxIterations = REGISTRY.length + 1;

  for (let i = 0; i < maxIterations; i++) {
    const version = readApiVersion(current);
    if (version === CURRENT_API_VERSION) {
      break;
    }

    const migration = REGISTRY.find((m) => m.from === version);
    if (!migration) {
      // Unknown future/unsupported apiVersion: leave the recipe alone
      // and let schema lint surface the enum mismatch with a clear
      // message instead of throwing here.
      break;
    }

    const next = migration.migrate(current, warn);
    current = isRecord(next) ? next : current;
    applied.push(`${migration.from ?? "(unversioned)"} -> ${migration.to}`);
  }

  return { recipe: current, applied };
}

// ---------------------------------------------------------------------------
// Field-level legacy normalisation (formerly legacyRecipeCompat.ts)
//
// These functions accept recipes in any historical shape and produce the
// current canonical shape.  They run alongside the apiVersion migration
// chain above.
// ---------------------------------------------------------------------------

export function normalizeRecipeForRuntime(
  recipe: unknown,
  warn?: WarnFn,
): unknown {
  if (!isRecord(recipe)) {
    return recipe;
  }

  // Apply apiVersion migrations first so downstream field-level
  // legacy compat operates on a recipe stamped with the current
  // apiVersion (and so the deprecation warning for missing
  // apiVersion fires once per call).
  const migrated = migrateRecipeToCurrent(recipe, warn).recipe;
  const source = isRecord(migrated) ? migrated : recipe;

  const normalized: Record<string, unknown> = {
    ...source,
  };

  if (isRecord(normalized.trigger)) {
    normalized.trigger = normalizeLegacyTriggerForRuntime(
      normalized.trigger,
      warn,
    );
  }

  if (Array.isArray(normalized.steps)) {
    normalized.steps = normalized.steps.map((step) =>
      normalizeLegacyRuntimeStep(step, warn),
    );
  }

  return normalized;
}

function normalizeLegacyTriggerForRuntime(
  trigger: Record<string, unknown>,
  warn?: WarnFn,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...trigger };

  if (
    normalized.type === "cron" &&
    typeof normalized.schedule === "string" &&
    typeof normalized.at !== "string"
  ) {
    warn?.(
      "Deprecated recipe field: trigger.schedule — rename to trigger.at (will be removed in a future major version)",
    );
    normalized.at = normalized.schedule;
  }

  delete normalized.schedule;

  return normalized;
}

function normalizeLegacyRuntimeStep(step: unknown, warn?: WarnFn): unknown {
  if (!isRecord(step)) {
    return step;
  }

  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(step)) {
    if (key === "params" || key === "output" || key === "prompt") {
      continue;
    }
    if (key === "agent" && typeof value === "boolean") {
      continue;
    }
    if (key === "parallel" && Array.isArray(value)) {
      normalized.parallel = value.map((entry) =>
        normalizeLegacyRuntimeStep(entry, warn),
      );
      continue;
    }
    if (key === "branch" && Array.isArray(value)) {
      normalized.branch = value.map((entry) =>
        normalizeLegacyBranchEntry(entry, warn),
      );
      continue;
    }
    normalized[key] = value;
  }

  if (step.agent === true || isRecord(step.agent)) {
    const agentConfig: Record<string, unknown> = isRecord(step.agent)
      ? { ...step.agent }
      : {};

    if (
      typeof step.prompt === "string" &&
      typeof agentConfig.prompt !== "string"
    ) {
      warn?.(
        "Deprecated recipe step field: prompt at step level — move to step.agent.prompt (will be removed in a future major version)",
      );
      agentConfig.prompt = step.prompt;
    }

    if (
      typeof step.output === "string" &&
      typeof agentConfig.into !== "string"
    ) {
      warn?.(
        "Deprecated recipe step field: output — use step.agent.into instead (will be removed in a future major version)",
      );
      agentConfig.into = step.output;
    }

    if (step.agent === true) {
      warn?.(
        "Deprecated recipe step field: agent: true — use agent: { prompt, into } object instead (will be removed in a future major version)",
      );
    }

    normalized.agent = agentConfig;
    return normalized;
  }

  if (isRecord(step.params)) {
    warn?.(
      "Deprecated recipe step field: params — inline fields directly on the step (will be removed in a future major version)",
    );
    Object.assign(normalized, step.params);
  }

  if (
    typeof normalized.recipe !== "string" &&
    typeof normalized.chain === "string"
  ) {
    warn?.(
      "Deprecated recipe step field: chain — rename to recipe (will be removed in a future major version)",
    );
    normalized.recipe = normalized.chain;
  }
  delete normalized.chain;

  if (typeof normalized.into !== "string" && typeof step.output === "string") {
    warn?.(
      "Deprecated recipe step field: output — rename to into (will be removed in a future major version)",
    );
    normalized.into = step.output;
  }

  if (
    normalized.tool === "file.append" &&
    typeof normalized.content !== "string" &&
    typeof normalized.line === "string"
  ) {
    warn?.(
      "Deprecated recipe step field: line (file.append) — rename to content (will be removed in a future major version)",
    );
    normalized.content = normalized.line;
    delete normalized.line;
  }

  return normalized;
}

function normalizeLegacyBranchEntry(entry: unknown, warn?: WarnFn): unknown {
  if (!isRecord(entry)) {
    return entry;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "otherwise" && isRecord(value)) {
      normalized.otherwise = normalizeLegacyRuntimeStep(value, warn);
      continue;
    }
    normalized[key] = value;
  }

  if (Object.hasOwn(normalized, "otherwise")) {
    return normalized;
  }

  return normalizeLegacyRuntimeStep(entry, warn);
}
