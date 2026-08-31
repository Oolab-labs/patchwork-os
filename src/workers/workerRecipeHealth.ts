/**
 * Does the recipe a worker is bound to actually WORK?
 *
 * `validateWorkers` answers every way a manifest can fail to BIND — it does not
 * parse, its `recipe:` is not installed, two workers claim the same one. All of
 * those end with `resolveWorkerIdForRecipe` returning undefined. None of them
 * looks at the other end of a binding that succeeded.
 *
 * Measured on the reference install: 8 manifests, `✓ no problems found`, while
 * `recipe doctor` on one of the bound recipes reported 8 errors and 2 warnings
 * — six unregistered tool ids and a variable written by three different steps —
 * and a second bound recipe performed a write it never declared. A worker whose
 * every step is skipped runs, finishes `done`, and governs nothing, which is the
 * same end state the rest of that validator exists to catch. The information was
 * already there; nobody ran `recipe doctor` once per worker.
 *
 * The probe is INJECTED. `runPreflight` pulls in the recipe planner, the tool
 * registry and the fixture loader, and a check that can only be exercised
 * through those can only be tested by breaking a real recipe.
 */

/** One issue as `runPreflight` reports it — level + code + sentence. */
export interface RecipeHealthIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

export interface RecipeHealthReport {
  ok: boolean;
  issues: RecipeHealthIssue[];
}

/** Probe one recipe by name. Throws if the recipe cannot be read or planned. */
export type RecipeHealthProbe = (
  recipeName: string,
) => Promise<RecipeHealthReport>;

export interface WorkerRecipeBinding {
  id: string;
  recipe?: string | undefined;
}

export interface RecipeHealthFinding {
  level: "error" | "warning";
  code: "recipe-unhealthy" | "recipe-uncheckable";
  message: string;
}

/**
 * Codes whose severity depends on state THIS process cannot see, and which
 * therefore must not decide an exit code.
 *
 * `unresolved-tool` — an unregistered tool id makes the runner SKIP the step
 * silently, which is deliberate (forward compatibility for a plugin that is not
 * loaded here). Measured across the reference install: 20 unregistered ids in
 * 14 of 82 recipes, all from plugins that live in another package. Failing on
 * those would make this check permanently red on a correctly configured
 * machine, and a permanently-red gate is how a real warning gets ignored. It is
 * still REPORTED, with what it means when the tool is not coming from anywhere.
 *
 * `unacknowledged-write` — enforced at runtime only under
 * `FLAG_ENFORCE_ALLOWWRITES`, which is off by default. An error under that flag
 * and advisory without it; this check cannot tell which machine it is on.
 */
const STATE_DEPENDENT_CODES = new Set([
  "unresolved-tool",
  "unacknowledged-write",
]);

/**
 * Probe each DISTINCT recipe a worker is bound to and turn what comes back into
 * validator findings.
 *
 * A probe that throws produces `recipe-uncheckable`, never silence and never a
 * pass: "the reading could not be taken" and "the reading was clean" are
 * different facts, and collapsing them is how a broken probe reads as a healthy
 * install.
 */
export async function probeWorkerRecipes(
  workers: readonly WorkerRecipeBinding[],
  opts: { probe: RecipeHealthProbe },
): Promise<RecipeHealthFinding[]> {
  const findings: RecipeHealthFinding[] = [];
  // Distinct recipes, first claimant kept for the message. Two workers claiming
  // one recipe is already an `ambiguous-recipe` error next door; probing it
  // twice would report the same defect twice under a different code.
  const byRecipe = new Map<string, string[]>();
  for (const w of workers) {
    if (!w.recipe) continue;
    byRecipe.set(w.recipe, [...(byRecipe.get(w.recipe) ?? []), w.id]);
  }

  for (const [recipe, ids] of byRecipe) {
    const who = ids.join(", ");
    let report: RecipeHealthReport;
    try {
      report = await opts.probe(recipe);
    } catch (err) {
      findings.push({
        level: "warning",
        code: "recipe-uncheckable",
        message:
          `${who} names recipe "${recipe}", which could NOT be checked: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          "Not a pass — nothing was verified about whether it can run.",
      });
      continue;
    }
    if (report.ok) continue;

    const errors = report.issues.filter((i) => i.level === "error");
    const hard = errors.filter((i) => !STATE_DEPENDENT_CODES.has(i.code));
    const level = hard.length > 0 ? "error" : "warning";
    const codes = [...new Set(errors.map((i) => i.code))].sort().join(", ");
    const detail = errors
      .slice(0, 4)
      .map((i) => i.message)
      .join("; ");
    const caveat =
      level === "warning"
        ? " Reported as a warning, not a failure: an unregistered tool may come " +
          "from a plugin this process did not load, and an undeclared write is " +
          "enforced only under FLAG_ENFORCE_ALLOWWRITES. If neither applies, the " +
          "step is skipped silently and the worker's run finishes `done` having " +
          "governed nothing."
        : "";
    findings.push({
      level,
      code: "recipe-unhealthy",
      message:
        `${who} is bound to recipe "${recipe}", which fails \`recipe doctor\` ` +
        `with ${errors.length} error(s) [${codes}]: ${detail}.${caveat}`,
    });
  }
  return findings;
}

/**
 * The denominator line. "0 unhealthy" over zero probed recipes and over eight
 * are different statements, and printing them identically is how an install
 * with nothing installed reads as an install with nothing wrong — the same
 * reason `formatWorkersValidate` leads with its manifest count.
 */
export function summariseRecipeHealth(
  findings: readonly RecipeHealthFinding[],
  counts: { probed: number },
): string {
  if (counts.probed === 0) {
    return "no worker is bound to a recipe, so no recipe was checked";
  }
  const unhealthy = findings.filter(
    (f) => f.code === "recipe-unhealthy",
  ).length;
  const uncheckable = findings.filter(
    (f) => f.code === "recipe-uncheckable",
  ).length;
  const tail = uncheckable > 0 ? `, ${uncheckable} could not be checked` : "";
  return `${unhealthy} of ${counts.probed} bound recipe(s) unhealthy${tail}`;
}
