import type { RecipeMigration, WarnFn } from "./types.js";
import { v1Migration } from "./v1.js";

export type { RecipeMigration, WarnFn } from "./types.js";
export { v1Migration } from "./v1.js";

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
