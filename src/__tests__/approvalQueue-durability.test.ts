/**
 * ADR-0018 — "persist the request, not the await". These tests exercise the
 * ApprovalQueue side of durability: writing request/decision events as the
 * queue operates, and restoring pending requests as `pending, unowned` on
 * the next construction (simulating a bridge restart, since a fresh
 * `ApprovalQueue` instance replaying the same log is exactly what a restart
 * looks like from the queue's point of view).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalQueue } from "../approvalQueue.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-approval-durability-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function logLines(): unknown[] {
  const file = path.join(dir, "approval_log.jsonl");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("ApprovalQueue — no persistDir (default)", () => {
  it("behaves exactly as before: nothing survives across instances", () => {
    const q1 = new ApprovalQueue();
    q1.request({ toolName: "gitPush", params: {}, tier: "high" });
    expect(q1.list()).toHaveLength(1);

    const q2 = new ApprovalQueue();
    expect(q2.list()).toHaveLength(0);
  });
});

describe("ApprovalQueue — durable persistence", () => {
  it("writes a request event on enqueue and a decision event on approve", () => {
    const q = new ApprovalQueue({ persistDir: dir });
    const { callId } = q.request({
      toolName: "gitPush",
      params: { remote: "origin" },
      tier: "high",
    });
    q.approve(callId);

    const lines = logLines() as Array<{ kind: string; callId: string }>;
    expect(lines.map((l) => l.kind)).toEqual(["request", "decision"]);
    expect(lines[0]?.callId).toBe(callId);
    expect(lines[1]?.callId).toBe(callId);
  });

  it("live entries are owned:true", () => {
    const q = new ApprovalQueue({ persistDir: dir });
    q.request({ toolName: "gitPush", params: {}, tier: "high" });
    expect(q.list()[0]?.owned).toBe(true);
  });

  it("restores a still-pending request as owned:false on the next construction", () => {
    const q1 = new ApprovalQueue({ persistDir: dir });
    const { callId } = q1.request({
      toolName: "gitPush",
      params: { remote: "origin" },
      tier: "high",
    });
    // Never resolved — simulate a crash/restart before a decision was made.

    const q2 = new ApprovalQueue({ persistDir: dir });
    const restored = q2.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      callId,
      toolName: "gitPush",
      owned: false,
    });
  });

  it("a restored entry can still be approved/rejected — records a decision, resolves no live caller", () => {
    const q1 = new ApprovalQueue({ persistDir: dir });
    const { callId } = q1.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
    });

    const q2 = new ApprovalQueue({ persistDir: dir });
    expect(q2.approve(callId)).toBe(true);
    expect(q2.list()).toHaveLength(0); // resolved, no longer pending

    const lines = logLines() as Array<{ kind: string; decision?: string }>;
    const decisions = lines.filter((l) => l.kind === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe("approved");
  });

  it("a request already past its expiry while the process was down resolves as expired immediately, not restored", () => {
    const q1 = new ApprovalQueue({ persistDir: dir, ttlMs: { high: 10 } });
    q1.request({ toolName: "gitPush", params: {}, tier: "high" });
    // Don't wait for the in-process timer — construct q2 "later" by writing
    // a request whose expiresAt is already in the past relative to now.
    // (The 10ms TTL above will itself have elapsed by the time q2 constructs,
    // given the synchronous work in between — but assert it explicitly via
    // the persisted expiresAt rather than relying on timing.)
    const [reqLine] = logLines() as Array<{ expiresAt: number }>;
    expect(reqLine?.expiresAt).toBeGreaterThan(0);

    // Give the real clock time to pass the 10ms expiry deterministically.
    const start = Date.now();
    while (Date.now() - start < 15) {
      /* busy-wait past the TTL */
    }

    const q2 = new ApprovalQueue({ persistDir: dir });
    expect(q2.list()).toHaveLength(0); // not restored as pending

    const lines = logLines() as Array<{ kind: string; decision?: string }>;
    const decisions = lines.filter((l) => l.kind === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe("expired");
  });

  it("a still-live restored entry auto-expires on its own remaining timer", async () => {
    const q1 = new ApprovalQueue({ persistDir: dir, ttlMs: { high: 30 } });
    q1.request({ toolName: "gitPush", params: {}, tier: "high" });

    const q2 = new ApprovalQueue({ persistDir: dir });
    expect(q2.list()).toHaveLength(1);
    expect(q2.list()[0]?.owned).toBe(false);

    await new Promise((r) => setTimeout(r, 60));
    expect(q2.list()).toHaveLength(0);

    const lines = logLines() as Array<{ kind: string; decision?: string }>;
    const decisions = lines.filter((l) => l.kind === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe("expired");
  });

  it("does not restore requests that already have a matching decision", () => {
    const q1 = new ApprovalQueue({ persistDir: dir });
    const { callId } = q1.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
    });
    q1.approve(callId);

    const q2 = new ApprovalQueue({ persistDir: dir });
    expect(q2.list()).toHaveLength(0);
  });

  it("shutdown (clear()) does not write a decision — the entry stays unresolved for the next restore", () => {
    const q1 = new ApprovalQueue({ persistDir: dir });
    q1.request({ toolName: "gitPush", params: {}, tier: "high" });
    q1.clear(); // simulates bridge shutdown

    const lines = logLines() as Array<{ kind: string }>;
    expect(lines.filter((l) => l.kind === "decision")).toHaveLength(0);

    const q2 = new ApprovalQueue({ persistDir: dir });
    expect(q2.list()).toHaveLength(1);
    expect(q2.list()[0]?.owned).toBe(false);
  });
});
