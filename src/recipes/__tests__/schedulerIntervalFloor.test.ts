/**
 * An `@every` interval below one second is refused (Private/52 LOW).
 *
 * `@every 1ms` parsed, linted clean and registered a setInterval that fired a
 * whole recipe run every millisecond. One second is the finest schedule a cron
 * expression can express (the six-field form), so it is the floor here too:
 * the interval form must not reach somewhere cron cannot.
 */

import { describe, expect, it } from "vitest";
import { parseSchedule } from "../scheduler.js";
import { validateRecipeDefinition } from "../validation.js";

function lintErrors(at: string): string[] {
  return validateRecipeDefinition({
    name: "interval-floor",
    trigger: { type: "cron", at },
    steps: [{ id: "s", tool: "file.read", path: "x" }],
  })
    .issues.filter((i) => i.level === "error")
    .map((i) => i.message);
}

describe("@every floor", () => {
  for (const at of ["@every 1ms", "@every 999ms", "@every 500 ms"]) {
    it(`${at}: the scheduler does not register it`, () => {
      expect(parseSchedule(at)).toBeNull();
    });
    it(`${at}: lint reports it`, () => {
      expect(lintErrors(at).some((m) => m.includes(at))).toBe(true);
    });
  }

  for (const [at, ms] of [
    ["@every 1000ms", 1000],
    ["@every 1s", 1000],
    ["@every 5m", 300_000],
  ] as const) {
    it(`${at} is still accepted`, () => {
      expect(parseSchedule(at)).toEqual({ kind: "interval", intervalMs: ms });
      expect(lintErrors(at)).toEqual([]);
    });
  }
});
