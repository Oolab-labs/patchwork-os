import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../approvalQueue.js";
import {
  classifyTool,
  getRiskTierMap,
  requiresApproval,
  riskTierSummary,
} from "../riskTier.js";

describe("riskTier", () => {
  it("classifies known tools", () => {
    expect(classifyTool("getBufferContent")).toBe("low");
    expect(classifyTool("editText")).toBe("medium");
    expect(classifyTool("gitPush")).toBe("high");
  });

  it("defaults unknown tools to medium (safe)", () => {
    expect(classifyTool("imaginaryTool")).toBe("medium");
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
