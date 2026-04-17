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

  it("POST /approvals in plan mode + read tool → allow without queuing", async () => {
    const queue = new ApprovalQueue();
    const res = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approvals",
        body: { toolName: "Read", permissionMode: "plan" },
      },
      { queue, workspace: "/tmp", ccLoader: emptyRules() },
    );
    expect(res.body).toMatchObject({
      decision: "allow",
      reason: "plan_mode_read",
    });
    expect(queue.size()).toBe(0);
  });

  it("POST /approvals in plan mode + write tool → deny without queuing", async () => {
    const queue = new ApprovalQueue();
    for (const tool of ["Bash", "Edit", "Write"]) {
      const res = await routeApprovalRequest(
        {
          method: "POST",
          path: "/approvals",
          body: { toolName: tool, permissionMode: "plan" },
        },
        { queue, workspace: "/tmp", ccLoader: emptyRules() },
      );
      expect(res.body).toMatchObject({
        decision: "deny",
        reason: "plan_mode_write",
      });
    }
    expect(queue.size()).toBe(0);
  });

  it("POST /approvals in plan mode still honors cc deny rule on read tool", async () => {
    const queue = new ApprovalQueue();
    const res = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approvals",
        body: { toolName: "WebFetch", permissionMode: "plan" },
      },
      { queue, workspace: "/tmp", ccLoader: denyRules("WebFetch") },
    );
    expect(res.body).toMatchObject({
      decision: "deny",
      reason: "cc_deny_rule",
    });
  });

  it("POST /approvals in auto mode → allow without queuing", async () => {
    const queue = new ApprovalQueue();
    const res = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approvals",
        body: { toolName: "Bash", permissionMode: "auto" },
      },
      { queue, workspace: "/tmp", ccLoader: emptyRules() },
    );
    expect(res.body).toMatchObject({
      decision: "allow",
      reason: "auto_mode",
    });
    expect(queue.size()).toBe(0);
  });

  it("POST /approvals in auto mode still honors cc deny rule", async () => {
    const queue = new ApprovalQueue();
    const res = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approvals",
        body: { toolName: "gitPush", permissionMode: "auto" },
      },
      { queue, workspace: "/tmp", ccLoader: denyRules("gitPush") },
    );
    expect(res.body).toMatchObject({
      decision: "deny",
      reason: "cc_deny_rule",
    });
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

  it("onDecision callback fires with correct metadata", async () => {
    const events: Array<{ event: string; meta: Record<string, unknown> }> = [];
    const queue = new ApprovalQueue();
    await routeApprovalRequest(
      {
        method: "POST",
        path: "/approvals",
        body: { toolName: "Bash", specifier: "ls", sessionId: "s1" },
      },
      {
        queue,
        workspace: "/tmp",
        ccLoader: allowRules("Bash"),
        onDecision: (event, meta) => events.push({ event, meta }),
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "approval_decision",
      meta: {
        toolName: "Bash",
        specifier: "ls",
        decision: "allow",
        reason: "cc_allow_rule",
        sessionId: "s1",
      },
    });
  });

  it("onDecision fires on deny path", async () => {
    const events: Array<Record<string, unknown>> = [];
    const queue = new ApprovalQueue();
    await routeApprovalRequest(
      {
        method: "POST",
        path: "/approvals",
        body: { toolName: "gitPush", permissionMode: "dontAsk" },
      },
      {
        queue,
        workspace: "/tmp",
        ccLoader: emptyRules(),
        onDecision: (_, meta) => events.push(meta),
      },
    );
    expect(events[0]).toMatchObject({
      decision: "deny",
      reason: "dontAsk_mode",
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
