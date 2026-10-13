/**
 * Optional operator limits on workflow runs and installed recipes.
 *
 *   PATCHWORK_MAX_CONCURRENT_RUNS=N — at most N workflow runs in progress at
 *     once in this bridge, across every recipe and every entry path (manual,
 *     dashboard, cron, webhook, automation hook). Counted in
 *     `RecipeOrchestrator.fire()`, the one chokepoint all of them share. A
 *     nested child recipe runs inside its parent's dispatch and never passes
 *     through `fire()`, so it is part of the parent's run, not a run of its own.
 *
 *   PATCHWORK_MAX_RECIPES=N — adding a recipe that would take the installed
 *     top-level count past N is refused. Updating a recipe that already exists
 *     is always allowed.
 *
 * Absent, empty, zero, negative or non-integer ⇒ unlimited: exactly the
 * behaviour before these settings were read at all. A malformed value fails
 * OPEN on purpose — a typo must not stop every run on the machine with a
 * refusal that names a limit nobody meant to set.
 */

export const RUN_LIMIT_REACHED = "run_limit_reached";
export const RECIPE_LIMIT_REACHED = "recipe_limit_reached";

/** A positive integer, or null (= unlimited) for anything else. */
export function parseOperatorLimit(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function maxConcurrentRunsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  return parseOperatorLimit(env.PATCHWORK_MAX_CONCURRENT_RUNS);
}

export function maxRecipesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  return parseOperatorLimit(env.PATCHWORK_MAX_RECIPES);
}

export function runLimitMessage(limit: number): string {
  return limit === 1
    ? "1 run is already in progress; try again when one finishes"
    : `${limit} runs are already in progress; try again when one finishes`;
}

export function recipeLimitMessage(limit: number): string {
  return limit === 1
    ? "1 recipe is already installed, the most this workspace allows; remove one before adding another"
    : `${limit} recipes are already installed, the most this workspace allows; remove one before adding another`;
}

/** Thrown by the install paths, which report failure by throwing. */
export class RecipeLimitError extends Error {
  readonly code = RECIPE_LIMIT_REACHED;
  constructor(readonly limit: number) {
    super(recipeLimitMessage(limit));
    this.name = "RecipeLimitError";
  }
}
