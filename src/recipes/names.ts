/**
 * Canonical name + variable-name rules for recipes.
 *
 * Single source of truth used by:
 *   - `src/recipesHttp.ts`        — file-system + HTTP route validation
 *   - `src/recipes/validation.ts` — `validateRecipeDefinition` lint
 *   - `dashboard/src/app/recipes/new/page.tsx` — form-side mirroring
 *     (the dashboard package re-declares them, kept in sync by hand)
 *   - `schemas/recipe.v1.json`    — IDE-time JSON-Schema validation
 *
 * Lives in its own module to avoid the circular import that arises if
 * the constants live in `recipesHttp.ts` (which imports
 * `validateRecipeDefinition` from `validation.ts`, which would then
 * import the constants back).
 */

/**
 * Canonical recipe-name regex. kebab-case, 1–64 chars, must start with
 * a letter or digit. Survey of all 22 production recipes in
 * `~/.patchwork/recipes/` confirmed none use underscore filenames; this
 * matches the JSON Schema `pattern` and the previous strict server
 * regex (which disagreed with the schema by also allowing `_`).
 */
export const RECIPE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Strip a registry scope from a recipe name.
 *
 * Marketplace registry recipes carry a *scoped* name in their
 * `recipe.json` (`@patchworkos/sprint-review-prep`) but the bridge
 * stores recipes on disk under the bare, unscoped kebab slug. The
 * recipe YAML `name:` should be the bare slug, but registry data
 * historically shipped the scoped form there too — which fails the
 * `RECIPE_NAME_RE` kebab check at install time.
 *
 * This normalizes either shape to the last `/`-delimited segment:
 *   - `@patchworkos/sprint-review-prep` → `sprint-review-prep`
 *   - `patchworkos/sprint-review-prep`  → `sprint-review-prep`
 *   - `sprint-review-prep`              → `sprint-review-prep` (unchanged)
 *
 * Only the `@scope/` prefix is forgiven — the resulting slug is still
 * validated by `RECIPE_NAME_RE` downstream, so a genuinely-invalid
 * name (`@bad/UPPER`, `../escape`, empty) still fails.
 */
export function stripRecipeScope(name: string): string {
  if (typeof name !== "string" || !name.includes("/")) return name;
  const segments = name.split("/");
  return segments[segments.length - 1] ?? name;
}

/**
 * Canonical variable-name regex (for `trigger.vars[].name` and
 * `trigger.inputs[].name`). Mirrors the runtime template-reference
 * regex root group in `validation.ts:extractTemplateDottedPaths`,
 * minus `-` (hyphens in var names parse oddly in template expressions).
 * Permits both SCREAMING_SNAKE and lowercase_snake conventions seen in
 * production recipes.
 */
export const RECIPE_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Built-in context keys reserved by the runtime. Declaring a `vars` or
 * `inputs` entry with any of these names would shadow trigger-emitted
 * data silently. The simple-identifier subset of
 * `registerRecipeContextKeys` + `extractTemplateExpressions builtinKeys`
 * (see `src/recipes/validation.ts`).
 *
 * Entries are stored LOWERCASE: the validator (and the dashboard mirror)
 * look up `name.toLowerCase()`, so the date-format keys (`yyyy`, `iso_now`,
 * `hh`, `mm`, `ss`) must be lowercase here or they would never match —
 * letting a `yyyy`/`YYYY` var silently shadow the built-in date key.
 */
export const RESERVED_VAR_NAMES: ReadonlySet<string> = new Set([
  "date",
  "time",
  "yyyy",
  "iso_now",
  "hh",
  "mm",
  "ss",
  "this",
  "hash",
  "message",
  "branch",
  "payload",
  "webhook_payload",
  "hook_path",
  "webhook_path",
  "file",
  "file_ext",
  "file_basename",
  "runner",
  "failed",
  "passed",
  "total",
  "failures",
  "event",
]);
