/**
 * audit P0-1 / P1-10 — Streamable-HTTP tool-timeout ceiling + typed timeout code.
 *
 * Claude Code hard-aborts remote (Streamable-HTTP) MCP tool calls after 5
 * minutes (CC 2.1.183/2.1.187). Tools that declare a longer timeoutMs (e.g.
 * vscodeTasks/terminal at 610s) would run past the abort and have their result
 * silently discarded with no isError the model can act on. The HTTP transport
 * now clamps a tool's effective timeout to `httpTimeoutCeilingMs` (~280s) so the
 * tool rejects cleanly BEFORE CC kills the call. The WebSocket transport (local
 * CLI, no such ceiling) keeps the tool's declared timeout.
 *
 * Separately (P1-10), a tool timeout now rejects with a typed
 * ToolErrorCodes.TIMEOUT code so CC's retry path can distinguish a transient
 * timeout from a deterministic failure.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ToolErrorCodes } from "../errors.js";
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

const NEVER_RESOLVES = async () => {
  await new Promise<never>(() => {}); // handler hangs → the timeout must fire
  return { content: [{ type: "text", text: "unreachable" }] };
};

function setup(
  opts: { timeoutMs?: number; ceiling?: number | null; hang?: boolean } = {},
) {
  const transport = new McpTransport(new Logger(false));
  if (opts.ceiling !== undefined) transport.httpTimeoutCeilingMs = opts.ceiling;

  transport.registerTool(
    {
      name: "slowTool",
      description: "fake long-running tool",
      inputSchema: { type: "object", properties: {} },
    },
    opts.hang
      ? NEVER_RESOLVES
      : async () => ({ content: [{ type: "text", text: "done" }] }),
    opts.timeoutMs,
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

function parsePayload(reply: McpMessage) {
  const result = reply.result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const first = result.content[0];
  if (!first) throw new Error("tool reply had no content");
  return {
    isError: result.isError,
    payload: JSON.parse(first.text) as {
      error: string;
      code?: string;
    },
  };
}

const transports: McpTransport[] = [];
afterEach(() => {
  transports.length = 0;
});

describe("getToolTimeout — httpTimeoutCeilingMs clamp (P0-1)", () => {
  it("returns the declared timeout when no ceiling is set (WebSocket transport)", () => {
    const { transport } = setup({ timeoutMs: 600_000 });
    expect(transport.getToolTimeout("slowTool")).toBe(600_000);
  });

  it("clamps a long declared timeout down to the ceiling when set (HTTP transport)", () => {
    const { transport } = setup({ timeoutMs: 600_000, ceiling: 280_000 });
    expect(transport.getToolTimeout("slowTool")).toBe(280_000);
  });

  it("leaves a declared timeout below the ceiling unchanged", () => {
    const { transport } = setup({ timeoutMs: 30_000, ceiling: 280_000 });
    expect(transport.getToolTimeout("slowTool")).toBe(30_000);
  });

  it("falls back to the default tool timeout (60s) for unknown tools", () => {
    const { transport } = setup({});
    expect(transport.getToolTimeout("nope")).toBe(60_000);
  });
});

describe("tool timeout — ceiling enforced on execution + typed code (P0-1 / P1-10)", () => {
  it("rejects a hung tool at the ceiling, not its larger declared timeout", async () => {
    // declared 5_000ms, ceiling 80ms → must reject at the 80ms ceiling.
    const ctx = setup({ timeoutMs: 5_000, ceiling: 80, hang: true });
    transports.push(ctx.transport);
    ctx.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slowTool", arguments: {} },
    });
    const reply = await waitForReply(ctx.ws, 1);
    expect(reply.error).toBeUndefined();
    const { isError, payload } = parsePayload(reply);
    expect(isError).toBe(true);
    // Capped value (80), not the declared 5000 — proves the cap hit execution.
    expect(payload.error).toContain("timed out after 80ms");
    expect(payload.code).toBe(ToolErrorCodes.TIMEOUT);
  });

  it("tags an uncapped tool timeout with ToolErrorCodes.TIMEOUT (P1-10)", async () => {
    const ctx = setup({ timeoutMs: 60, hang: true }); // no ceiling
    transports.push(ctx.transport);
    ctx.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slowTool", arguments: {} },
    });
    const reply = await waitForReply(ctx.ws, 1);
    const { isError, payload } = parsePayload(reply);
    expect(isError).toBe(true);
    expect(payload.error).toContain("timed out after 60ms");
    expect(payload.code).toBe(ToolErrorCodes.TIMEOUT);
  });
});
