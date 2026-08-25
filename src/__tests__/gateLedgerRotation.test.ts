/**
 * Rotation destroyed half the ledger to reclaim one byte, and said nothing.
 *
 *   while (joined.length + 1 > MAX_PERSIST_BYTES && lines.length > 1) {
 *     lines = lines.slice(-Math.max(1, Math.floor(lines.length / 2)));
 *     joined = lines.join("\n");
 *   }
 *
 * Crossing the cap by a single row halves the file. This ledger is the autonomy
 * gate's trust evidence and its audit trail, so that is 50% of both, discarded
 * oldest-first, with no record that it happened.
 *
 * The silence is the worse half. Rotation deletes oldest-first, which is
 * precisely the population of rows lacking any newer field — so any coverage
 * measure over this file converges toward 1.0 BY DELETION. A report that says
 * "98% of decisions carry a run id" would be describing a ledger that ate the
 * counter-examples, and would say so in exactly the same words as a genuine
 * improvement.
 *
 * Two separate defects, and this file pins both: how much is dropped, and
 * whether anyone is told.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PERSIST_BYTES,
  type RecordGateDecisionInput,
  WorkerGateDecisionLog,
} from "../workerGateDecisionLog.js";

let dir: string;
let warnings: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gate-rot-"));
  warnings = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A row whose `reason` is padded so few records fill the cap quickly. */
function bigRow(n: number): RecordGateDecisionInput {
  return {
    recipeName: "example-recipe",
    workerId: "w1",
    toolName: "githubCreateIssue",
    action: "allow",
    classKey: "issue:compensable:low",
    domain: "issue",
    owned: true,
    blastTier: "low",
    reversibility: "compensable",
    earnedLevel: 4,
    autonomyCeiling: 4,
    effectiveLevel: 4,
    reason: `r${n}`.padEnd(900, "x"),
    gatePolicyVersion: "worker-ramp-v1",
  };
}

/**
 * Fill until rotation actually fires, detected by the file SHRINKING — not by
 * guessing at a size threshold, which is how the first draft of this helper
 * stopped before the cap was ever reached and reported a false reproduction.
 */
function fillPastCap(log: WorkerGateDecisionLog): number {
  const file = join(dir, "worker_gate_decisions.jsonl");
  let n = 0;
  let peak = 0;
  for (let i = 0; i < 8000; i++) {
    log.record(bigRow(i));
    n++;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      /* not yet written */
    }
    if (size > peak) {
      peak = size;
    } else if (peak > MAX_PERSIST_BYTES * 0.9 && size < peak) {
      return n; // the file got smaller: rotation ran
    }
  }
  throw new Error(`rotation never fired after ${n} rows (peak ${peak} bytes)`);
}

function rowsOnDisk(): number {
  return readFileSync(join(dir, "worker_gate_decisions.jsonl"), "utf-8")
    .split("\n")
    .filter((l) => l.trim()).length;
}

describe("rotation keeps what it can and reports what it dropped", () => {
  it("does not discard roughly half the ledger in one step", () => {
    const log = new WorkerGateDecisionLog({
      dir,
      logger: { warn: (m: string) => warnings.push(m) },
    });
    fillPastCap(log);
    const after = readFileSync(
      join(dir, "worker_gate_decisions.jsonl"),
      "utf-8",
    );
    // Trim-to-target leaves the file near its low-water mark. Halving left it
    // at ~50% of the cap (measured: 525,829 bytes), which is the tell.
    expect(after.length).toBeGreaterThan(MAX_PERSIST_BYTES * 0.8);
    // Never above the cap: `append` rotates BEFORE writing, so the post-rotate
    // file is target + one row, comfortably inside.
    expect(after.length).toBeLessThanOrEqual(MAX_PERSIST_BYTES);
  });

  it("does not rotate on every append once the file is full", () => {
    // Hysteresis. Trimming to exactly the cap makes `append` rotate on every
    // subsequent write — one row dropped and one warning emitted each time.
    // Measured while building this fix: 826 rotations in a single fill. A
    // warning that fires on every write is one nobody reads.
    const log = new WorkerGateDecisionLog({
      dir,
      logger: { warn: (m: string) => warnings.push(m) },
    });
    fillPastCap(log);
    const drops = warnings.filter((w) => /dropped/i.test(w));
    expect(drops.length).toBeLessThanOrEqual(2);
  });

  it("says how many rows it dropped", () => {
    const log = new WorkerGateDecisionLog({
      dir,
      logger: { warn: (m: string) => warnings.push(m) },
    });
    fillPastCap(log);
    const dropMsg = warnings.find((w) => /dropped/i.test(w));
    expect(dropMsg).toBeDefined();
    // A bare "rotated" is not enough — the count is the point, because any
    // coverage denominator computed over this file is wrong without it.
    expect(dropMsg).toMatch(/\d+/);
  });

  it("keeps the NEWEST rows, never the oldest", () => {
    const log = new WorkerGateDecisionLog({
      dir,
      logger: { warn: (m: string) => warnings.push(m) },
    });
    const n = fillPastCap(log);
    const rows = readFileSync(join(dir, "worker_gate_decisions.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { seq: number });
    expect(rows.at(-1)?.seq).toBe(n);
    expect(rowsOnDisk()).toBeLessThan(n);
  });
});
