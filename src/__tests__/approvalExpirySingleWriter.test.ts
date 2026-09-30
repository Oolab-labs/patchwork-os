/**
 * ADR-0018 — exactly ONE `decision` row per callId in `approval_log.jsonl`,
 * whichever process gets there first.
 *
 * Two bridges share one log. The owner arms a live expiry timer; a second
 * bridge constructed AFTER `expiresAt` but BEFORE the owner's timer fires
 * (timer lag, a blocked event loop) sees a request with no decision and a
 * passed deadline, and `restore()` records `expired`. The owner's timer then
 * recorded `expired` too. Two decision rows for one callId double-count in
 * every reader that joins on callId (the control plane's approval measures
 * count decision events).
 *
 * Deterministic: fake timers + a controlled clock hold the window open on
 * purpose rather than hoping for it. Asserts on the FILE.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../approvalQueue.js";
import { appendChained, verifyLedgerChain } from "../ledgerChain.js";

let dir: string;
const T0 = 1_900_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "approval-single-writer-"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function decisionsFor(callId: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(dir, "approval_log.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.kind === "decision" && r.callId === callId);
}

function requestOne(queue: ApprovalQueue) {
  return queue.request({
    tier: "low",
    toolName: "example.list_items",
    params: { limit: 50 },
    sessionId: "s1",
  });
}

describe("approval decision is written exactly once across processes", () => {
  it("observer restores AFTER the deadline but BEFORE the owner's timer fires", async () => {
    const owner = new ApprovalQueue({ ttlMs: 1000, persistDir: dir });
    const { callId, promise } = requestOne(owner);

    // Deadline passes; the owner's timer has NOT fired yet (lag).
    vi.setSystemTime(T0 + 5000);
    new ApprovalQueue({ persistDir: dir }); // restore records `expired`
    expect(decisionsFor(callId)).toHaveLength(1);

    vi.runOnlyPendingTimers(); // the owner's timer finally fires
    await expect(promise).resolves.toBe("expired");

    const rows = decisionsFor(callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("expired");
  });

  it("owner's timer fires first, then an observer restores: still one row", async () => {
    const owner = new ApprovalQueue({ ttlMs: 1000, persistDir: dir });
    const { callId, promise } = requestOne(owner);

    vi.setSystemTime(T0 + 5000);
    vi.runOnlyPendingTimers();
    await expect(promise).resolves.toBe("expired");

    const observer = new ApprovalQueue({ persistDir: dir });
    expect(observer.list()).toHaveLength(0);
    expect(decisionsFor(callId)).toHaveLength(1);
  });

  it("owner gone: the next restore records the expiry late, exactly once", () => {
    const owner = new ApprovalQueue({ ttlMs: 1000, persistDir: dir });
    const { callId } = requestOne(owner);
    // The owner process dies: its timer never fires and it writes nothing.
    vi.clearAllTimers();

    vi.setSystemTime(T0 + 5000);
    new ApprovalQueue({ persistDir: dir });
    new ApprovalQueue({ persistDir: dir });

    const rows = decisionsFor(callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("expired");
  });

  it("an approval stays the only row when restores follow it", async () => {
    const owner = new ApprovalQueue({ ttlMs: 1000, persistDir: dir });
    const { callId, promise } = requestOne(owner);
    // An observer restores while the request is still live (unowned entry).
    const observer = new ApprovalQueue({ persistDir: dir });
    expect(owner.approve(callId)).toBe(true);
    await expect(promise).resolves.toBe("approved");

    vi.setSystemTime(T0 + 5000);
    vi.runOnlyPendingTimers(); // observer's restored timer fires
    new ApprovalQueue({ persistDir: dir });
    expect(observer.list()).toHaveLength(0);

    const rows = decisionsFor(callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("approved");
  });
});

/**
 * The owner must ADOPT a decision another bridge already recorded. Keeping
 * only `expired` in the ledger while the owner's caller receives `approved`
 * would EXECUTE the gated action under a ledger that says it expired — less
 * truthful than the duplicate rows this file exists to prevent.
 */
describe("owner adopts a decision already recorded by another bridge", () => {
  for (const verb of ["approve", "reject"] as const) {
    it(`${verb} after an observer recorded expired: not applied, promise resolves expired`, async () => {
      const owner = new ApprovalQueue({ ttlMs: 1000, persistDir: dir });
      const { callId, promise } = requestOne(owner);
      vi.setSystemTime(T0 + 5000); // deadline passed, owner timer lagging
      new ApprovalQueue({ persistDir: dir }); // observer records `expired`

      expect(owner[verb](callId)).toBe(false);
      await expect(promise).resolves.toBe("expired");
      expect(owner.getRecentDecision(callId)).toBe("expired");
      expect(owner.list()).toHaveLength(0);

      const rows = decisionsFor(callId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.decision).toBe("expired");
    });
  }

  it("a log WRITE failure never blocks an approval (fail-soft)", async () => {
    const owner = new ApprovalQueue({ ttlMs: 1000, persistDir: dir });
    const { callId, promise } = requestOne(owner);
    // Make the ledger unwritable: replace the file with a directory.
    const file = path.join(dir, "approval_log.jsonl");
    rmSync(file, { force: true });
    mkdirSync(file);

    expect(owner.approve(callId)).toBe(true);
    await expect(promise).resolves.toBe("approved");
  });
});

describe("appendChained skipIf", () => {
  it("skips under the lock without touching the file or the chain", () => {
    const file = path.join(dir, "x.jsonl");
    appendChained(file, { kind: "decision", callId: "c1" });
    const before = readFileSync(file, "utf8");
    const res = appendChained(
      file,
      { kind: "decision", callId: "c1" },
      { skipIf: (lines) => lines.some((l) => l.includes('"c1"')) },
    );
    expect(res).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(verifyLedgerChain(file).ok).toBe(true);
  });
});
