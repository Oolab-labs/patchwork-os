/**
 * Recipe apiVersion migration layer.
 *
 * A `RecipeMigration` upgrades a recipe object from one declared
 * `apiVersion` to the next. Migrations are chained by the registry in
 * `./index.ts` until the recipe carries the current apiVersion or no
 * matching migration exists.
 *
 * Field-level legacy compatibility (e.g. `output -> into`,
 * `params` flattening, `trigger.schedule -> trigger.at`) lives in
 * `../legacyRecipeCompat.ts` and runs alongside this layer; migrations
 * here are reserved for changes that are explicitly version-bumped.
 */
export type WarnFn = (msg: string) => void;

export interface RecipeMigration {
  /**
   * apiVersion this migration consumes. `null` means "no apiVersion
   * field present" (i.e. an unversioned legacy recipe).
   */
  from: string | null;
  /** apiVersion this migration produces. */
  to: string;
  /**
   * Migrate a shallow-cloned record. Implementations should return a
   * new object rather than mutating the input.
   */
  migrate: (
    recipe: Record<string, unknown>,
    warn?: WarnFn,
  ) => Record<string, unknown>;
}
