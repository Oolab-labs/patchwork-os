import type { RecipeMigration } from "./types.js";

/**
 * Migrate an unversioned (no `apiVersion`) recipe to `patchwork.sh/v1`.
 *
 * The shape changes that distinguished pre-v1 from v1 (e.g. flat
 * `agent: true`, `params`, `output`, `trigger.schedule`) are still
 * accepted at runtime and lint via `../legacyRecipeCompat.ts`. This
 * migration's job is the explicit version stamp plus a single
 * deprecation warning telling authors to add `apiVersion` themselves.
 */
export const v1Migration: RecipeMigration = {
  from: null,
  to: "patchwork.sh/v1",
  migrate(recipe: Record<string, unknown>, warn?: (msg: string) => void) {
    warn?.(
      "Recipe missing 'apiVersion' — implicitly migrated to 'patchwork.sh/v1'. Add `apiVersion: patchwork.sh/v1` to silence this warning (will be required in a future major version).",
    );
    return { apiVersion: "patchwork.sh/v1", ...recipe };
  },
};
