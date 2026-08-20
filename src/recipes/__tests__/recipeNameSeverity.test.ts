/**
 * The recipe-name rule said "should"; the parser says no.
 *
 * `validateRecipeDefinition` warned that a name "should use kebab-case", which
 * reads as a style preference. `parseRecipe` REFUSES a name outside
 * `RECIPE_NAME_RE`, and it backs both the installer and the event-trigger
 * collector — so such a recipe cannot be installed via `recipe install` and
 * can never register a file_watch / git_hook / on_file_save / on_test_run
 * trigger. Two installed recipes carry such names today.
 *
 * The severity is split rather than raised wholesale, and the split is
 * measured. A cron recipe with a non-conforming name still RUNS: the scheduler
 * loads it by its own path, and the live logs show no scheduler complaint about
 * either offender. Making this an error everywhere would fail recipes that
 * work — the opposite mistake, and the one that gets a rule deleted.
 *
 * So: error where it provably breaks (event triggers, which cannot register),
 * warning elsewhere — with wording that states the consequence instead of
 * implying taste. Same scoping as the step-id rule.
 */

import { describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";

const steps = [{ id: "s1", tool: "file.read", path: "/dev/null" }];

function lint(name: string, trigger: unknown) {
  return validateRecipeDefinition({ name, description: "d", trigger, steps });
}

const CRON = { type: "cron", at: "0 9 * * *" };
const EVENT = { type: "on_test_run" };
const BAD = "Ollama Local Engine Test";

describe("a name the parser would refuse", () => {
  it("is only a warning on a cron recipe, which still runs", () => {
    const r = lint(BAD, CRON);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(
      r.issues.filter((i) => i.level === "warning" && /name/i.test(i.message)),
    ).not.toEqual([]);
  });

  it("is an ERROR on an event-triggered recipe, which cannot register", () => {
    const errs = lint(BAD, EVENT).issues.filter((i) => i.level === "error");
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.map((e) => e.message).join(" ")).toMatch(
      /register|never fires/i,
    );
  });

  it("says what actually happens rather than what is tidy", () => {
    // "should use kebab-case" reads as taste. The consequence is refusal.
    const msg = lint(BAD, CRON)
      .issues.map((i) => i.message)
      .join(" ");
    expect(msg).toMatch(/install|register/i);
    expect(msg).not.toMatch(/should use kebab-case\b/);
  });

  it("leaves a conforming name alone under both triggers", () => {
    for (const trigger of [CRON, EVENT]) {
      const r = lint("fine-name", trigger);
      expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
      expect(
        r.issues.filter(
          (i) => i.level === "warning" && /kebab|name/i.test(i.message),
        ),
      ).toEqual([]);
    }
  });

  it("still accepts the scoped @scope/name registry form", () => {
    const r = lint("@acme/some-recipe", CRON);
    expect(r.issues.filter((i) => /kebab|name/i.test(i.message))).toEqual([]);
  });
});
