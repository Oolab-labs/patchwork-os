/**
 * Bug 2: detachSoft() leaks `inFlightControllers` + `activeToolCalls` across
 * grace-period reattach.
 *
 * detachSoft() is the grace-period entry point: it intentionally preserves
 * in-flight tool calls so a reconnecting client picks up where it left off.
 * However, attach() bumps `this.generation`, and the finally clause that
 * cleans up `inFlightControllers` / `activeToolCalls` was guarded with
 * `gen === this.generation`. When the preserved tool eventually settled it
 * was running on the OLD generation, so the cleanup was skipped — leaking
 * one entry in `inFlightControllers` and one count in `activeToolCalls` per
 * reconnect.
 *
 * Worse, HTTP session eviction skips sessions with `inFlight > 0`, so a
 * leaked counter creates a zombie session that lives forever.
 *
 * Fix: detachSoft() snapshots the in-flight ids at the moment of detach.
 * The finally clause unconditionally cleans up ids in that snapshot, even
 * when the generation has flipped.
 */

import { describe, expect, it } from "vitest";
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

function attachAndHandshake(transport: McpTransport): MockWs {
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
  return ws;
}

describe("transport detachSoft leak fix", () => {
  it("clears inFlightControllers + decrements activeToolCalls when an old-gen tool settles after reattach", async () => {
    const transport = new McpTransport(new Logger(false));

    // Long-running tool. We control settlement via the resolver.
    let resolveTool: ((value: unknown) => void) | null = null;
    transport.registerTool(
      {
        name: "longTool",
        description: "long-running tool for grace-period test",
        inputSchema: { type: "object", properties: {} },
      },
      () =>
        new Promise<{ content: { type: string; text: string }[] }>(
          (resolve) => {
            resolveTool = (v: unknown) =>
              resolve(v as { content: { type: string; text: string }[] });
          },
        ),
    );

    const ws1 = attachAndHandshake(transport);

    // Kick off the tool call.
    ws1.handlers.message?.(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: { name: "longTool", arguments: {} },
        }),
      ),
    );

    // Wait until the transport has registered the in-flight controller.
    const internals = transport as unknown as {
      inFlightControllers: Map<string | number, AbortController>;
      activeToolCalls: number;
    };
    const startDeadline = Date.now() + 1000;
    while (
      !internals.inFlightControllers.has(42) &&
      Date.now() < startDeadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(internals.inFlightControllers.has(42)).toBe(true);
    expect(internals.activeToolCalls).toBe(1);

    // Simulate grace-period reconnect: detachSoft + attach (new ws, new gen).
    transport.detachSoft();
    const _ws2 = attachAndHandshake(transport);

    // Now settle the original tool call — its handler ran on the OLD gen.
    if (!resolveTool) throw new Error("tool never started");
    resolveTool({ content: [{ type: "text", text: "done" }] });

    // Wait briefly for the finally clause to run.
    await new Promise((r) => setTimeout(r, 30));

    // Without the fix, both of these leak:
    expect(internals.inFlightControllers.size).toBe(0);
    expect(internals.activeToolCalls).toBe(0);
  });
});
