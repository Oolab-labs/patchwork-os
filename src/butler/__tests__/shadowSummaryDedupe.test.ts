/**
 * The shadow summary must count ERRANDS, not observations of them.
 *
 * The ledger is append-only and an errand is observed repeatedly — that is the
 * design, and `promoteShadowOutcomes` states it plainly: "Last grade wins per
 * ref. The ledger is append-only and an errand is observed repeatedly, so the
 * same ref legitimately appears many times."
 *
 * The summary did not apply that rule. It counted every row, so one errand
 * observed five times contributed five to the totals. On the reference machine
 * that produced "17 graded rows: confirmed 3 (17.6%)" over FOUR errands of
 * which ONE was confirmed — the true figure being 25%.
 *
 * Two things make this worse than a cosmetic miscount:
 *
 *   - It drifts. Every observation pushes the reported percentages further
 *     from the truth, so scheduling observation — the obvious next step, and
 *     the reason this was found — degrades the number steadily.
 *   - The summary is what a person reads before deciding to promote, and
 *     promotion is one-way. This module's own doc comment names the hazard:
 *     "Two readers of one append-only file with two copies of 'what counts as
 *     a row' is how a report and the thing it reports on come to disagree."
 *
 * So the summary now folds by ref with last-grade-wins — the same rule the
 * promoter uses, deliberately, so the report and the action cannot diverge.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summariseShadowLog } from "../outcomeShadowLog.js";

let dir: string;

function write(rows: Array<Record<string, unknown>>) {
  const p = path.join(dir, "butler_outcome_shadow.jsonl");
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const row = (
  ref: string,
  disposition: string,
  gradedAt: number,
  reason = "open-recent",
) => ({
  ref,
  disposition,
  reason,
  gradedAt,
  recipe: "example-recipe",
  wouldCountAsEvidence: disposition === "confirmed",
});

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "butler-shadow-"));
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("summary folds by errand", () => {
  it("counts one errand once however many times it was observed", () => {
    write([
      row("tool:a", "unknown", 1),
      row("tool:a", "unknown", 2),
      row("tool:a", "confirmed", 3, "completed"),
    ]);
    const s = summariseShadowLog({ dir });
    expect(s.total).toBe(1);
    expect(s.confirmed).toBe(1);
    expect(s.unknown).toBe(0);
  });

  it("takes the LATEST grade, not the first", () => {
    // An errand starts unknown and later completes. Reporting it as unknown
    // because that grade came first would hide every completion.
    write([
      row("tool:a", "confirmed", 5, "completed"),
      row("tool:a", "unknown", 1),
    ]);
    const s = summariseShadowLog({ dir });
    expect(s.confirmed).toBe(1);
    expect(s.unknown).toBe(0);
  });

  it("reproduces the live case: 4 errands, not 17 rows", () => {
    const rows = [];
    for (let i = 0; i < 4; i++) {
      for (let obs = 0; obs < 4; obs++) {
        rows.push(row(`tool:${i}`, "unknown", obs));
      }
    }
    rows.push(row("tool:0", "confirmed", 99, "completed"));
    write(rows);
    const s = summariseShadowLog({ dir });
    expect(s.total).toBe(4);
    expect(s.confirmed).toBe(1);
    expect(s.unknown).toBe(3);
    // The figure a person acts on: 1 of 4, not 5 of 17.
    expect(s.wouldCount).toBe(1);
  });

  it("keeps distinct errands distinct", () => {
    write([
      row("tool:a", "confirmed", 1, "completed"),
      row("tool:b", "junk", 1, "stale"),
      row("tool:c", "unknown", 1),
    ]);
    const s = summariseShadowLog({ dir });
    expect(s.total).toBe(3);
    expect(s.confirmed).toBe(1);
    expect(s.junk).toBe(1);
    expect(s.unknown).toBe(1);
  });

  it("attributes byReason from the surviving grade only", () => {
    write([
      row("tool:a", "unknown", 1, "open-recent"),
      row("tool:a", "confirmed", 2, "completed"),
    ]);
    const s = summariseShadowLog({ dir });
    expect(s.byReason.completed).toBe(1);
    expect(s.byReason["open-recent"]).toBe(0);
  });
});
