import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityLog } from "../activityLog.js";
import {
  type ApprovedActionFacts,
  computeApprovedActionIdentity,
} from "../approvalIdentity.js";
import { Logger } from "../logger.js";
import { McpTransport } from "../transport.js";

class MockWs {
  readyState = 1;
  sent: string[] = [];
  handlers: Record<string, (arg: unknown) => void> = {};
  on(event: string, fn: (arg: unknown) => void) {
    this.handlers[event] = fn;
    return this;
  }
  off(event: string) {
    delete this.handlers[event];
    return this;
  }
  removeListener(event: string) {
    delete this.handlers[event];
    return this;
  }
  send(data: string, cb?: (err?: Error) => void) {
    this.sent.push(data);
    cb?.();
  }
  close() {
    this.readyState = 3;
  }
  ping() {}
  pong() {}
  addEventListener(event: string, fn: (arg: unknown) => void) {
    this.on(event, fn);
  }
  terminate() {
    this.close();
  }
}

async function waitForReply(ws: MockWs, id: number) {
  for (let i = 0; i < 200; i++) {
    const reply = ws.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((message) => message.id === id);
    if (reply) return reply;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`reply ${id} not received`);
}

function setup(
  gate: Parameters<McpTransport["setApprovalGate"]>[0],
  persistPath?: string,
  executeImpl?: () => Promise<{
    content: Array<{ type: string; text: string }>;
  }>,
) {
  const transport = new McpTransport(new Logger(false));
  transport.sessionId = "session-a";
  const activityLog = new ActivityLog(100);
  if (persistPath) activityLog.setPersistPath(persistPath);
  transport.setActivityLog(activityLog);
  transport.setApprovalGate(gate);
  const execute = vi.fn(
    executeImpl ??
      (async () => ({
        content: [{ type: "text", text: "done" }],
      })),
  );
  transport.registerTool(
    {
      name: "wireFunds",
      description: "test write",
      inputSchema: {
        type: "object",
        properties: {
          amount: { type: "number" },
          token: { type: "string" },
        },
        required: ["amount"],
      },
    },
    execute,
  );
  const ws = new MockWs();
  transport.attach(ws as unknown as import("ws").WebSocket);
  const send = (message: Record<string, unknown>) =>
    ws.handlers.message?.(Buffer.from(JSON.stringify(message)));
  send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { activityLog, execute, send, transport, ws };
}

function grant(facts: ApprovedActionFacts, approvalId = "approval-a") {
  return {
    decision: "approved" as const,
    approvalId,
    approvedActionIdentity: computeApprovedActionIdentity(facts),
    facts: {
      tier: facts.tier,
      correlationId: facts.correlationId,
      recipeName: facts.recipeName,
    },
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("approval identity at the MCP execution seam", () => {
  it("links an approved execution receipt even when the handler throws", async () => {
    const ctx = setup(
      async (request) =>
        grant({
          toolName: request.toolName,
          params: request.params,
          sessionId: request.sessionId,
          tier: "high",
        }),
      undefined,
      async () => {
        throw new Error("provider rejected after dispatch");
      },
    );
    ctx.send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "wireFunds",
        arguments: { amount: 100, token: "throw-path-secret" },
      },
    });
    await waitForReply(ctx.ws, 7);

    expect(ctx.execute).toHaveBeenCalledTimes(1);
    const receipt = ctx.activityLog.query({ tool: "wireFunds" })[0];
    expect(receipt).toMatchObject({
      status: "error",
      approvalId: "approval-a",
      approvalRevalidated: true,
    });
    expect(receipt?.approvedActionIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain("throw-path-secret");
  });

  it("does not treat a legacy approved string as a human execution capability", async () => {
    const ctx = setup(async () => "approved");
    ctx.send({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "wireFunds", arguments: { amount: 100 } },
    });
    expect(JSON.stringify(await waitForReply(ctx.ws, 6))).toContain(
      "approval_identity_mismatch",
    );
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("executes an exact approved action once and persists a secret-free linked receipt", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "approval-receipt-"));
    dirs.push(dir);
    const persistPath = path.join(dir, "activity.jsonl");
    const ctx = setup(
      async (request) =>
        grant({
          toolName: request.toolName,
          params: request.params,
          sessionId: request.sessionId,
          tier: "high",
        }),
      persistPath,
    );

    ctx.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "wireFunds",
        arguments: { amount: 100, token: "original-secret" },
      },
    });
    await waitForReply(ctx.ws, 1);

    expect(ctx.execute).toHaveBeenCalledTimes(1);
    const receipt = ctx.activityLog.query({ tool: "wireFunds" })[0];
    expect(receipt).toMatchObject({
      status: "success",
      approvalId: "approval-a",
      approvalRevalidated: true,
    });
    expect(receipt?.approvedActionIdentity).toMatch(/^[a-f0-9]{64}$/);

    await vi.waitFor(() =>
      expect(readFileSync(persistPath, "utf8")).toContain("approval-a"),
    );
    const raw = readFileSync(persistPath, "utf8");
    expect(raw).not.toContain("original-secret");
    const reloaded = new ActivityLog(100);
    reloaded.setPersistPath(persistPath);
    expect(reloaded.query({ tool: "wireFunds" })[0]).toMatchObject({
      approvalId: "approval-a",
      approvedActionIdentity: receipt?.approvedActionIdentity,
      approvalRevalidated: true,
    });
  });

  it("fails closed when params mutate after approval but before dispatch", async () => {
    const ctx = setup(async (request) => {
      const approved = grant({
        toolName: request.toolName,
        params: { ...request.params },
        sessionId: request.sessionId,
        tier: "high",
      });
      // Explicit barrier: this is the post-approval/pre-dispatch mutation. With
      // no immediate comparison the handler receives amount=101 and executes.
      request.params.amount = 101;
      return approved;
    });
    ctx.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "wireFunds", arguments: { amount: 100 } },
    });
    const reply = await waitForReply(ctx.ws, 2);
    expect(ctx.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(reply)).toContain("approval_identity_mismatch");
    expect(ctx.activityLog.query({ tool: "wireFunds" })).toHaveLength(0);
  });

  it.each([
    ["tool", { toolName: "otherTool" }],
    ["session", { sessionId: "session-b" }],
    ["correlation", { correlationId: "other-run" }],
    ["recipe", { recipeName: "other-recipe" }],
  ])("rejects a %s-mismatched grant", async (_label, override) => {
    const ctx = setup(async (request) =>
      grant({
        toolName: request.toolName,
        params: request.params,
        sessionId: request.sessionId,
        tier: "high",
        ...override,
      }),
    );
    ctx.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "wireFunds", arguments: { amount: 100 } },
    });
    expect(JSON.stringify(await waitForReply(ctx.ws, 3))).toContain(
      "approval_identity_mismatch",
    );
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("does not cross-link two similar approvals or collapse secret-bearing identities", async () => {
    const seen: string[] = [];
    let approvalSequence = 0;
    const ctx = setup(async (request) => {
      const approvalId = `approval-${++approvalSequence}`;
      seen.push(approvalId);
      return grant(
        {
          toolName: request.toolName,
          params: request.params,
          sessionId: request.sessionId,
          tier: "high",
        },
        approvalId,
      );
    });
    for (const [id, token] of [
      [4, "secret-a"],
      [5, "secret-b"],
    ] as const) {
      ctx.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "wireFunds", arguments: { amount: 100, token } },
      });
      await waitForReply(ctx.ws, id);
    }
    expect(seen).toEqual(["approval-1", "approval-2"]);
    const receipts = ctx.activityLog.query({ tool: "wireFunds" });
    expect(receipts.map((entry) => entry.approvalId)).toEqual(seen);
    expect(receipts[0]?.approvedActionIdentity).not.toBe(
      receipts[1]?.approvedActionIdentity,
    );
    expect(JSON.stringify(receipts)).not.toContain("secret-a");
    expect(JSON.stringify(receipts)).not.toContain("secret-b");
  });
});
