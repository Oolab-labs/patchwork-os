/**
 * Status-pill verdict for the recipe-detail hub header.
 *
 * Lives in lib (not the route file) because Next.js route modules
 * (`layout.tsx`) may only export the framework-recognised names — an
 * arbitrary `export function` there fails the generated route typecheck.
 *
 * `recipesLoaded` distinguishes the two reasons the recipe can be
 * undefined:
 *   - list still in flight  → "loading"
 *   - list resolved, no match → "not found"
 * Without the split, a missing recipe showed a permanent "loading" pill
 * in the header while the page body rendered "Recipe not found" — the
 * header and body disagreed forever.
 */

export interface RecipeHeaderInput {
  enabled?: boolean;
  lint?: { ok: boolean; errorCount: number; warningCount: number };
}

export function statusPillFor(
  recipe: RecipeHeaderInput | undefined,
  recipesLoaded: boolean,
): { tone: "ok" | "warn" | "err" | "muted"; label: string } {
  if (!recipe) {
    return recipesLoaded
      ? { tone: "muted", label: "not found" }
      : { tone: "muted", label: "loading" };
  }
  if (recipe.lint && recipe.lint.ok === false) return { tone: "err", label: "lint error" };
  if (recipe.enabled === false) return { tone: "muted", label: "disabled" };
  return { tone: "ok", label: "enabled" };
}
