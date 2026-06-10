/**
 * http-server-1: an exception thrown by the approvalGate leaked one
 * inFlightControllers slot, one inFlightToolNames slot, and permanently
 * incremented activeToolCalls per throw. After MAX_CONCURRENT_TOOLS (10)
 * throws every subsequent tool call was rejected with "Too many concurrent
 * tool calls" even though nothing was actually in flight.
 *
 * The fix wraps the approvalGate await in a try/catch that releases all three
 * state entries (generation-guarded) before rethrowing, so the outer catch
 * still builds the isError response but no state leaks.
 */

import { afterEach, describe, expect, it } from "vitest";
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

function setup(gate: () => Promise<never>) {
  const transport = new McpTransport(new Logger(false));
  transport.setApprovalGate(gate as never);

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

  return { transport, ws, send };
}

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
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for reply id=${id}`);
}

const transports: McpTransport[] = [];
afterEach(() => {
  transports.length = 0;
});

describe("approvalGate exception cleanup (http-server-1)", () => {
  it("does not leak inFlight state when the gate throws", async () => {
    const ctx = setup(async () => {
      throw new Error("gate exploded");
    });
    transports.push(ctx.transport);

    ctx.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "gitCommit", arguments: { message: "x" } },
    });
    const reply = await waitForReply(ctx.ws, 1);

    // The gate throw is surfaced as an isError tool result (MCP contract),
    // NOT a JSON-RPC error.
    expect(reply.error).toBeUndefined();
    expect((reply.result as { isError?: boolean })?.isError).toBe(true);

    const internals = ctx.transport as unknown as {
      inFlightControllers: Map<unknown, unknown>;
      inFlightToolNames: Map<unknown, unknown>;
      activeToolCalls: number;
    };
    // Pre-fix: each of these would be leaked (size 1, count 1).
    expect(internals.inFlightControllers.size).toBe(0);
    expect(internals.inFlightToolNames.size).toBe(0);
    expect(internals.activeToolCalls).toBe(0);
  });

  it("survives MAX_CONCURRENT_TOOLS gate throws without saturating the limit", async () => {
    // Pre-fix: 10 throws would permanently pin activeToolCalls at 10 and the
    // 11th call would fail with "Too many concurrent tool calls".
    const ctx = setup(async () => {
      throw new Error("gate exploded");
    });
    transports.push(ctx.transport);

    for (let i = 1; i <= 12; i++) {
      ctx.send({
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "gitCommit", arguments: { message: "x" } },
      });
      const reply = await waitForReply(ctx.ws, i);
      // Each reply is an isError tool result from the gate throw — never the
      // "Too many concurrent tool calls" JSON-RPC error.
      expect(reply.error).toBeUndefined();
      expect((reply.result as { isError?: boolean })?.isError).toBe(true);
    }

    const internals = ctx.transport as unknown as { activeToolCalls: number };
    expect(internals.activeToolCalls).toBe(0);
  });
});
