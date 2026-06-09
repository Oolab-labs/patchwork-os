/**
 * LOW #18 — Phone-path token validation must run even when a valid Bearer
 * token is present in the same request.
 *
 * The two-factor intent: a valid Bearer token grants dashboard-level access
 * (approve/reject without an approvalToken), but when an `approvalToken` IS
 * explicitly provided (phone-path shape), it must ALWAYS be validated regardless
 * of Bearer status. This prevents a confused-deputy attack where a valid Bearer
 * holder forges an invalid phone token and bypasses the single-use guard.
 */

import { describe, expect, it } from "vitest";
import { routeApprovalRequest } from "../approvalHttp.js";
import type { ApprovalQueue } from "../approvalQueue.js";

function makeQueue(opts?: {
  validateToken?: (callId: string, token: string) => boolean;
  approve?: (callId: string) => boolean;
  reject?: (callId: string) => boolean;
  getRecentDecision?: (callId: string) => "allow" | "deny" | undefined;
}): ApprovalQueue {
  return {
    validateToken: opts?.validateToken ?? (() => false),
    approve: opts?.approve ?? (() => false),
    reject: opts?.reject ?? (() => false),
    getRecentDecision: opts?.getRecentDecision ?? (() => undefined),
    enqueue: () => Promise.resolve({ callId: "test", timedOut: false }),
    cancelPending: () => {},
    getPendingList: () => [],
    on: () => {},
    off: () => {},
    isPending: () => false,
    getFailureCount: () => 0,
  } as unknown as ApprovalQueue;
}

describe("routeApprovalRequest — phone-path approvalToken validation (LOW #18)", () => {
  it("rejects approve with a valid Bearer context but invalid approvalToken", async () => {
    // Simulate: Bearer token was validated upstream (isStaticToken=true), BUT
    // the request also carries an x-approval-token that is invalid.
    // The approvalToken check must fire regardless of Bearer status.
    const queue = makeQueue({
      validateToken: (_callId, _token) => false, // invalid token
      approve: () => true,
    });

    const result = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approve/call-abc",
        body: {},
        approvalToken: "invalid-approval-token-xyz",
      },
      {
        queue,
        workspace: "/tmp",
      },
    );

    // The invalid approvalToken must cause a 401; Bearer auth does NOT bypass this.
    expect(result.status).toBe(401);
    expect((result.body as Record<string, unknown>).error).toContain("invalid");
  });

  it("rejects reject with a valid Bearer context but invalid approvalToken", async () => {
    const queue = makeQueue({
      validateToken: (_callId, _token) => false,
      reject: () => true,
    });

    const result = await routeApprovalRequest(
      {
        method: "POST",
        path: "/reject/call-abc",
        body: {},
        approvalToken: "bad-token",
      },
      {
        queue,
        workspace: "/tmp",
      },
    );

    expect(result.status).toBe(401);
    expect((result.body as Record<string, unknown>).error).toContain("invalid");
  });

  it("allows approve when approvalToken is valid", async () => {
    const queue = makeQueue({
      validateToken: () => true,
      approve: () => true,
    });

    const result = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approve/call-abc",
        body: {},
        approvalToken: "valid-token",
      },
      {
        queue,
        workspace: "/tmp",
      },
    );

    expect(result.status).toBe(200);
  });

  it("allows approve when no approvalToken is present (bearer-only path)", async () => {
    // When approvalToken is absent (undefined), the check should be skipped —
    // bearer-authenticated callers don't need to provide an approvalToken.
    const queue = makeQueue({
      validateToken: () => false, // would fail if called
      approve: () => true,
    });

    const result = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approve/call-abc",
        body: {},
        approvalToken: undefined, // no token presented
      },
      {
        queue,
        workspace: "/tmp",
      },
    );

    expect(result.status).toBe(200);
  });
});
