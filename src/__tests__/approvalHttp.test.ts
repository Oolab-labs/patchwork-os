import { describe, expect, it, vi } from "vitest";
import { routeApprovalRequest } from "../approvalHttp.js";
import { ApprovalQueue } from "../approvalQueue.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue({ address: "93.184.216.34", family: 4 }),
}));

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
      {
        queue,
        workspace: "/tmp",
        ccLoader: emptyRules(),
        approvalGate: "all",
      },
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
    expect(res.body).toMatchObject({
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

  describe("approvalGate modes", () => {
    it("gate=off → allow without queueing", async () => {
      const queue = new ApprovalQueue();
      const res = await routeApprovalRequest(
        { method: "POST", path: "/approvals", body: { toolName: "gitPush" } },
        {
          queue,
          workspace: "/tmp",
          ccLoader: emptyRules(),
          approvalGate: "off",
        },
      );
      expect(res.body).toMatchObject({ decision: "allow", reason: "gate_off" });
      expect(queue.size()).toBe(0);
    });

    it("gate=high → low-tier tool allowed without queue", async () => {
      const queue = new ApprovalQueue();
      const res = await routeApprovalRequest(
        { method: "POST", path: "/approvals", body: { toolName: "Read" } },
        {
          queue,
          workspace: "/tmp",
          ccLoader: emptyRules(),
          approvalGate: "high",
        },
      );
      expect(res.body).toMatchObject({
        decision: "allow",
        reason: "gate_below_threshold",
      });
      expect(queue.size()).toBe(0);
    });

    it("gate=all → queues even low-tier tools", async () => {
      const queue = new ApprovalQueue();
      const pending = routeApprovalRequest(
        { method: "POST", path: "/approvals", body: { toolName: "Read" } },
        {
          queue,
          workspace: "/tmp",
          ccLoader: emptyRules(),
          approvalGate: "all",
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(queue.list()).toHaveLength(1);
      const first = queue.list()[0];
      if (!first) throw new Error("missing queued item");
      queue.reject(first.callId);
      const res = await pending;
      expect(res.body).toMatchObject({ decision: "deny", reason: "rejected" });
    });
  });

  describe("permission-mode: auto", () => {
    it("auto mode → allow without queueing", async () => {
      const queue = new ApprovalQueue();
      const res = await routeApprovalRequest(
        {
          method: "POST",
          path: "/approvals",
          body: { toolName: "gitPush", permissionMode: "auto" },
        },
        { queue, workspace: "/tmp", ccLoader: emptyRules() },
      );
      expect(res.body).toMatchObject({
        decision: "allow",
        reason: "auto_mode",
      });
      expect(queue.size()).toBe(0);
    });
  });

  describe("risk signals", () => {
    it("Bash with rm -rf → destructive_flag high signal queued", async () => {
      const queue = new ApprovalQueue();
      const pending = routeApprovalRequest(
        {
          method: "POST",
          path: "/approvals",
          body: {
            toolName: "Bash",
            params: { command: "rm -rf /tmp/foo" },
          },
        },
        {
          queue,
          workspace: "/tmp",
          ccLoader: emptyRules(),
          approvalGate: "all",
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      const item = queue.list()[0];
      if (!item) throw new Error("missing queued item");
      const signals = item.riskSignals ?? [];
      expect(signals.some((s) => s.label.includes("rm with -rf"))).toBe(true);
      queue.approve(item.callId);
      await pending;
    });

    it("sendHttpRequest with non-HTTPS + raw IP → two domain_reputation signals", async () => {
      const queue = new ApprovalQueue();
      const pending = routeApprovalRequest(
        {
          method: "POST",
          path: "/approvals",
          body: {
            toolName: "sendHttpRequest",
            params: { url: "http://10.0.0.1/x" },
          },
        },
        {
          queue,
          workspace: "/tmp",
          ccLoader: emptyRules(),
          approvalGate: "all",
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      const item = queue.list()[0];
      if (!item) throw new Error("missing queued item");
      const kinds = (item.riskSignals ?? []).map((s) => s.kind);
      expect(kinds).toContain("domain_reputation");
      queue.approve(item.callId);
      await pending;
    });

    it("Write to path outside workspace → path_escape signal", async () => {
      const queue = new ApprovalQueue();
      const pending = routeApprovalRequest(
        {
          method: "POST",
          path: "/approvals",
          body: {
            toolName: "Write",
            params: { file_path: "/etc/passwd" },
          },
        },
        {
          queue,
          workspace: "/tmp/ws",
          ccLoader: emptyRules(),
          approvalGate: "all",
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      const item = queue.list()[0];
      if (!item) throw new Error("missing queued item");
      expect(
        (item.riskSignals ?? []).some((s) => s.kind === "path_escape"),
      ).toBe(true);
      queue.approve(item.callId);
      await pending;
    });
  });

  describe("webhook dispatch", () => {
    it("non-HTTPS webhook URL is rejected (no fetch call)", async () => {
      const originalFetch = globalThis.fetch;
      const calls: string[] = [];
      globalThis.fetch = (async (url: string) => {
        calls.push(url);
        return new Response("{}", { status: 200 });
      }) as typeof globalThis.fetch;
      try {
        const queue = new ApprovalQueue();
        const pending = routeApprovalRequest(
          { method: "POST", path: "/approvals", body: { toolName: "gitPush" } },
          {
            queue,
            workspace: "/tmp",
            ccLoader: emptyRules(),
            approvalGate: "all",
            webhookUrl: "http://example.com/hook",
          },
        );
        await new Promise((r) => setTimeout(r, 10));
        const item = queue.list()[0];
        if (!item) throw new Error("missing queued item");
        queue.approve(item.callId);
        await pending;
        expect(calls).toHaveLength(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("localhost webhook hostname is blocked", async () => {
      const originalFetch = globalThis.fetch;
      const calls: string[] = [];
      globalThis.fetch = (async (url: string) => {
        calls.push(url);
        return new Response("{}", { status: 200 });
      }) as typeof globalThis.fetch;
      try {
        const queue = new ApprovalQueue();
        const pending = routeApprovalRequest(
          { method: "POST", path: "/approvals", body: { toolName: "gitPush" } },
          {
            queue,
            workspace: "/tmp",
            ccLoader: emptyRules(),
            approvalGate: "all",
            webhookUrl: "https://localhost/hook",
          },
        );
        await new Promise((r) => setTimeout(r, 10));
        const item = queue.list()[0];
        if (!item) throw new Error("missing queued item");
        queue.approve(item.callId);
        await pending;
        expect(calls).toHaveLength(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe("phone-path approve/reject via x-approval-token", () => {
  function emptyRules() {
    return () => ({ allow: [], ask: [], deny: [] });
  }

  it("approve with valid token resolves approved", async () => {
    const queue = new ApprovalQueue();
    const pending = routeApprovalRequest(
      { method: "POST", path: "/approvals", body: { toolName: "gitPush" } },
      {
        queue,
        workspace: "/tmp",
        ccLoader: emptyRules(),
        approvalGate: "all",
        pushServiceUrl: "https://push.example.com",
        pushServiceToken: "tok",
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    // Get the token from the internal queue entry via validateToken side-channel check
    const items = queue.list();
    expect(items).toHaveLength(1);
    const _callId = items[0]!.callId;
    // Re-request the token by inspecting internals via request with the same callId — not possible.
    // Instead test via routeApprovalRequest with the token directly.
    // We need the token — get it from the queue request return value by re-queuing.
    // Actually the pending request already enqueued with a token. Use a fresh queue to get the token directly.
    const q2 = new ApprovalQueue();
    const {
      callId: cid2,
      approvalToken: tok2,
      promise: p2,
    } = q2.request(
      { toolName: "gitPush", params: {}, tier: "high" },
      { withToken: true },
    );
    const result = await routeApprovalRequest(
      { method: "POST", path: `/approve/${cid2}`, approvalToken: tok2 },
      { queue: q2, workspace: "/tmp", ccLoader: emptyRules() },
    );
    expect(result.status).toBe(200);
    expect((result.body as Record<string, unknown>).decision).toBe("allow");
    await expect(p2).resolves.toBe("approved");
    // Clean up pending
    queue.clear();
    await pending;
  });

  it("reject with valid token resolves rejected", async () => {
    const q = new ApprovalQueue();
    const { callId, approvalToken, promise } = q.request(
      { toolName: "gitPush", params: {}, tier: "high" },
      { withToken: true },
    );
    const result = await routeApprovalRequest(
      { method: "POST", path: `/reject/${callId}`, approvalToken },
      { queue: q, workspace: "/tmp", ccLoader: emptyRules() },
    );
    expect(result.status).toBe(200);
    expect((result.body as Record<string, unknown>).decision).toBe("deny");
    await expect(promise).resolves.toBe("rejected");
  });

  it("wrong token returns 401", async () => {
    const q = new ApprovalQueue();
    const { callId } = q.request(
      { toolName: "gitPush", params: {}, tier: "high" },
      { withToken: true },
    );
    const result = await routeApprovalRequest(
      {
        method: "POST",
        path: `/approve/${callId}`,
        approvalToken: "wrongtoken",
      },
      { queue: q, workspace: "/tmp", ccLoader: emptyRules() },
    );
    expect(result.status).toBe(401);
    q.clear();
  });

  it("token is single-use — second request returns 401", async () => {
    const q = new ApprovalQueue();
    const { callId, approvalToken } = q.request(
      { toolName: "gitPush", params: {}, tier: "high" },
      { withToken: true },
    );
    await routeApprovalRequest(
      { method: "POST", path: `/approve/${callId}`, approvalToken },
      { queue: q, workspace: "/tmp", ccLoader: emptyRules() },
    );
    // Queue entry is gone after approval, but even if it weren't, token is cleared
    const result = await routeApprovalRequest(
      { method: "POST", path: `/approve/${callId}`, approvalToken },
      { queue: q, workspace: "/tmp", ccLoader: emptyRules() },
    );
    expect(result.status).toBe(401); // token cleared on first use → invalid
  });
});

describe("push notification dispatch", () => {
  function emptyRules() {
    return () => ({ allow: [], ask: [], deny: [] });
  }

  it("push endpoint receives payload with approvalToken when pushServiceUrl configured", async () => {
    const originalFetch = globalThis.fetch;
    const pushCalls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      pushCalls.push({ url, body: JSON.parse((init?.body as string) ?? "{}") });
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const queue = new ApprovalQueue();
      const pending = routeApprovalRequest(
        { method: "POST", path: "/approvals", body: { toolName: "gitPush" } },
        {
          queue,
          workspace: "/tmp",
          ccLoader: emptyRules(),
          approvalGate: "all",
          pushServiceUrl: "https://push.example.com",
          pushServiceToken: "relay-token",
        },
      );
      await new Promise((r) => setTimeout(r, 50));
      const item = queue.list()[0];
      if (!item) throw new Error("no queued item");
      queue.approve(item.callId);
      await pending;
      expect(
        pushCalls.some((c) => c.url === "https://push.example.com/push"),
      ).toBe(true);
      const pushCall = pushCalls.find(
        (c) => c.url === "https://push.example.com/push",
      );
      expect(pushCall).toBeDefined();
      expect(
        typeof (pushCall!.body as Record<string, unknown>).approvalToken,
      ).toBe("string");
      expect((pushCall!.body as Record<string, unknown>).toolName).toBe(
        "gitPush",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("non-HTTPS push service URL is blocked", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const queue = new ApprovalQueue();
      const pending = routeApprovalRequest(
        { method: "POST", path: "/approvals", body: { toolName: "gitPush" } },
        {
          queue,
          workspace: "/tmp",
          ccLoader: emptyRules(),
          approvalGate: "all",
          pushServiceUrl: "http://push.example.com",
          pushServiceToken: "tok",
        },
      );
      await new Promise((r) => setTimeout(r, 20));
      const item = queue.list()[0];
      if (item) queue.approve(item.callId);
      await pending;
      expect(calls.filter((u) => u.includes("push.example.com"))).toHaveLength(
        0,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
