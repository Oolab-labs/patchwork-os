/**
 * A `git_hook` recipe that lints clean and never fires.
 *
 * `parseTrigger` in parser.ts requires `trigger.event` to be one of
 * `post-commit` / `pre-push` / `post-merge`. `validateRecipeDefinition` did not
 * check it at all, so a recipe naming the key anything else — `on:` is the
 * natural guess, and it is what GitHub Actions uses — passed lint with zero
 * errors and zero warnings, then failed to register at bridge startup with a
 * WARN buried in a log nobody reads. The recipe simply never ran.
 *
 * Observed live, not theorised: two installed recipes had been silently dead
 * this way, both declaring `on:` with an otherwise VALID value. The values
 * were right; only the key was wrong, so nothing looked broken anywhere a
 * person would look.
 *
 * This is the same drift `compoundSteps.ts` and `dataPolicyPlacement.ts` were
 * each written to close — authoring-time and run-time verdicts disagreeing —
 * and the same reasoning the `cron.at` check three lines above already states:
 * users should see the error at save time, not when the scheduler silently
 * fails to register the recipe.
 */

import { describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";

function lint(trigger: Record<string, unknown>) {
  return validateRecipeDefinition({
    name: "probe",
    trigger: { type: "git_hook", ...trigger },
    steps: [{ id: "s1", tool: "file.read", path: "/dev/null" }],
  });
}

const errorsOf = (t: Record<string, unknown>) =>
  lint(t).issues.filter((i) => i.level === "error");

describe("git_hook.event is validated at lint time", () => {
  it("accepts each event the parser accepts", () => {
    for (const event of ["post-commit", "pre-push", "post-merge"]) {
      expect(errorsOf({ event }), event).toEqual([]);
    }
  });

  it("rejects a missing event", () => {
    expect(
      errorsOf({})
        .map((e) => e.message)
        .join(" "),
    ).toMatch(/git_hook.*event/i);
  });

  it("rejects an event the parser would refuse", () => {
    expect(errorsOf({ event: "pre-commit" }).length).toBeGreaterThan(0);
  });

  it("names `on:` specifically, because that is the mistake people make", () => {
    // The live case. A generic "event is required" would be correct and much
    // less useful: the author DID say post-commit, and needs to be told the
    // key is wrong rather than the value.
    const msg = errorsOf({ on: "post-commit" })
      .map((e) => e.message)
      .join(" ");
    expect(msg).toMatch(/`on`/);
    expect(msg).toMatch(/`event`/);
  });

  it("still rejects `on:` carrying a value that is not valid either", () => {
    expect(errorsOf({ on: "pre-commit" }).length).toBeGreaterThan(0);
  });

  it("leaves other trigger types alone", () => {
    const r = validateRecipeDefinition({
      name: "probe",
      trigger: { type: "manual" },
      steps: [{ id: "s1", tool: "file.read", path: "/dev/null" }],
    });
    expect(r.issues.filter((i) => /git_hook/i.test(i.message))).toEqual([]);
  });
});
