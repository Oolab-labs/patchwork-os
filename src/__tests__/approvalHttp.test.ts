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

  describe("approval-input capture (decision-replay enabler)", () => {
    // The lifecycle row records what the policy SAW, not just what it
    // DECIDED. A future replay debugger needs (toolName, params, tier,
    // riskSignals) on every approval_decision row to fold a new policy
    // over historical inputs. Tests below pin that contract on every
    // short-circuit branch and through the queue.

    async function recordOne(
      body: Record<string, unknown>,
      ccLoader = emptyRules(),
      extraDeps: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
      const events: Array<Record<string, unknown>> = [];
      const queue = new ApprovalQueue();
      await routeApprovalRequest(
        { method: "POST", path: "/approvals", body },
        {
          queue,
          workspace: "/tmp",
          ccLoader,
          onDecision: (_, meta) => events.push(meta),
          ...extraDeps,
        },
      );
      expect(events).toHaveLength(1);
      return events[0];
    }

    it("captures params, tier, riskSignals on cc_allow_rule path", async () => {
      const meta = await recordOne(
        {
          toolName: "Bash",
          params: { command: "rm -rf /tmp/foo" },
          sessionId: "s1",
        },
        allowRules("Bash"),
      );
      expect(meta).toMatchObject({
        decision: "allow",
        reason: "cc_allow_rule",
        toolName: "Bash",
        sessionId: "s1",
        tier: "high",
        params: { command: "rm -rf /tmp/foo" },
        riskSignals: expect.arrayContaining([
          expect.objectContaining({ kind: "destructive_flag" }),
        ]),
      });
    });

    it("captures params + tier on cc_deny_rule path", async () => {
      const meta = await recordOne(
        { toolName: "gitPush", params: { remote: "origin" } },
        denyRules("gitPush"),
      );
      expect(meta).toMatchObject({
        decision: "deny",
        reason: "cc_deny_rule",
        tier: "high",
        params: { remote: "origin" },
      });
    });

    it("captures params + tier on dontAsk_mode path", async () => {
      const meta = await recordOne({
        toolName: "gitPush",
        params: { remote: "origin" },
        permissionMode: "dontAsk",
      });
      expect(meta).toMatchObject({
        reason: "dontAsk_mode",
        tier: "high",
        params: { remote: "origin" },
      });
    });

    it("captures params + tier on auto_mode path", async () => {
      const meta = await recordOne({
        toolName: "Read",
        params: { file_path: "/tmp/x.txt" },
        permissionMode: "auto",
      });
      expect(meta).toMatchObject({
        reason: "auto_mode",
        tier: "medium",
        params: { file_path: "/tmp/x.txt" },
      });
    });

    it("captures params + tier on plan_mode_read path", async () => {
      const meta = await recordOne({
        toolName: "Read",
        params: { file_path: "/tmp/x.txt" },
        permissionMode: "plan",
      });
      expect(meta).toMatchObject({
        reason: "plan_mode_read",
        tier: "medium",
        params: { file_path: "/tmp/x.txt" },
      });
    });

    it("captures params + tier on plan_mode_write path", async () => {
      const meta = await recordOne({
        toolName: "Bash",
        params: { command: "touch x" },
        permissionMode: "plan",
      });
      expect(meta).toMatchObject({
        reason: "plan_mode_write",
        tier: "high",
        params: { command: "touch x" },
      });
    });

    it("captures params + tier on gate_off path", async () => {
      const meta = await recordOne(
        { toolName: "Bash", params: { command: "ls" } },
        emptyRules(),
        { approvalGate: "off" },
      );
      expect(meta).toMatchObject({
        reason: "gate_off",
        tier: "high",
        params: { command: "ls" },
      });
    });

    it("captures params + tier on gate_below_threshold path", async () => {
      const meta = await recordOne(
        { toolName: "Read", params: { file_path: "/tmp/x" } },
        emptyRules(),
        { approvalGate: "high" },
      );
      expect(meta).toMatchObject({
        reason: "gate_below_threshold",
        tier: "medium",
        params: { file_path: "/tmp/x" },
      });
    });

    it("redacts sensitive keys in captured params (auth/token/password)", async () => {
      const meta = await recordOne(
        {
          toolName: "sendHttpRequest",
          params: {
            url: "https://example.com/api",
            headers: {
              Authorization: "Bearer sk-live-secret-xyz",
              "X-Api-Key": "hunter2",
            },
            body: { password: "p@ssw0rd", username: "alice" },
          },
        },
        allowRules("sendHttpRequest"),
      );
      expect(meta.params).toEqual({
        url: "https://example.com/api",
        headers: {
          Authorization: "[REDACTED]",
          "X-Api-Key": "[REDACTED]",
        },
        body: { password: "[REDACTED]", username: "alice" },
      });
    });

    it("omits params field entirely when caller sent no params", async () => {
      // captureForRunlog of {} returns {}; we still include it so a replay
      // can distinguish "policy saw empty params" from "row predates capture"
      const meta = await recordOne(
        { toolName: "gitPush" },
        denyRules("gitPush"),
      );
      expect(meta.params).toEqual({});
      expect(meta.tier).toBe("high");
    });

    it("includes params + tier + riskSignals on the queue (human-approval) path", async () => {
      // Drive the queue path: no CC rule + interactive permissionMode + gate
      // catches the tool. Auto-resolve so the test doesn't hang.
      const events: Array<Record<string, unknown>> = [];
      const queue = new ApprovalQueue();
      const promise = routeApprovalRequest(
        {
          method: "POST",
          path: "/approvals",
          body: {
            toolName: "Bash",
            params: { command: "sudo rm -rf /tmp/foo" },
            sessionId: "s2",
          },
        },
        {
          queue,
          workspace: "/tmp",
          ccLoader: emptyRules(),
          approvalGate: "all",
          onDecision: (_, meta) => events.push(meta),
        },
      );
      // Resolve the queued request out-of-band so the route returns.
      await new Promise((r) => setTimeout(r, 10));
      const items = queue.list();
      expect(items).toHaveLength(1);
      queue.approve(items[0].callId);
      await promise;

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        decision: "allow",
        reason: "approved",
        tier: "high",
        params: { command: "sudo rm -rf /tmp/foo" },
        riskSignals: expect.arrayContaining([
          expect.objectContaining({ kind: "destructive_flag" }),
        ]),
      });
      // callId is the queue-path-specific extra
      expect(typeof events[0].callId).toBe("string");
    });

    it("propagates personalSignals onto queued PendingApproval when ActivityLog is wired", async () => {
      // Pre-populate the activity log so the prior_approvals heuristic
      // fires (≥ 3 past approvals on the same tool). Then drive the
      // queue path and confirm queue.list() includes the signal.
      const { ActivityLog } = await import("../activityLog.js");
      const activityLog = new ActivityLog();
      for (let i = 0; i < 4; i++) {
        activityLog.recordEvent("approval_decision", {
          toolName: "Bash",
          decision: "allow",
        });
      }

      const queue = new ApprovalQueue();
      const promise = routeApprovalRequest(
        {
          method: "POST",
          path: "/approvals",
          body: {
            toolName: "Bash",
            params: { command: "ls" },
            sessionId: "s-personal",
          },
        },
        {
          queue,
          workspace: "/tmp",
          ccLoader: emptyRules(),
          approvalGate: "all",
          activityLog,
        },
      );

      await new Promise((r) => setTimeout(r, 10));
      const items = queue.list();
      expect(items).toHaveLength(1);
      expect(items[0]?.personalSignals).toBeDefined();
      const priorApprovals = items[0]?.personalSignals?.find(
        (s) => s.kind === "prior_approvals",
      );
      expect(priorApprovals).toBeDefined();
      expect(priorApprovals?.count).toBe(4);

      // Resolve so the test doesn't hang.
      const callId = items[0]?.callId;
      if (callId) queue.approve(callId);
      await promise;
    });

    it("does not include personalSignals when no ActivityLog is wired", async () => {
      // The integration is opt-in by deps. Tests that don't wire an
      // ActivityLog must still see the queue without a personalSignals
      // field — confirms the integration is non-breaking.
      const queue = new ApprovalQueue();
      const promise = routeApprovalRequest(
        {
          method: "POST",
          path: "/approvals",
          body: { toolName: "Bash", params: {} },
        },
        {
          queue,
          workspace: "/tmp",
          ccLoader: emptyRules(),
          approvalGate: "all",
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      const items = queue.list();
      expect(items).toHaveLength(1);
      expect(items[0]?.personalSignals).toBeUndefined();

      const callId = items[0]?.callId;
      if (callId) queue.approve(callId);
      await promise;
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
