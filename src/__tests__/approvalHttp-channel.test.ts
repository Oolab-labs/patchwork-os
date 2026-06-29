/**
 * Audit 2026-06-09 — every `approval_decision` audit row carries a `channel`
 * provenance field so operators can tell a phone approval (single-use token via
 * ntfy/push) from a dashboard/Bearer approval. The audit log already answered
 * who/what/when; this adds "from where".
 */

import { describe, expect, it, vi } from "vitest";
import { routeApprovalRequest } from "../approvalHttp.js";
import type { ApprovalQueue } from "../approvalQueue.js";

function makeQueue(opts?: {
  validateToken?: (callId: string, token: string) => boolean;
  approve?: (callId: string) => boolean;
  reject?: (callId: string) => boolean;
  getRecentDecision?: (callId: string) => "allow" | "deny" | undefined;
  list?: () => Array<{ callId: string; toolName: string }>;
}): ApprovalQueue {
  return {
    validateToken: opts?.validateToken ?? (() => true),
    approve: opts?.approve ?? (() => true),
    reject: opts?.reject ?? (() => true),
    getRecentDecision: opts?.getRecentDecision ?? (() => undefined),
    list: opts?.list ?? (() => []),
    enqueue: () => Promise.resolve({ callId: "test", timedOut: false }),
    cancelPending: () => {},
    getPendingList: () => [],
    on: () => {},
    off: () => {},
    isPending: () => false,
    getFailureCount: () => 0,
  } as unknown as ApprovalQueue;
}

describe("routeApprovalRequest — approval_decision channel provenance", () => {
  it("tags an approve via single-use token as channel:phone", async () => {
    const onDecision = vi.fn();
    await routeApprovalRequest(
      {
        method: "POST",
        path: "/approve/call-1",
        body: {},
        approvalToken: "valid",
      },
      {
        queue: makeQueue({ validateToken: () => true, approve: () => true }),
        workspace: "/tmp",
        onDecision,
      },
    );
    expect(onDecision).toHaveBeenCalledWith(
      "approval_decision",
      expect.objectContaining({
        callId: "call-1",
        decision: "allow",
        channel: "phone",
      }),
    );
  });

  it("tags an approve without a token as channel:dashboard", async () => {
    const onDecision = vi.fn();
    await routeApprovalRequest(
      {
        method: "POST",
        path: "/approve/call-2",
        body: {},
        approvalToken: undefined,
      },
      {
        queue: makeQueue({ approve: () => true }),
        workspace: "/tmp",
        onDecision,
      },
    );
    expect(onDecision).toHaveBeenCalledWith(
      "approval_decision",
      expect.objectContaining({
        callId: "call-2",
        decision: "allow",
        channel: "dashboard",
      }),
    );
  });

  it("tags a reject via single-use token as channel:phone (alongside reason)", async () => {
    const onDecision = vi.fn();
    await routeApprovalRequest(
      {
        method: "POST",
        path: "/reject/call-3",
        body: { reason: "looks risky" },
        approvalToken: "valid",
      },
      {
        queue: makeQueue({ validateToken: () => true, reject: () => true }),
        workspace: "/tmp",
        onDecision,
      },
    );
    expect(onDecision).toHaveBeenCalledWith(
      "approval_decision",
      expect.objectContaining({
        callId: "call-3",
        decision: "deny",
        reason: "looks risky",
        channel: "phone",
      }),
    );
  });

  it("tags a reject without a token as channel:dashboard", async () => {
    const onDecision = vi.fn();
    await routeApprovalRequest(
      {
        method: "POST",
        path: "/reject/call-4",
        body: {},
        approvalToken: undefined,
      },
      {
        queue: makeQueue({ reject: () => true }),
        workspace: "/tmp",
        onDecision,
      },
    );
    expect(onDecision).toHaveBeenCalledWith(
      "approval_decision",
      expect.objectContaining({
        callId: "call-4",
        decision: "deny",
        channel: "dashboard",
      }),
    );
  });

  it("includes the pending entry's toolName on an approve decision (L4)", async () => {
    const onDecision = vi.fn();
    await routeApprovalRequest(
      { method: "POST", path: "/approve/call-5", body: {} },
      {
        queue: makeQueue({
          approve: () => true,
          list: () => [{ callId: "call-5", toolName: "gitPush" }],
        }),
        workspace: "/tmp",
        onDecision,
      },
    );
    expect(onDecision).toHaveBeenCalledWith(
      "approval_decision",
      expect.objectContaining({ callId: "call-5", toolName: "gitPush" }),
    );
  });

  it("includes the pending entry's toolName on a reject decision (L4)", async () => {
    const onDecision = vi.fn();
    await routeApprovalRequest(
      { method: "POST", path: "/reject/call-6", body: {} },
      {
        queue: makeQueue({
          reject: () => true,
          list: () => [{ callId: "call-6", toolName: "githubCreateIssue" }],
        }),
        workspace: "/tmp",
        onDecision,
      },
    );
    expect(onDecision).toHaveBeenCalledWith(
      "approval_decision",
      expect.objectContaining({
        callId: "call-6",
        toolName: "githubCreateIssue",
      }),
    );
  });
});
