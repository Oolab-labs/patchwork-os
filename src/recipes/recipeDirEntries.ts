/**
 * What counts as a recipe entry in the recipes directory.
 *
 * Several scanners walk the recipes dir (scheduler, event-trigger collection,
 * HTTP listing, name lookup, `listYamlRecipes`, install-dir listing). They
 * used to carry their own copy of this rule, and the copies drifted: the HTTP
 * listing skipped dot-directories while the scheduler did not, so a recipe
 * moved into `.archive/` by `archiveRecipe` was still scheduled.
 */

/**
 * Names starting with "." are reserved for runtime bookkeeping (`.archive/`,
 * `.install/`, `.audit/`, `.disabled` markers) and are never a recipe or an
 * install dir.
 */
export function isReservedRecipeDirEntry(name: string): boolean {
  return name.startsWith(".");
}

/** Sidecar files that sit beside top-level recipes but are not recipes. */
const NON_RECIPE_JSON_SUFFIXES = [
  ".permissions.json",
  // Legacy location of promoteRecipeVariant's audit record (now `.audit/`).
  ".promote-audit.json",
] as const;

/** True when a top-level file name is a recipe file (YAML or JSON). */
export function isTopLevelRecipeFile(name: string): boolean {
  if (isReservedRecipeDirEntry(name)) return false;
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return true;
  if (!name.endsWith(".json")) return false;
  return !NON_RECIPE_JSON_SUFFIXES.some((s) => name.endsWith(s));
}
