import { describe, expect, it } from "vitest";
import { routeApprovalRequest } from "../approvalHttp.js";
import {
  getApprovalQueue,
  resetApprovalQueueForTests,
} from "../approvalQueue.js";

/**
 * Smoke test for the singleton wiring that server.ts uses at runtime:
 *   getApprovalQueue() → routeApprovalRequest(...).
 *
 * Protects the contract the mounted route depends on. If this test breaks,
 * server.ts's /approvals handler breaks in production.
 */

describe("approval mount singleton", () => {
  it("request → list via singleton queue", async () => {
    resetApprovalQueueForTests();
    const q = getApprovalQueue();
    q.request({ toolName: "gitPush", params: {}, tier: "high" });

    const listRes = await routeApprovalRequest(
      { method: "GET", path: "/approvals" },
      {
        queue: getApprovalQueue(),
        workspace: "/tmp",
        ccLoader: () => ({ allow: [], ask: [], deny: [] }),
      },
    );
    expect(listRes.status).toBe(200);
    expect((listRes.body as unknown[]).length).toBe(1);
    resetApprovalQueueForTests();
  });

  it("singleton persists across calls", () => {
    resetApprovalQueueForTests();
    const a = getApprovalQueue();
    const b = getApprovalQueue();
    expect(a).toBe(b);
  });
});
