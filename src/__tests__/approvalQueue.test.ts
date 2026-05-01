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

  it("validateToken is single-use — second call returns false", () => {
    const q = new ApprovalQueue();
    const { callId, approvalToken } = q.request(
      { toolName: "gitPush", params: {}, tier: "high" },
      { withToken: true },
    );
    q.validateToken(callId, approvalToken!);
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
