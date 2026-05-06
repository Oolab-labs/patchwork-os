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
 */
export const RESERVED_VAR_NAMES: ReadonlySet<string> = new Set([
  "date",
  "time",
  "YYYY",
  "ISO_NOW",
  "HH",
  "MM",
  "SS",
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
