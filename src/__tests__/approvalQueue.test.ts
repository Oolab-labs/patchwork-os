import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../approvalQueue.js";
import {
  classifyBehavior,
  classifyTool,
  getRiskTierMap,
  inferTierFromName,
  requiresApproval,
  riskTierSummary,
} from "../riskTier.js";

describe("riskTier", () => {
  it("classifies known tools", () => {
    expect(classifyTool("getBufferContent")).toBe("low");
    expect(classifyTool("editText")).toBe("medium");
    expect(classifyTool("gitPush")).toBe("high");
  });

  it("falls back to inference for unmapped tools", () => {
    // Known names still win
    expect(classifyTool("gitPush")).toBe("high");
    // Inference kicks in
    expect(classifyTool("getSomethingNew")).toBe("low");
    expect(classifyTool("editSomethingNew")).toBe("medium");
    expect(classifyTool("runScript")).toBe("high");
  });

  it("inferTierFromName heuristics", () => {
    expect(inferTierFromName("getBuffer")).toBe("low");
    expect(inferTierFromName("findFoo")).toBe("low");
    expect(inferTierFromName("searchBar")).toBe("low");
    expect(inferTierFromName("editDoc")).toBe("medium");
    expect(inferTierFromName("writeLine")).toBe("medium");
    expect(inferTierFromName("renameSymbol")).toBe("medium");
    expect(inferTierFromName("gitPush")).toBe("high");
    expect(inferTierFromName("runCommand")).toBe("high");
    expect(inferTierFromName("sendMessage")).toBe("high");
    expect(inferTierFromName("deleteFile")).toBe("high");
    expect(inferTierFromName("mystery")).toBe("medium"); // safe default
  });

  it("requiresApproval honors policy", () => {
    expect(requiresApproval("gitPush")).toBe(true);
    expect(requiresApproval("getBufferContent")).toBe(false);
    expect(requiresApproval("editText", ["medium", "high"])).toBe(true);
  });

  it("summary counts each tier > 0", () => {
    const s = riskTierSummary();
    expect(s.low).toBeGreaterThan(0);
    expect(s.medium).toBeGreaterThan(0);
    expect(s.high).toBeGreaterThan(0);
  });

  it("map is read-only view", () => {
    const m = getRiskTierMap();
    expect(m.gitPush).toBe("high");
  });

  it("classifyBehavior maps tiers to CC behavior classes", () => {
    expect(classifyBehavior("getBufferContent")).toBe("readOnly");
    expect(classifyBehavior("editText")).toBe("localWrite");
    expect(classifyBehavior("gitPush")).toBe("externalEffect");
  });
});

describe("ApprovalQueue", () => {
  it("request → approve resolves decision", async () => {
    const q = new ApprovalQueue();
    const { callId, promise } = q.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
    });
    expect(q.list()).toHaveLength(1);
    expect(q.approve(callId)).toBe(true);
    await expect(promise).resolves.toBe("approved");
    expect(q.list()).toHaveLength(0);
  });

  it("reject resolves 'rejected'", async () => {
    const q = new ApprovalQueue();
    const { callId, promise } = q.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
    });
    q.reject(callId);
    await expect(promise).resolves.toBe("rejected");
  });

  it("unknown callId returns false", () => {
    const q = new ApprovalQueue();
    expect(q.approve("not-a-real-id")).toBe(false);
    expect(q.reject("not-a-real-id")).toBe(false);
  });

  // ─── concurrent approve+reject loser ── audit 2026-05-17 ────────────────
  // First decision wins; second sees `getRecentDecision()` returning the
  // already-recorded outcome so the HTTP layer can return 409 instead of
  // an indistinguishable 404 "unknown callId".
  it("getRecentDecision returns null before any decision", () => {
    const q = new ApprovalQueue();
    expect(q.getRecentDecision("never-seen")).toBe(null);
  });

  it("getRecentDecision returns the decision after approve", async () => {
    const q = new ApprovalQueue();
    const { callId, promise } = q.request({
      toolName: "x",
      params: {},
      tier: "high",
    });
    expect(q.approve(callId)).toBe(true);
    await expect(promise).resolves.toBe("approved");
    expect(q.getRecentDecision(callId)).toBe("approved");
  });

  it("getRecentDecision returns the decision after reject", async () => {
    const q = new ApprovalQueue();
    const { callId, promise } = q.request({
      toolName: "x",
      params: {},
      tier: "high",
    });
    expect(q.reject(callId)).toBe(true);
    await expect(promise).resolves.toBe("rejected");
    expect(q.getRecentDecision(callId)).toBe("rejected");
  });

  it("counter-decision returns the first decision via getRecentDecision (loser converges)", async () => {
    const q = new ApprovalQueue();
    const { callId, promise } = q.request({
      toolName: "x",
      params: {},
      tier: "high",
    });
    expect(q.approve(callId)).toBe(true);
    await expect(promise).resolves.toBe("approved");
    // Second decision arrives — entry is gone, so the call returns
    // false; the recent-decision lookup still gives the answer.
    expect(q.reject(callId)).toBe(false);
    expect(q.getRecentDecision(callId)).toBe("approved");
  });

  it("clear() drains recentlyDecided too", async () => {
    const q = new ApprovalQueue();
    const { callId } = q.request({
      toolName: "x",
      params: {},
      tier: "high",
    });
    q.approve(callId);
    expect(q.getRecentDecision(callId)).toBe("approved");
    q.clear();
    expect(q.getRecentDecision(callId)).toBe(null);
  });

  it("TTL expires pending entries", async () => {
    vi.useFakeTimers();
    try {
      const q = new ApprovalQueue({ ttlMs: 1000 });
      const { promise } = q.request({
        toolName: "gitPush",
        params: {},
        tier: "high",
      });
      vi.advanceTimersByTime(1500);
      await expect(promise).resolves.toBe("expired");
      expect(q.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clear resolves pending entries as expired", async () => {
    const q = new ApprovalQueue();
    const { promise } = q.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
    });
    q.clear();
    await expect(promise).resolves.toBe("expired");
  });

  it("per-tier ttlMs applies a different window per RiskTier", async () => {
    vi.useFakeTimers();
    try {
      const q = new ApprovalQueue({ ttlMs: { low: 1000, medium: 5000 } });
      const low = q.request({ toolName: "a", params: {}, tier: "low" });
      const medium = q.request({ toolName: "b", params: {}, tier: "medium" });

      vi.advanceTimersByTime(1500);
      await expect(low.promise).resolves.toBe("expired");
      expect(q.size()).toBe(1); // medium entry still pending

      vi.advanceTimersByTime(4000);
      await expect(medium.promise).resolves.toBe("expired");
      expect(q.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a tier with ttlMs 0 never auto-expires (held until decided)", async () => {
    vi.useFakeTimers();
    try {
      const q = new ApprovalQueue({ ttlMs: { high: 0 } });
      const { callId, promise } = q.request({
        toolName: "gitPush",
        params: {},
        tier: "high",
      });

      vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000); // a full year
      expect(q.size()).toBe(1);

      q.approve(callId);
      await expect(promise).resolves.toBe("approved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to DEFAULT_TTL_MS per tier when no ttlMs override given", () => {
    const q = new ApprovalQueue();
    // high defaults to a long-but-bounded window (4h), not unbounded — see
    // the compatibility note on ApprovalQueue.DEFAULT_TTL_MS.
    const high = q.request({ toolName: "gitPush", params: {}, tier: "high" });
    const highExpiresAt = q.peek(high.callId)?.expiresAt;
    expect(highExpiresAt).not.toBeNull();
    expect(highExpiresAt).toBeGreaterThan(
      Date.now() + 3 * 60 * 60_000, // well past 3h out
    );

    const low = q.request({ toolName: "a", params: {}, tier: "low" });
    expect(q.peek(low.callId)?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("an explicit ttlMs of 0 for a tier (e.g. --approval-timeout-high none) opts into true unbounded hold", async () => {
    vi.useFakeTimers();
    try {
      const q = new ApprovalQueue({ ttlMs: { high: 0 } });
      const { callId } = q.request({
        toolName: "gitPush",
        params: {},
        tier: "high",
      });
      expect(q.peek(callId)?.expiresAt).toBeNull();
      vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
      expect(q.size()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a bare number ttlMs still applies uniformly to every tier (back-compat)", async () => {
    vi.useFakeTimers();
    try {
      const q = new ApprovalQueue({ ttlMs: 1000 });
      const high = q.request({ toolName: "gitPush", params: {}, tier: "high" });
      vi.advanceTimersByTime(1500);
      await expect(high.promise).resolves.toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Cancellation — audit 2026-05-17 ────────────────────────────────────────
describe("ApprovalQueue — cancellation", () => {
  it("cancel(callId) resolves the originating promise with 'cancelled'", async () => {
    const q = new ApprovalQueue();
    const { callId, promise } = q.request({
      toolName: "x",
      params: {},
      tier: "high",
    });
    expect(q.cancel(callId)).toBe(true);
    await expect(promise).resolves.toBe("cancelled");
  });

  it("cancel removes the entry from the queue", () => {
    const q = new ApprovalQueue();
    const { callId } = q.request({
      toolName: "x",
      params: {},
      tier: "high",
    });
    expect(q.size()).toBe(1);
    q.cancel(callId);
    expect(q.size()).toBe(0);
  });

  it("cancel(unknown) returns false (idempotent)", () => {
    const q = new ApprovalQueue();
    expect(q.cancel("not-a-real-id")).toBe(false);
  });

  it("cancelAll resolves every pending promise with 'cancelled' and returns the cancelled callIds", async () => {
    const q = new ApprovalQueue();
    const a = q.request({ toolName: "x", params: { i: 1 }, tier: "high" });
    const b = q.request({ toolName: "y", params: { i: 2 }, tier: "high" });
    const c = q.request({ toolName: "z", params: { i: 3 }, tier: "high" });
    expect(q.size()).toBe(3);
    const cancelled = q.cancelAll();
    expect(cancelled.sort()).toEqual([a.callId, b.callId, c.callId].sort());
    expect(q.size()).toBe(0);
    await expect(a.promise).resolves.toBe("cancelled");
    await expect(b.promise).resolves.toBe("cancelled");
    await expect(c.promise).resolves.toBe("cancelled");
  });

  it("cancelAll on an empty queue is a no-op returning []", () => {
    const q = new ApprovalQueue();
    expect(q.cancelAll()).toEqual([]);
  });

  it("AbortSignal on request() resolves the promise with 'cancelled'", async () => {
    const q = new ApprovalQueue();
    const ac = new AbortController();
    const { promise } = q.request(
      { toolName: "x", params: {}, tier: "high" },
      { signal: ac.signal },
    );
    expect(q.size()).toBe(1);
    ac.abort();
    await expect(promise).resolves.toBe("cancelled");
    expect(q.size()).toBe(0);
  });

  it("already-aborted signal at request() time still resolves with 'cancelled'", async () => {
    const q = new ApprovalQueue();
    const ac = new AbortController();
    ac.abort();
    const { promise } = q.request(
      { toolName: "x", params: {}, tier: "high" },
      { signal: ac.signal },
    );
    await expect(promise).resolves.toBe("cancelled");
  });

  it("dedup-joined caller's abort does NOT cancel the original caller", async () => {
    const q = new ApprovalQueue();
    const { callId, promise: originalPromise } = q.request({
      toolName: "x",
      params: { k: "v" },
      tier: "high",
    });
    const ac = new AbortController();
    const { promise: joinedPromise } = q.request(
      { toolName: "x", params: { k: "v" }, tier: "high" },
      { signal: ac.signal },
    );
    // Joined caller abandons.
    ac.abort();
    await expect(joinedPromise).resolves.toBe("cancelled");
    // Original entry still alive.
    expect(q.size()).toBe(1);
    // Original caller's promise still pending until a decision arrives.
    expect(q.approve(callId)).toBe(true);
    await expect(originalPromise).resolves.toBe("approved");
  });
});

describe("ApprovalQueue — approval tokens", () => {
  it("no token by default", () => {
    const q = new ApprovalQueue();
    const { approvalToken } = q.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
    });
    expect(approvalToken).toBeUndefined();
  });

  it("generates token when withToken: true", () => {
    const q = new ApprovalQueue();
    const { approvalToken } = q.request(
      { toolName: "gitPush", params: {}, tier: "high" },
      { withToken: true },
    );
    expect(typeof approvalToken).toBe("string");
    expect(approvalToken!.length).toBe(64); // 32 bytes hex
  });

  it("validateToken returns true for correct token", () => {
    const q = new ApprovalQueue();
    const { callId, approvalToken } = q.request(
      { toolName: "gitPush", params: {}, tier: "high" },
      { withToken: true },
    );
    expect(q.validateToken(callId, approvalToken!)).toBe(true);
  });

  it("validateToken is single-use on success — second call returns false", () => {
    const q = new ApprovalQueue();
    const { callId, approvalToken } = q.request(
      { toolName: "gitPush", params: {}, tier: "high" },
      { withToken: true },
    );
    expect(q.validateToken(callId, approvalToken!)).toBe(true);
    // Successful match consumes the token. Subsequent validations fail.
    expect(q.validateToken(callId, approvalToken!)).toBe(false);
  });

  it("validateToken rejects wrong token", () => {
    const q = new ApprovalQueue();
    const { callId } = q.request(
      { toolName: "gitPush", params: {}, tier: "high" },
      { withToken: true },
    );
    expect(q.validateToken(callId, "deadbeef".repeat(8))).toBe(false);
  });

  it("wrong token does NOT invalidate the legitimate token (DoS regression)", () => {
    // Regression: prior implementation cleared the token on first check
    // regardless of outcome, so any unauthenticated POST with a syntactically-
    // valid callId could lock out the rightful approver. Wrong-token POSTs
    // must now leave the legit token alive for retries.
    const q = new ApprovalQueue();
    const { callId, approvalToken } = q.request(
      { toolName: "gitPush", params: {}, tier: "high" },
      { withToken: true },
    );
    expect(q.validateToken(callId, "deadbeef".repeat(8))).toBe(false);
    expect(q.validateToken(callId, "ff".repeat(32))).toBe(false);
    // The real approver still wins.
    expect(q.validateToken(callId, approvalToken!)).toBe(true);
  });

  it("survives sustained wrong-token spray without locking out the legit approver", () => {
    // Regression: prior cap of 5 enabled its own DoS — an attacker burning
    // 4 failures on a leaked callId locked the legit approver out after one
    // typo. Same applied to dedup-reused entries inheriting accumulated
    // tokenFailures. Cap bumped to 1000 (memory/CPU bound, not security
    // bound — token entropy is 256 bits). 100 wrong attempts must still
    // leave room for the legit one to win.
    const q = new ApprovalQueue();
    const { callId, approvalToken } = q.request(
      { toolName: "gitPush", params: {}, tier: "high" },
      { withToken: true },
    );
    for (let i = 0; i < 100; i++) {
      expect(q.validateToken(callId, "deadbeef".repeat(8))).toBe(false);
    }
    expect(q.validateToken(callId, approvalToken!)).toBe(true);
  });

  it("validateToken returns false for unknown callId", () => {
    const q = new ApprovalQueue();
    expect(q.validateToken("no-such-id", "anytoken")).toBe(false);
  });

  it("token not exposed in list()", () => {
    const q = new ApprovalQueue();
    q.request(
      { toolName: "gitPush", params: {}, tier: "high" },
      { withToken: true },
    );
    const item = q.list()[0]!;
    expect((item as Record<string, unknown>).approvalToken).toBeUndefined();
  });
});

describe("ApprovalQueue dedup (inflight key)", () => {
  it("identical requests return the same callId and one queue entry", () => {
    const q = new ApprovalQueue();
    const r1 = q.request({
      toolName: "gitPush",
      params: { remote: "origin", branch: "main" },
      tier: "high",
      sessionId: "s1",
    });
    const r2 = q.request({
      toolName: "gitPush",
      params: { remote: "origin", branch: "main" },
      tier: "high",
      sessionId: "s1",
    });
    expect(r2.callId).toBe(r1.callId);
    expect(q.list()).toHaveLength(1);
  });

  it("dedups regardless of param key order", () => {
    const q = new ApprovalQueue();
    const r1 = q.request({
      toolName: "gitPush",
      params: { remote: "origin", branch: "main" },
      tier: "high",
      sessionId: "s1",
    });
    const r2 = q.request({
      toolName: "gitPush",
      params: { branch: "main", remote: "origin" },
      tier: "high",
      sessionId: "s1",
    });
    expect(r2.callId).toBe(r1.callId);
  });

  it("different params do NOT dedup", () => {
    const q = new ApprovalQueue();
    const r1 = q.request({
      toolName: "gitPush",
      params: { remote: "origin", branch: "main" },
      tier: "high",
      sessionId: "s1",
    });
    const r2 = q.request({
      toolName: "gitPush",
      params: { remote: "origin", branch: "feature" },
      tier: "high",
      sessionId: "s1",
    });
    expect(r2.callId).not.toBe(r1.callId);
    expect(q.list()).toHaveLength(2);
  });

  it("different sessionIds do NOT dedup", () => {
    const q = new ApprovalQueue();
    const r1 = q.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
      sessionId: "s1",
    });
    const r2 = q.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
      sessionId: "s2",
    });
    expect(r2.callId).not.toBe(r1.callId);
  });

  it("approve() resolves both deduped promises", async () => {
    const q = new ApprovalQueue();
    const r1 = q.request({
      toolName: "gitPush",
      params: { remote: "origin" },
      tier: "high",
      sessionId: "s1",
    });
    const r2 = q.request({
      toolName: "gitPush",
      params: { remote: "origin" },
      tier: "high",
      sessionId: "s1",
    });
    q.approve(r1.callId);
    await expect(r1.promise).resolves.toBe("approved");
    await expect(r2.promise).resolves.toBe("approved");
  });

  it("expired timer resolves both deduped promises", async () => {
    vi.useFakeTimers();
    try {
      const q = new ApprovalQueue({ ttlMs: 100 });
      const r1 = q.request({
        toolName: "gitPush",
        params: {},
        tier: "high",
        sessionId: "s1",
      });
      const r2 = q.request({
        toolName: "gitPush",
        params: {},
        tier: "high",
        sessionId: "s1",
      });
      vi.advanceTimersByTime(150);
      await expect(r1.promise).resolves.toBe("expired");
      await expect(r2.promise).resolves.toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("after resolve, identical request creates a fresh entry", async () => {
    const q = new ApprovalQueue();
    const r1 = q.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
      sessionId: "s1",
    });
    q.approve(r1.callId);
    await r1.promise;
    const r2 = q.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
      sessionId: "s1",
    });
    expect(r2.callId).not.toBe(r1.callId);
  });

  it("clear() resolves deduped pending promises AND empties inflight map", async () => {
    // Bug 2: clear() walked entries.values() and resolved each entry.resolve,
    // but never iterated entry.pendingPromises[] (deduped joiners) and never
    // cleared this.inflight. Deduped callers' promises hung forever after
    // shutdown / resetApprovalQueueForTests.
    const q = new ApprovalQueue();
    const r1 = q.request({
      toolName: "gitPush",
      params: { remote: "origin", branch: "main" },
      tier: "high",
      sessionId: "s1",
    });
    const r2 = q.request({
      toolName: "gitPush",
      params: { remote: "origin", branch: "main" },
      tier: "high",
      sessionId: "s1",
    });
    // r2 dedup-joined r1 — same callId, separate promise.
    expect(r2.callId).toBe(r1.callId);

    q.clear();

    // Both the primary and the deduped joiner must wake.
    await expect(r1.promise).resolves.toBe("expired");
    await expect(r2.promise).resolves.toBe("expired");

    // inflight map must be drained — leftover entries leak memory and
    // prevent the next identical request from creating a fresh entry.
    // Reach into the private field via index access (acceptable in tests).
    const inflight = (q as unknown as { inflight: Map<string, string> })
      .inflight;
    expect(inflight.size).toBe(0);
  });
});
