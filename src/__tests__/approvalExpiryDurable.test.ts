/**
 * ADR-0018 — an approval that EXPIRES must reach the durable log.
 *
 * `ApprovalQueue` has two expiry paths, and only one of them persisted.
 *
 * The restore-time path (`restore()`) resolves an entry whose `expiresAt`
 * passed while the process was down, and records the decision. The LIVE path
 * — the `setTimeout` armed in `request()` — did its own inline teardown:
 * delete the entry, resolve `"expired"`, notify. It never called
 * `persistence.recordDecision`, because it never went through `resolveEntry`,
 * which is where every other resolution (`approve` / `reject` / `cancel`)
 * writes its row.
 *
 * The consequence is not a missing nicety. `approval_log.jsonl` is the durable
 * event source, and a `request` row with no `decision` row is exactly how the
 * log spells "still pending". So an approval that timed out on a running
 * bridge was indistinguishable, forever, from one still waiting for a human —
 * and the control plane's measures counted it as undecided. It self-healed
 * only on restart, which on a long-lived bridge is indefinitely.
 *
 * Observed live on 2026-08-26: a low-tier approval expired, `patchwork
 * approve` correctly reported it not pending, and the log still carried the
 * bare `request`.
 *
 * These tests assert on the FILE. Asserting on the resolved promise would
 * pass against the broken version — the promise always resolved `"expired"`;
 * it was only the durable write that was missing.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalQueue } from "../approvalQueue.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "approval-expiry-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readEvents(): Array<Record<string, unknown>> {
  const file = path.join(dir, "approval_log.jsonl");
  return (
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      // ADR-0027 marker rows (`chain-start`, `rotation`) live in the same
      // file and carry `kind` and no data fields; skipped the way every
      // production loader skips them.
      .filter((r) => r.kind !== "chain-start" && r.kind !== "rotation")
  );
}

function requestOne(queue: ApprovalQueue) {
  return queue.request({
    tier: "low",
    toolName: "example.list_items",
    params: { limit: 50 },
    sessionId: "s1",
  });
}

describe("approval expiry reaches the durable log", () => {
  it("writes a decision row when the LIVE timer fires", async () => {
    const queue = new ApprovalQueue({ ttlMs: 20, persistDir: dir });
    const { callId, promise } = requestOne(queue);

    await expect(promise).resolves.toBe("expired");

    const events = readEvents();
    const decision = events.find(
      (e) => e.kind === "decision" && e.callId === callId,
    );
    expect(decision, "expiry wrote no decision row").toBeDefined();
    expect(decision?.decision).toBe("expired");
  });

  it("leaves no callId carrying a request with no decision", async () => {
    const queue = new ApprovalQueue({ ttlMs: 20, persistDir: dir });
    const { promise } = requestOne(queue);
    await promise;

    const events = readEvents();
    const requested = new Set(
      events.filter((e) => e.kind === "request").map((e) => e.callId),
    );
    const decided = new Set(
      events.filter((e) => e.kind === "decision").map((e) => e.callId),
    );
    const unresolved = [...requested].filter((c) => !decided.has(c));
    expect(unresolved, "a resolved call still reads as pending").toEqual([]);
  });
  it("records exactly one decision when a second queue shares the log", async () => {
    // Two bridges over one ~/.patchwork is a real deployment, not a
    // contrivance. The owner's live timer and the non-owner's restored timer
    // both fire; only the owner may write, or readers that join on callId
    // see the same expiry twice.
    const owner = new ApprovalQueue({ ttlMs: 60, persistDir: dir });
    const { callId, promise } = requestOne(owner);

    const observer = new ApprovalQueue({ persistDir: dir });
    expect(observer.list()).toHaveLength(1);
    expect(observer.list()[0]?.owned).toBe(false);

    await promise;
    await new Promise((r) => setTimeout(r, 40));

    const decisions = readEvents().filter(
      (e) => e.kind === "decision" && e.callId === callId,
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe("expired");
  });
});
