/**
 * You cannot look before you leap.
 *
 * `formatShadowSummary` ends by telling the operator, in its own words, to
 * "check a sample against the real errands they describe — a disposition that
 * reads plausibly in aggregate can still be wrong on every individual row".
 *
 * There was no way to do that. `patchwork butler shadow` printed the aggregate
 * and `--json` printed the same aggregate as JSON. The row readers existed and
 * were exported — and `readShadowRows` had exactly ONE caller in the tree:
 * `promoteShadowOutcomes`, the irreversible step. The only code that read the
 * individual rows was the one that acts on them.
 *
 * That matters more here than it would elsewhere because promotion is one-way:
 * trust replay absorbs a folded row into a checkpoint that deleting the row
 * does not undo. "Review before promoting" is the whole safety property of the
 * shadow phase, and it was advice with no surface behind it.
 *
 * These tests pin the review surface, not the wording.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { formatShadowRows } from "../outcomeIngester.js";
import type { ShadowOutcomeRow } from "../outcomeShadowLog.js";

function row(over: Partial<ShadowOutcomeRow> = {}): ShadowOutcomeRow {
  return {
    ref: "example.create_task:abc-1",
    disposition: "unknown",
    reason: "open-recent",
    gradedAt: Date.UTC(2026, 7, 20, 9, 0, 0),
    recipe: "example-errand",
    wouldCountAsEvidence: false,
    ...over,
  };
}

describe("formatShadowRows", () => {
  it("says so plainly when there is nothing to review", () => {
    const out = formatShadowRows([]);
    expect(out).toMatch(/no graded rows/i);
  });

  it("leads with the rows that would actually move the dial", () => {
    // 1 consequential row buried behind 3 withheld ones is the real ledger's
    // shape (8 of 9 withheld when this was written). A reviewer opening this
    // is deciding whether to promote, so the rows promotion would ACT on have
    // to be the ones they see first — not sorted under a wall of `unknown`.
    const rows = [
      row({ ref: "example.create_task:w-1" }),
      row({ ref: "example.create_task:w-2" }),
      row({
        ref: "example.create_task:real-1",
        disposition: "confirmed",
        reason: "completed",
        wouldCountAsEvidence: true,
      }),
      row({ ref: "example.create_task:w-3" }),
    ];
    const out = formatShadowRows(rows);
    const idxEvidence = out.indexOf("real-1");
    const idxWithheld = out.indexOf("w-1");
    expect(idxEvidence).toBeGreaterThan(-1);
    expect(idxWithheld).toBeGreaterThan(-1);
    expect(idxEvidence).toBeLessThan(idxWithheld);
  });

  it("marks which rows would become evidence, since that is the decision", () => {
    const out = formatShadowRows([
      row({
        ref: "example.create_task:real-1",
        disposition: "confirmed",
        reason: "completed",
        wouldCountAsEvidence: true,
      }),
      row({ ref: "example.create_task:w-1" }),
    ]);
    // The distinction is carried in WORDS, not only by ordering or colour — a
    // reviewer piping this to a file must still be able to tell them apart.
    expect(out).toMatch(/would become evidence/i);
    expect(out).toMatch(/withheld/i);
  });

  it("honours a limit and says what it did not show", () => {
    // A silent truncation reads as "that was all of them", which is exactly the
    // wrong impression to give someone deciding whether a sample is
    // representative.
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ ref: `example.create_task:r-${i}` }),
    );
    const out = formatShadowRows(rows, { limit: 3 });
    expect(out).toMatch(/r-0/);
    expect(out).not.toMatch(/r-9/);
    expect(out).toMatch(/7 more|not shown/i);
  });

  it("warns that the output is operator data", () => {
    // Same rule as `runstore compare` and `privacy receipts`: these rows name
    // real installed recipes and carry external record ids for the operator's
    // own errands. A measurement may be quoted; the rows may not leave the
    // machine.
    const out = formatShadowRows([row()]);
    expect(out).toMatch(/never paste|do not paste|operator data/i);
  });

  it("renders a row with no recipe without inventing one", () => {
    // `recipe` is optional on the row. Printing a placeholder that looks like a
    // recipe name would attribute an errand to something that did not file it.
    const out = formatShadowRows([row({ recipe: undefined })]);
    expect(out).toMatch(/example\.create_task:abc-1/);
    expect(out).not.toMatch(/undefined/);
  });
});

/**
 * The tests above prove the RULE. This proves it is actually WIRED.
 *
 * Demonstrated by mutation while writing it: replacing the `--rows` lookup in
 * `index.ts` with `-1` makes the flag fall silently back to the summary — the
 * exact pre-existing behaviour — and all six unit tests above still pass. A
 * formatter nobody can reach is the same as no formatter.
 */
describe("butler shadow --rows is reachable from the CLI", () => {
  const distIndex = path.resolve(
    import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
    "../../../dist/index.js",
  );

  function runCli(args: string[], home: string): string {
    const r = spawnSync(process.execPath, [distIndex, "butler", ...args], {
      encoding: "utf8",
      // An ISOLATED home. The real ledger holds the operator's actual errands,
      // and a test that read it would put real task refs into CI output.
      env: { ...process.env, PATCHWORK_HOME: home },
    });
    return `${r.stdout}${r.stderr}`;
  }

  it("prints rows rather than the aggregate", () => {
    if (!existsSync(distIndex)) {
      throw new Error("dist/index.js not found — run npm run build first");
    }
    const home = mkdtempSync(path.join(os.tmpdir(), "butler-rows-"));
    try {
      writeFileSync(
        path.join(home, "butler_outcome_shadow.jsonl"),
        `${JSON.stringify({
          ref: "example.create_task:synthetic-1",
          disposition: "confirmed",
          reason: "completed",
          gradedAt: Date.UTC(2026, 7, 20),
          recipe: "synthetic-errand",
          wouldCountAsEvidence: true,
        })}\n`,
      );

      const rows = runCli(["shadow", "--rows"], home);
      // The row itself, which the summary never prints.
      expect(rows).toContain("example.create_task:synthetic-1");
      expect(rows).toMatch(/would become evidence/i);

      // And the summary is untouched by the new flag.
      const summary = runCli(["shadow"], home);
      expect(summary).not.toContain("example.create_task:synthetic-1");
      expect(summary).toMatch(/graded row/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
