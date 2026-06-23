/**
 * Tier-0 #1 (audit 2026-06-22) — ?sig= fail-open.
 *
 * server.ts bypasses the Bearer gate for POST /approve|reject/<id> whenever a
 * `?sig=` query param is present (phone-path signed-callback shape). The
 * downstream handler in approvalHttp.ts only VALIDATES that sig when
 * `deps.ntfyHmacSecret` is configured — otherwise both credential branches are
 * skipped and execution falls through to an UNAUTHENTICATED queue.approve() /
 * queue.reject().
 *
 * Net effect: when no ntfyHmacSecret is configured (the default), an attacker
 * can approve or reject ANY pending callId with `POST /approve/<id>?sig=x`.
 *
 * Fix: when a sig is present but no secret is configured, fail closed (401) on
 * BOTH the approve and reject paths.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { routeApprovalRequest } from "../approvalHttp.js";
import type { ApprovalQueue } from "../approvalQueue.js";

function makeQueue(opts?: {
  approve?: (callId: string) => boolean;
  reject?: (callId: string) => boolean;
}): ApprovalQueue {
  return {
    validateToken: () => false,
    approve: opts?.approve ?? (() => true),
    reject: opts?.reject ?? (() => true),
    getRecentDecision: () => undefined,
    enqueue: () => Promise.resolve({ callId: "test", timedOut: false }),
    cancelPending: () => {},
    getPendingList: () => [],
    on: () => {},
    off: () => {},
    isPending: () => false,
    getFailureCount: () => 0,
  } as unknown as ApprovalQueue;
}

describe("routeApprovalRequest — ?sig= present but no ntfyHmacSecret (Tier-0 #1)", () => {
  it("rejects approve with a sig but no configured secret (must NOT fall through to approve)", async () => {
    const approve = vi.fn(() => true);
    const queue = makeQueue({ approve });

    const result = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approve/call-abc",
        body: {},
        query: new URLSearchParams({ sig: "deadbeefdeadbeef" }),
        // no approvalToken, no ntfyHmacSecret on deps
      },
      {
        queue,
        workspace: "/tmp",
        // ntfyHmacSecret intentionally unset
      },
    );

    expect(result.status).toBe(401);
    // The unauthenticated decision must NOT have been applied.
    expect(approve).not.toHaveBeenCalled();
  });

  it("rejects reject with a sig but no configured secret (must NOT fall through to reject)", async () => {
    const reject = vi.fn(() => true);
    const queue = makeQueue({ reject });

    const result = await routeApprovalRequest(
      {
        method: "POST",
        path: "/reject/call-abc",
        body: {},
        query: new URLSearchParams({ sig: "deadbeefdeadbeef" }),
      },
      {
        queue,
        workspace: "/tmp",
      },
    );

    expect(result.status).toBe(401);
    expect(reject).not.toHaveBeenCalled();
  });

  it("still allows approve with a valid sig when a secret IS configured (M23 regression guard)", async () => {
    const secret = "test-ntfy-secret";
    const callId = "call-xyz";
    const sig = createHmac("sha256", secret)
      .update(`approve:${callId}`)
      .digest("hex");
    const queue = makeQueue({ approve: () => true });

    const result = await routeApprovalRequest(
      {
        method: "POST",
        path: `/approve/${callId}`,
        body: {},
        query: new URLSearchParams({ sig }),
      },
      {
        queue,
        workspace: "/tmp",
        ntfyHmacSecret: secret,
      },
    );

    expect(result.status).toBe(200);
  });

  it("rejects approve with an invalid sig when a secret IS configured (unchanged)", async () => {
    const secret = "test-ntfy-secret";
    const queue = makeQueue({ approve: () => true });

    const result = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approve/call-xyz",
        body: {},
        query: new URLSearchParams({ sig: "00000000" }),
      },
      {
        queue,
        workspace: "/tmp",
        ntfyHmacSecret: secret,
      },
    );

    expect(result.status).toBe(401);
  });

  it("still allows the bearer-only dashboard path (no sig, no token)", async () => {
    const queue = makeQueue({ approve: () => true });

    const result = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approve/call-abc",
        body: {},
        // no query, no approvalToken — bearer was validated upstream
      },
      {
        queue,
        workspace: "/tmp",
      },
    );

    expect(result.status).toBe(200);
  });
});
