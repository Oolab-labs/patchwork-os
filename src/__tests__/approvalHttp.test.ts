import { describe, expect, it } from "vitest";
import { routeApprovalRequest } from "../approvalHttp.js";
import { ApprovalQueue } from "../approvalQueue.js";

function emptyRules() {
  return () => ({ allow: [], ask: [], deny: [] });
}
function denyRules(...names: string[]) {
  return () => ({ allow: [], ask: [], deny: names });
}
function allowRules(...names: string[]) {
  return () => ({ allow: names, ask: [], deny: [] });
}

describe("routeApprovalRequest", () => {
  it("GET /approvals returns queue list", async () => {
    const queue = new ApprovalQueue();
    queue.request({ toolName: "gitPush", params: {}, tier: "high" });
    const res = await routeApprovalRequest(
      { method: "GET", path: "/approvals" },
      { queue, workspace: "/tmp", ccLoader: emptyRules() },
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBe(1);
  });

  it("POST /approvals with CC deny rule → short-circuits to deny", async () => {
    const queue = new ApprovalQueue();
    const res = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approvals",
        body: { toolName: "gitPush" },
      },
      { queue, workspace: "/tmp", ccLoader: denyRules("gitPush") },
    );
    expect(res.body).toMatchObject({
      decision: "deny",
      reason: "cc_deny_rule",
    });
    expect(queue.size()).toBe(0);
  });

  it("POST /approvals with CC allow rule → short-circuits to allow", async () => {
    const queue = new ApprovalQueue();
    const res = await routeApprovalRequest(
      { method: "POST", path: "/approvals", body: { toolName: "Read" } },
      { queue, workspace: "/tmp", ccLoader: allowRules("Read") },
    );
    expect(res.body).toMatchObject({
      decision: "allow",
      reason: "cc_allow_rule",
    });
  });

  it("POST /approvals with no matching rule → queues + awaits dashboard", async () => {
    const queue = new ApprovalQueue();
    const pending = routeApprovalRequest(
      {
        method: "POST",
        path: "/approvals",
        body: { toolName: "sendHttpRequest", params: { url: "x" } },
      },
      { queue, workspace: "/tmp", ccLoader: emptyRules() },
    );
    // Wait for the request to hit the queue
    await new Promise((r) => setTimeout(r, 10));
    const list = queue.list();
    expect(list).toHaveLength(1);
    queue.approve(list[0].callId);
    const res = await pending;
    expect(res.body).toMatchObject({ decision: "allow", reason: "approved" });
  });

  it("POST /approvals in dontAsk mode → auto-denies unmatched tools", async () => {
    const queue = new ApprovalQueue();
    const res = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approvals",
        body: { toolName: "sendHttpRequest", permissionMode: "dontAsk" },
      },
      { queue, workspace: "/tmp", ccLoader: emptyRules() },
    );
    expect(res.body).toMatchObject({
      decision: "deny",
      reason: "dontAsk_mode",
    });
    expect(queue.size()).toBe(0);
  });

  it("POST /approvals in dontAsk still honors cc allow rule", async () => {
    const queue = new ApprovalQueue();
    const res = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approvals",
        body: { toolName: "Read", permissionMode: "dontAsk" },
      },
      { queue, workspace: "/tmp", ccLoader: allowRules("Read") },
    );
    expect(res.body).toMatchObject({
      decision: "allow",
      reason: "cc_allow_rule",
    });
  });

  it("POST /approve/:id resolves and returns allow", async () => {
    const queue = new ApprovalQueue();
    const { callId } = queue.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
    });
    const res = await routeApprovalRequest(
      { method: "POST", path: `/approve/${callId}` },
      { queue, workspace: "/tmp", ccLoader: emptyRules() },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ decision: "allow" });
  });

  it("POST /reject/:id returns deny", async () => {
    const queue = new ApprovalQueue();
    const { callId } = queue.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
    });
    const res = await routeApprovalRequest(
      { method: "POST", path: `/reject/${callId}` },
      { queue, workspace: "/tmp", ccLoader: emptyRules() },
    );
    expect(res.body).toMatchObject({ decision: "deny" });
  });

  it("approve with unknown callId returns 404", async () => {
    const res = await routeApprovalRequest(
      { method: "POST", path: "/approve/not-a-real-id" },
      {
        queue: new ApprovalQueue(),
        workspace: "/tmp",
        ccLoader: emptyRules(),
      },
    );
    expect(res.status).toBe(404);
  });

  it("POST /approvals without toolName → 400", async () => {
    const res = await routeApprovalRequest(
      { method: "POST", path: "/approvals", body: {} },
      {
        queue: new ApprovalQueue(),
        workspace: "/tmp",
        ccLoader: emptyRules(),
      },
    );
    expect(res.status).toBe(400);
  });

  it("GET /cc-permissions returns merged rules + workspace", async () => {
    const res = await routeApprovalRequest(
      { method: "GET", path: "/cc-permissions" },
      {
        queue: new ApprovalQueue(),
        workspace: "/my/ws",
        ccLoader: () => ({
          allow: ["Read"],
          ask: ["Bash(npm run *)"],
          deny: ["gitPush"],
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      allow: ["Read"],
      ask: ["Bash(npm run *)"],
      deny: ["gitPush"],
      workspace: "/my/ws",
    });
  });

  it("unknown route → 404", async () => {
    const res = await routeApprovalRequest(
      { method: "GET", path: "/what" },
      {
        queue: new ApprovalQueue(),
        workspace: "/tmp",
        ccLoader: emptyRules(),
      },
    );
    expect(res.status).toBe(404);
  });
});
