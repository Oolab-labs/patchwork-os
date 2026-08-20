/**
 * An event-triggered recipe whose steps have no `id` can never register.
 *
 * `collectEventTriggerPrograms` parses each candidate with `parseRecipe`, and
 * `parseStep` calls `requireString(s, "id")` — so a step without one throws,
 * the recipe is skipped at bridge startup with a WARN in a log, and it never
 * fires. `validateRecipeDefinition` did not require `id`, so the recipe linted
 * clean: 0 errors, 0 warnings.
 *
 * Observed live in the bridge log, not theorised:
 *
 *   WARN [recipe-triggers] skipped watch-failing-tests.yaml — id: missing or empty 'id'
 *
 * FIVE SHIPPED TEMPLATES were dead this way — ambient-journal,
 * fix-errors-on-save, lint-on-save, triage-failing-tests, watch-failing-tests.
 * All are fixed in the same change, because a rule that fails your own
 * templates is a rule you will turn off.
 *
 * SCOPE IS MEASURED, NOT ASSUMED. `id` is required by `parseRecipe`, which also
 * backs the installer — but 20 of 29 shipped templates omit it somewhere, and
 * cron/manual/webhook recipes run fine without it through the flat runner. A
 * global error would break most of the library to fix five files. So the rule
 * covers exactly the population that provably cannot work: recipes whose
 * trigger is an event type.
 *
 * Same drift as #1493 (`git_hook.event`), one field over, found in the same
 * log during the same reading. That is the fourth instance of a failure mode
 * this repository has named twice.
 */

import { describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";

const EVENT_TRIGGERS = [
  { type: "file_watch", patterns: ["**/*.ts"] },
  { type: "git_hook", event: "post-commit" },
  { type: "on_file_save", patterns: ["**/*.ts"] },
  { type: "on_test_run" },
];

const stepNoId = { tool: "file.read", path: "/dev/null" };
const stepWithId = { id: "s1", ...stepNoId };

const errorsFor = (trigger: unknown, steps: unknown[]) =>
  validateRecipeDefinition({ name: "probe", trigger, steps }).issues.filter(
    (i) => i.level === "error",
  );

describe("event-triggered recipes require a step id", () => {
  it("rejects a missing id under every event trigger", () => {
    for (const trigger of EVENT_TRIGGERS) {
      const errs = errorsFor(trigger, [stepNoId]);
      expect(errs.length, JSON.stringify(trigger.type)).toBeGreaterThan(0);
      expect(errs.map((e) => e.message).join(" ")).toMatch(
        /never registers|id/i,
      );
    }
  });

  it("accepts the same recipe once every step has an id", () => {
    for (const trigger of EVENT_TRIGGERS) {
      expect(errorsFor(trigger, [stepWithId]), trigger.type).toEqual([]);
    }
  });

  it("rejects an id that is present but empty", () => {
    expect(
      errorsFor(EVENT_TRIGGERS[0], [{ id: "   ", ...stepNoId }]).length,
    ).toBeGreaterThan(0);
  });

  it("flags the offending step so the author knows which one", () => {
    const errs = errorsFor(EVENT_TRIGGERS[0], [stepWithId, stepNoId]);
    expect(errs.map((e) => e.message).join(" ")).toMatch(/2/);
  });

  it("leaves cron, manual and webhook recipes alone", () => {
    // Load-bearing: 20 of 29 shipped templates omit `id` somewhere and run
    // fine, because the flat runner does not need it. A global rule would
    // break most of the library to fix five files.
    for (const trigger of [
      { type: "cron", at: "0 9 * * *" },
      { type: "manual" },
      { type: "webhook" },
    ]) {
      expect(errorsFor(trigger, [stepNoId]), trigger.type).toEqual([]);
    }
  });
});
