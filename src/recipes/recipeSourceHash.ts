/**
 * Which bytes a loaded recipe came from.
 *
 * `loadYamlRecipe` reads a recipe file once and hands the parsed object to a
 * runner. The runner then stamps `recipeSha256` on the run row so a later
 * reader can tell whether the recipe on disk is still the one that ran.
 *
 * The hash is attached by OBJECT IDENTITY (a WeakMap), not as a property on
 * the recipe, for two reasons:
 *   - a property would leak into every place a recipe is serialised, linted or
 *     compared, and a recipe author could write one by hand;
 *   - a recipe that was copied, rebuilt or constructed in memory has no proven
 *     source bytes, so it must record NOTHING. Identity gives exactly that: a
 *     spread copy is a different object and simply has no entry. Absence on a
 *     run row means "not recorded", never "unchanged".
 */
import { createHash } from "node:crypto";

const sourceHashes = new WeakMap<object, string>();

/** Hex sha256 of exactly these bytes. */
export function sha256Hex(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Remember that `recipe` was parsed from bytes whose sha256 is `hash`. */
export function recordRecipeSourceSha256(recipe: object, hash: string): void {
  sourceHashes.set(recipe, hash);
}

/**
 * The sha256 of the file bytes `recipe` was loaded from, or `undefined` when
 * this object did not come straight from `loadYamlRecipe`.
 */
export function recipeSourceSha256(recipe: unknown): string | undefined {
  if (typeof recipe !== "object" || recipe === null) return undefined;
  return sourceHashes.get(recipe);
}

/**
 * Did the recipe change between the run and the plan?
 *
 * `"unknown"` whenever either side is missing — a run that predates the field,
 * or a plan that could not hash its file. Never a guess in either direction.
 */
export function recipeChangedSince(
  recorded: unknown,
  current: unknown,
): boolean | "unknown" {
  if (typeof recorded !== "string" || recorded.length === 0) return "unknown";
  if (typeof current !== "string" || current.length === 0) return "unknown";
  return recorded !== current;
}
