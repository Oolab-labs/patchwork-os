/**
 * Bug 1: transport stats pollution from approval-gate wait time.
 *
 * Before fix: `startTime = Date.now()` was captured BEFORE the await on
 * approvalGate. When the gate rejected (or expired) the rejection branch
 * recorded a "tool" entry with status "error" and a `durationMs` that
 * included the entire human-decision wait (could be multiple minutes).
 * That polluted stats() avg/p50/p95/p99 and inflated errorCount as if a
 * real tool failure occurred.
 *
 * After fix:
 *   - approval rejections do NOT increment errorCount
 *   - approval rejections do NOT show up in activityLog.stats()[tool]
 *   - a single `approval_rejected` lifecycle entry is recorded instead
 *   - new counter `approvalRejectionCount` exposes the rejection count
 */

import { afterEach, describe, expect, it } from "vitest";
import { ActivityLog } from "../activityLog.js";
import { Logger } from "../logger.js";
import { McpTransport } from "../transport.js";

interface McpMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

class MockWs {
  readyState = 1; // OPEN
  sent: string[] = [];
  handlers: Record<string, (arg: unknown) => void> = {};
  on(event: string, fn: (arg: unknown) => void) {
    this.handlers[event] = fn;
    return this;
  }
  off(event: string, _fn: unknown) {
    delete this.handlers[event];
    return this;
  }
  removeListener(event: string, _fn: unknown) {
    delete this.handlers[event];
    return this;
  }
  send(data: string, cb?: (err?: Error) => void) {
    this.sent.push(data);
    if (cb) cb();
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

function setup(decision: "rejected" | "expired") {
  const transport = new McpTransport(new Logger(false));
  const activityLog = new ActivityLog(100);
  transport.setActivityLog(activityLog);

  let resolveGate: ((d: "rejected" | "expired") => void) | null = null;
  transport.setApprovalGate(
    () =>
      new Promise<"approved" | "rejected" | "expired" | "bypass">((resolve) => {
        // capture so the test can release the gate at a controlled moment
        resolveGate = (d) => resolve(d);
      }),
  );

  transport.registerTool(
    {
      name: "gitCommit",
      description: "fake high-tier tool",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    async () => ({ content: [{ type: "text", text: "committed" }] }),
  );

  const ws = new MockWs();
  transport.attach(ws as unknown as import("ws").WebSocket);

  const send = (msg: McpMessage) => {
    ws.handlers.message?.(Buffer.from(JSON.stringify(msg)));
  };

  // MCP handshake
  send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const release = () => {
    if (!resolveGate) {
      throw new Error("approval gate never installed");
    }
    resolveGate(decision);
  };

  return { transport, activityLog, ws, send, release };
}

const dummies: ReturnType<typeof setup>[] = [];

afterEach(() => {
  dummies.length = 0;
});

async function waitForReply(ws: MockWs, id: string | number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    for (const raw of ws.sent) {
      try {
        const parsed = JSON.parse(raw) as McpMessage;
        if (parsed.id === id) return parsed;
      } catch {
        // ignore non-JSON frames
      }
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for reply id=${id}`);
}

describe("transport stats pollution from approval rejections", () => {
  it("rejected approval: does NOT pollute activityLog tool stats", async () => {
    const ctx = setup("rejected");
    dummies.push(ctx);

    ctx.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "gitCommit", arguments: { message: "release" } },
    });

    // Hold the gate open for a non-trivial wall-clock interval — this is the
    // wait time that previously inflated avgDurationMs.
    await new Promise((r) => setTimeout(r, 50));
    ctx.release();
    await waitForReply(ctx.ws, 1);

    // No tool stats entry should exist for "gitCommit" — it never executed.
    const stats = ctx.activityLog.stats();
    expect(stats.gitCommit).toBeUndefined();

    // Exactly one lifecycle entry recording the rejection.
    const timeline = ctx.activityLog.queryTimeline();
    const lifecycle = timeline.filter(
      (e) => e.kind === "lifecycle" && e.event === "approval_rejected",
    );
    expect(lifecycle).toHaveLength(1);

    // errorCount must NOT inflate — approval rejections are not tool failures.
    const transportInternals = ctx.transport as unknown as {
      errorCount: number;
      approvalRejectionCount: number;
    };
    expect(transportInternals.errorCount).toBe(0);
    expect(transportInternals.approvalRejectionCount).toBe(1);
  });

  it("expired approval: same accounting as rejected (no error, lifecycle entry)", async () => {
    const ctx = setup("expired");
    dummies.push(ctx);

    ctx.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "gitCommit", arguments: { message: "release" } },
    });

    await new Promise((r) => setTimeout(r, 30));
    ctx.release();
    await waitForReply(ctx.ws, 2);

    const stats = ctx.activityLog.stats();
    expect(stats.gitCommit).toBeUndefined();

    const transportInternals = ctx.transport as unknown as {
      errorCount: number;
      approvalRejectionCount: number;
    };
    expect(transportInternals.errorCount).toBe(0);
    expect(transportInternals.approvalRejectionCount).toBe(1);
  });
});
