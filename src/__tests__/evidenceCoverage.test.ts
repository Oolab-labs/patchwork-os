/**
 * `patchwork evidence` reports the DENOMINATORS of the evidence spine.
 *
 * CLAUDE.md tells the next session to re-measure join coverage before scoping a
 * cross-ledger reader, and records that its own figures went stale within two
 * days. That measurement was a bespoke throwaway script every time.
 *
 * The two properties that matter here are not the arithmetic:
 *
 *  1. **Absent is not zero.** A ledger that does not exist is a different fact
 *     from one with no rows — `butler/permission_exercises.jsonl` is absent
 *     because no standing permission has ever been granted, and that absence is
 *     CORRECT rather than a gap to plumb. Rendering it as `0 rows` invites
 *     someone to go and "fix" it.
 *  2. **Counts only, never contents.** A `correlationId` IS a run's `taskId`,
 *     and these ledgers hold real task titles, captured output and third-party
 *     record ids. A measurement may leave the machine; the rows may not.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evidenceCoverage,
  formatEvidenceCoverage,
} from "../evidenceCoverage.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-evidence-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(file: string, rows: Array<Record<string, unknown>>) {
  const full = path.join(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

const cov = () => evidenceCoverage(dir);
const led = (key: string) =>
  cov().ledgers.find((l) => l.key === key) as NonNullable<
    ReturnType<typeof cov>["ledgers"][number]
  >;

describe("absent is not zero", () => {
  it("marks a missing ledger absent rather than empty", () => {
    const l = led("gate decisions");
    expect(l.absent).toBe(true);
    expect(l.rows).toBe(0);
    expect(formatEvidenceCoverage(cov())).toContain("ABSENT");
  });

  it("an EMPTY-but-present ledger is not absent", () => {
    writeFileSync(path.join(dir, "worker_gate_decisions.jsonl"), "");
    const l = led("gate decisions");
    expect(l.absent).toBe(false);
    expect(l.rows).toBe(0);
  });
});

describe("counting", () => {
  it("counts joinable rows against the full denominator", () => {
    write("worker_gate_decisions.jsonl", [
      { rv: 1, correlationId: "run-a" },
      { rv: 1, correlationId: "run-a" },
      {}, // pre-sentinel row, legitimately has none
      {},
    ]);
    const l = led("gate decisions");
    expect(l.rows).toBe(4);
    expect(l.joinable).toBe(2);
    expect(l.distinctRuns).toBe(1);
  });

  it("reports unparseable lines instead of silently skipping them", () => {
    writeFileSync(
      path.join(dir, "outcome-log.jsonl"),
      '{"correlationId":"r1"}\nnot json at all\n',
    );
    const l = led("outcomes");
    expect(l.rows).toBe(1);
    expect(l.corrupt).toBe(1);
  });

  it("ignores an empty-string correlationId — present but useless", () => {
    write("boundary_receipts.jsonl", [
      { correlationId: "" },
      { correlationId: "r" },
    ]);
    expect(led("boundary receipts").joinable).toBe(1);
  });
});

describe("the join is the point", () => {
  it("reports 0 shared runs when two ledgers describe different runs", () => {
    write("worker_gate_decisions.jsonl", [{ correlationId: "run-a" }]);
    write("boundary_receipts.jsonl", [{ correlationId: "run-b" }]);
    const c = cov();
    expect(c.runsInMoreThanOneLedger).toBe(0);
    expect(c.pairs).toContainEqual({
      a: "gate decisions",
      b: "boundary receipts",
      shared: 0,
    });
  });

  it("counts a run reachable in two ledgers", () => {
    write("worker_gate_decisions.jsonl", [{ correlationId: "run-a" }]);
    write("boundary_receipts.jsonl", [
      { correlationId: "run-a" },
      { correlationId: "run-b" },
    ]);
    const c = cov();
    expect(c.runsInMoreThanOneLedger).toBe(1);
    expect(c.pairs[0]?.shared).toBe(1);
  });

  it("says nothing can be joined when only one ledger carries ids", () => {
    write("worker_gate_decisions.jsonl", [{ correlationId: "run-a" }]);
    const out = formatEvidenceCoverage(cov());
    expect(out).toContain("No two ledgers both carry run ids");
  });
});

describe("it prints counts, never contents", () => {
  /**
   * The guard that matters. A correlationId is a taskId, and these rows carry
   * real task titles and third-party record ids — so the renderer must not be
   * able to leak one even by accident.
   */
  it("never renders an id or any row value", () => {
    write("worker_gate_decisions.jsonl", [
      {
        correlationId: "SECRET-RUN-ID",
        taskTitle: "SECRET-TASK-TITLE",
        issueUrl: "https://example.test/SECRET-URL",
      },
    ]);
    const out = formatEvidenceCoverage(cov());
    expect(out).not.toContain("SECRET-RUN-ID");
    expect(out).not.toContain("SECRET-TASK-TITLE");
    expect(out).not.toContain("SECRET-URL");
    // ...while still reporting the measurement.
    expect(out).toContain("1 of 1");
  });

  it("leads with the denominator rather than a bare joinable count", () => {
    write("boundary_receipts.jsonl", [{ correlationId: "r" }, {}, {}]);
    expect(formatEvidenceCoverage(cov())).toMatch(
      /1 of 3\s+rows carry a run id/,
    );
  });
});
