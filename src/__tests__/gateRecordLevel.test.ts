/**
 * The correlation sentinel.
 *
 * A gate decision now carries `rv` (the writer's record level) and
 * `correlationId` (the run's `taskId`). The sentinel is the ABSENCE of `rv`:
 * a row without it makes no claim, and nothing may be inferred from which
 * optional fields it lacks.
 *
 * That absence is the one thing here that cannot be repaired later — there is
 * no backfill, and defaulting it on read (`parsed.rv ?? 0`) would be a backfill
 * performed invisibly on every load. So these assertions are about a property
 * that has exactly one chance to be right.
 *
 * Everything goes through the REAL writer to REAL disk and is read back by a
 * FRESH instance. Asserting on `record()`'s return value would pass with the
 * fields missing from the file entirely — which is not hypothetical: a
 * `workspaceId` that `record()` accepted and never persisted is exactly the bug
 * this shape of test would have caught the day it shipped.
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  correlationOf,
  GATE_RECORD_VERSION,
  type RecordGateDecisionInput,
  WorkerGateDecisionLog,
} from "../workerGateDecisionLog.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gate-rv-"));
  file = join(dir, "worker_gate_decisions.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base: RecordGateDecisionInput = {
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
  reason: "earned",
  gatePolicyVersion: "worker-ramp-v1",
};

/** A row `record()` can never produce again — the never-backfill fixture. */
const LEGACY = JSON.stringify({
  seq: 1,
  decidedAt: 1_756_000_000_000,
  recipeName: "example-recipe",
  workerId: "w1",
  toolName: "t1",
  action: "allow",
  classKey: "issue:reversible:low",
  domain: "issue",
  owned: true,
  blastTier: "low",
  reversibility: "reversible",
  earnedLevel: 0,
  autonomyCeiling: 4,
  effectiveLevel: 0,
  reason: "r",
  gatePolicyVersion: "worker-ramp-v0",
});

function lines(): string[] {
  return (
    readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      // ADR-0027 marker rows share the file and are not decision records.
      .filter((l) => !/"kind":"(chain-start|rotation)"/.test(l))
  );
}

describe("the record level reaches disk", () => {
  it("stamps rv and correlationId on a new row", () => {
    const log = new WorkerGateDecisionLog({ dir });
    log.record({ ...base, correlationId: "yaml:example-recipe:1756100000000" });
    const row = JSON.parse(lines()[0] as string);
    expect(row.rv).toBe(GATE_RECORD_VERSION);
    expect(row.correlationId).toBe("yaml:example-recipe:1756100000000");
  });

  it("survives a fresh read, not just the writing instance's memory", () => {
    const w = new WorkerGateDecisionLog({ dir });
    w.record({ ...base, correlationId: "yaml:example-recipe:1756100000000" });
    const rows = new WorkerGateDecisionLog({ dir }).query({ limit: 10 });
    expect(rows[0]?.rv).toBe(GATE_RECORD_VERSION);
    expect(rows[0]?.correlationId).toBe("yaml:example-recipe:1756100000000");
  });
});

describe("a pre-sentinel row is left exactly as it was", () => {
  it("is byte-identical after a later write, and gains no rv", () => {
    appendFileSync(file, `${LEGACY}\n`);
    new WorkerGateDecisionLog({ dir }).record({
      ...base,
      correlationId: "yaml:example-recipe:1756100000000",
    });
    expect(lines()[0]).toBe(LEGACY);
    expect(Object.hasOwn(JSON.parse(lines()[0] as string), "rv")).toBe(false);
  });

  it("still has no rv after a round trip through the reader", () => {
    // Fails on `parsed.rv ?? 0` — a default applied on load is a backfill that
    // never appears in the file, so it is invisible to the assertion above.
    appendFileSync(file, `${LEGACY}\n`);
    const row = new WorkerGateDecisionLog({ dir })
      .query({ limit: 10 })
      .find((r) => r.seq === 1);
    expect(row).toBeDefined();
    expect(Object.hasOwn(row as object, "rv")).toBe(false);
  });
});

describe("correlationOf keeps the absences apart", () => {
  it("reports a levelless row as making no claim", () => {
    expect(correlationOf({})).toEqual({ state: "unclaimed" });
  });

  it("reports a levelled row with no run as a DEFECT, never as 'no run'", () => {
    // The state that must not exist. Every gate decision happens inside a run,
    // so a row claiming otherwise would be false rather than informative.
    expect(correlationOf({ rv: 1 })).toEqual({ state: "defect", rv: 1 });
  });

  it("links a row that names its run", () => {
    expect(correlationOf({ rv: 1, correlationId: "yaml:r:1" })).toEqual({
      state: "linked",
      taskId: "yaml:r:1",
    });
  });

  it("does not claim to have verified a run it never looked for", () => {
    // Without a `runExists` probe the answer is "linked", not "unresolved":
    // "we did not look" must not be reported as "we looked and found nothing".
    expect(correlationOf({ rv: 1, correlationId: "gone" }).state).toBe(
      "linked",
    );
    expect(
      correlationOf({ rv: 1, correlationId: "gone" }, () => false),
    ).toEqual({ state: "unresolved", taskId: "gone" });
  });
});

describe("every writer-stamped field actually reaches disk", () => {
  /**
   * A census, not a spot check. `record()` builds its row as an explicit
   * literal rather than spreading `input` — deliberate, so an unvetted caller
   * field cannot reach disk, but it means a NEW field is silently dropped until
   * someone remembers to add a line.
   *
   * `workspaceId` was dropped that way for its entire life: the orchestrator
   * stamps it on every decision and the literal never copied it, so 0 of 272
   * rows in the live ledger carry one. This test, written when that field
   * shipped, would have caught it the same day.
   */
  it("persists every field the caller supplied", () => {
    const log = new WorkerGateDecisionLog({ dir });
    log.record({
      ...base,
      correlationId: "yaml:example-recipe:1756100000000",
      workspaceId: "ws-abc123",
    });
    const row = JSON.parse(lines()[0] as string);
    for (const [k, v] of Object.entries({
      correlationId: "yaml:example-recipe:1756100000000",
      workspaceId: "ws-abc123",
      rv: GATE_RECORD_VERSION,
    })) {
      expect(row, `field "${k}" did not reach disk`).toHaveProperty(k, v);
    }
  });
});

describe("the level is the writer's claim, not the caller's", () => {
  it("ignores an rv a caller tries to supply", () => {
    const log = new WorkerGateDecisionLog({ dir });
    // `rv` is excluded from RecordGateDecisionInput, so this is a type error in
    // real code; the cast proves the writer still wins at runtime.
    log.record({ ...base, rv: 99 } as unknown as RecordGateDecisionInput);
    expect(JSON.parse(lines()[0] as string).rv).toBe(GATE_RECORD_VERSION);
  });
});
