/**
 * The `unknown` bucket answers two opposite questions with one number.
 *
 * `open-recent` means the channel LOOKED and the errand is not finished yet —
 * wait. `not-observed` means the channel could not look at all — go and fix it.
 * Both are withheld by the fold, so both land in `unknown`, and a summary that
 * reports only the disposition leaves an operator unable to tell a healthy
 * young ledger from one that is seeing nothing.
 *
 * Measured on the real ledger before this was written: 8 of 9 rows `unknown`,
 * with no way from any shipped verb to find out which kind. The rows have
 * always carried `reason`; only the summary discarded it — the same defect as
 * #1469, where a defaulted-classification count named no recipe to go and fix.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ErrandObservation,
  formatShadowSummary,
  ingestErrandOutcomes,
} from "../outcomeIngester.js";
import { SHADOW_REASONS, summariseShadowLog } from "../outcomeShadowLog.js";

const NOW = 1_800_000_000_000;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "butler-reason-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * `stateObserved: true` is what separates the two. Without it the grader
 * returns `not-observed` even though it knows the age — age alone cannot tell
 * "the operator ignored this" from "nobody looked", and only the first is
 * evidence.
 */
const LOOKED_AND_STILL_OPEN: ErrandObservation = {
  ref: "t:in-flight",
  createdAt: NOW,
  stateObserved: true,
};
const NEVER_LOOKED: ErrandObservation = { ref: "t:blind" };

describe("summariseShadowLog attributes rows to a reason", () => {
  it("separates 'still in flight' from 'never observed' inside `unknown`", () => {
    ingestErrandOutcomes(
      [
        LOOKED_AND_STILL_OPEN,
        { ...NEVER_LOOKED, ref: "t:blind-1" },
        { ...NEVER_LOOKED, ref: "t:blind-2" },
      ],
      { now: NOW, dir },
    );

    const s = summariseShadowLog({ dir });

    // The old summary could say only this much — three rows, all withheld.
    expect(s.unknown).toBe(3);

    // The new field is what makes them actionable, and they are NOT equal.
    expect(s.byReason["open-recent"]).toBe(1);
    expect(s.byReason["not-observed"]).toBe(2);
  });

  it("reports the full reason space, not only reasons it happened to see", () => {
    ingestErrandOutcomes([{ ref: "t:done", completed: true }], {
      now: NOW,
      dir,
    });
    const s = summariseShadowLog({ dir });

    // A caller reading `byReason["not-observed"]` must get 0, never undefined —
    // otherwise every consumer has to defend against a missing key and one of
    // them will forget.
    for (const r of SHADOW_REASONS) {
      expect(s.byReason[r]).toBeTypeOf("number");
    }
    expect(s.byReason.completed).toBe(1);
    expect(s.byReason["not-observed"]).toBe(0);
  });

  it("returns a zeroed breakdown when no ledger exists", () => {
    const s = summariseShadowLog({ dir });
    expect(s.total).toBe(0);
    for (const r of SHADOW_REASONS) expect(s.byReason[r]).toBe(0);
  });

  // A "counts do not leak between calls" test was written here and REMOVED: it
  // passed with and without the defensive copy in `summariseShadowLog`, because
  // that function builds its zero value per call, so nothing is shared to leak.
  // It read like coverage of the aliasing hazard and proved nothing about it.
  // The reason the copy is kept anyway is recorded at the call site.
});

describe("formatShadowSummary makes the distinction visible", () => {
  it("splits the unknown line and warns when rows were never observed", () => {
    ingestErrandOutcomes(
      [
        LOOKED_AND_STILL_OPEN,
        { ...NEVER_LOOKED, ref: "t:blind-1" },
        { ...NEVER_LOOKED, ref: "t:blind-2" },
      ],
      { now: NOW, dir },
    );
    const out = formatShadowSummary(summariseShadowLog({ dir }));

    expect(out).toContain(
      "of which 1 still in flight, 2 could not be observed",
    );
    expect(out).toContain("by reason");
    expect(out).toContain("open-recent");
    expect(out).toContain("not-observed");

    // The warning has to say it is a broken PATH, not a verdict — an operator
    // who reads "2 unknown" as "2 inconclusive errands" draws the wrong
    // conclusion about their worker rather than about their plumbing.
    expect(out).toContain("never observed at all");
    expect(out).toMatch(/not a verdict about the errand/);
  });

  it("stays silent about observation failures when there are none", () => {
    ingestErrandOutcomes(
      [{ ref: "t:done", completed: true }, LOOKED_AND_STILL_OPEN],
      { now: NOW, dir },
    );
    const out = formatShadowSummary(summariseShadowLog({ dir }));

    expect(out).toContain(
      "of which 1 still in flight, 0 could not be observed",
    );
    // No alarm when nothing is wrong — a warning that always prints is ignored
    // by the time it matters.
    expect(out).not.toContain("never observed at all");
  });

  it("still leads with the denominator and the promotion bar", () => {
    ingestErrandOutcomes([{ ref: "t:done", completed: true }], {
      now: NOW,
      dir,
    });
    const out = formatShadowSummary(summariseShadowLog({ dir }));
    expect(out).toContain("1 graded row(s)");
    expect(out).toContain("would have become evidence");
    expect(out).toContain("These rows moved nothing");
  });
});
