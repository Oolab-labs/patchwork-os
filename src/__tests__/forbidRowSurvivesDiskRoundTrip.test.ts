/**
 * A `forbid` decision was written to disk correctly and then discarded by every
 * reader.
 *
 * `record()` validates and accepts all three actions (`:219-225`). But
 * `consumeRawJsonl` — the loader every fresh instance runs — rejected the row:
 *
 *   if (… || (parsed.action !== "allow" && parsed.action !== "gate")) continue;
 *
 * So a `forbid` survived only in the writing process's in-memory ring and
 * vanished at the next restart. `gate explain`, `GET /gate/decisions` and the
 * dashboard pane all read through this loader, which means ADR-0017's terminal
 * state — the one whose entire purpose is to be visible and unappealable — was
 * invisible in every surface an operator has.
 *
 * The live ledger holds 0 `forbid` rows (272 rows: 225 allow / 47 gate), so
 * nothing observable is being recovered here. That is not reassurance: forbid
 * rules are opt-in via `forbidPolicy`, so the first operator to write one would
 * have got silence, and silence from a deny-list reads as "nothing was
 * forbidden".
 *
 * The round trip goes through REAL DISK and a FRESH INSTANCE deliberately.
 * Asserting on `record()`'s return value, or on the same instance's `query()`,
 * passes with the bug fully present — the row is in memory either way.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RecordGateDecisionInput,
  WorkerGateDecisionLog,
} from "../workerGateDecisionLog.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gate-forbid-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base: Omit<RecordGateDecisionInput, "action"> = {
  recipeName: "example-recipe",
  workerId: "w1",
  toolName: "githubCreateIssue",
  classKey: "issue:irreversible:high",
  domain: "issue",
  owned: true,
  blastTier: "high",
  reversibility: "irreversible",
  earnedLevel: 0,
  autonomyCeiling: 4,
  effectiveLevel: 0,
  reason: "forbidden by workspace policy",
  gatePolicyVersion: "worker-ramp-v1",
};

describe("a forbid row survives a disk round trip", () => {
  it("is still there when a fresh instance reads the file", () => {
    const w = new WorkerGateDecisionLog({ dir });
    w.record({ ...base, action: "forbid" });
    w.record({ ...base, action: "allow" });

    // Fresh instance = the loader path. This is the assertion that failed.
    const rows = new WorkerGateDecisionLog({ dir }).query({ limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.action).sort()).toEqual(["allow", "forbid"]);
  });

  it("the SAME instance always saw it — which is why this went unnoticed", () => {
    // Control. Proves the test above fails for a read reason and not a write
    // one, and pins why an in-memory assertion would have been useless.
    const w = new WorkerGateDecisionLog({ dir });
    w.record({ ...base, action: "forbid" });
    expect(w.query({ limit: 10 })).toHaveLength(1);
  });

  it("still rejects a row whose action is genuinely unrecognised", () => {
    // The loader's validation must narrow, not vanish. A row with a nonsense
    // action is malformed and should still be skipped.
    const w = new WorkerGateDecisionLog({ dir });
    w.record({ ...base, action: "allow" });
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(
      join(dir, "worker_gate_decisions.jsonl"),
      `${JSON.stringify({
        seq: 99,
        decidedAt: 1_756_000_000_000,
        workerId: "w1",
        toolName: "t",
        action: "sideways",
      })}\n`,
    );
    const rows = new WorkerGateDecisionLog({ dir }).query({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("allow");
  });
});
