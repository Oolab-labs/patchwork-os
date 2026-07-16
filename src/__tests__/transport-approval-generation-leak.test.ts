/**
 * Regression: a resolved approval-gate decision of "rejected" / "expired" /
 * "cancelled" / "policy_denied" mutated activeToolCalls/inFlightControllers/
 * inFlightToolNames unconditionally, with no generation guard — unlike the
 * sibling gateErr catch and the resolved-tool finally clause, both of which
 * check `gen === this.generation` (or a detachSoft snapshot) before
 * touching shared state.
 *
 * If the WS hard-reconnects (new generation, counters reset) while an
 * older-generation call is still parked awaiting a human decision, and the
 * new connection's client reuses the same JSON-RPC id (common — most
 * clients start ids at 1 per connection), the stale decision settling later
 * silently corrupts the NEW generation's live call tracking: decrements its
 * activeToolCalls and deletes its inFlightControllers/inFlightToolNames
 * entries out from under an actually-in-flight call.
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

describe("transport approval-decision generation leak fix", () => {
  let transport: McpTransport;

  afterEach(() => {
    transport?.detach();
  });

  it("does not corrupt the new generation's activeToolCalls/inFlightControllers when a stale-generation rejection resolves after a hard reconnect", async () => {
    transport = new McpTransport(new Logger(false));

    let resolveGate:
      | ((
          decision:
            | "approved"
            | "rejected"
            | "expired"
            | "cancelled"
            | "bypass"
            | "policy_denied",
        ) => void)
      | null = null;
    transport.setApprovalGate(
      () =>
        new Promise<
          | "approved"
          | "rejected"
          | "expired"
          | "cancelled"
          | "bypass"
          | "policy_denied"
        >((resolve) => {
          resolveGate = (d) => resolve(d);
        }),
    );
    transport.registerTool(
      {
        name: "gatedTool",
        description: "requires approval",
        inputSchema: { type: "object", properties: {} },
      },
      async () => ({ content: [{ type: "text", text: "ran" }] }),
    );
    // A tool that isn't gated — used on the new connection so it becomes
    // in-flight without waiting on the gate.
    let resolveEcho: (() => void) | null = null;
    transport.registerTool(
      {
        name: "echo",
        description: "no approval required",
        inputSchema: { type: "object", properties: {} },
      },
      () =>
        new Promise<{ content: { type: string; text: string }[] }>(
          (resolve) => {
            resolveEcho = () =>
              resolve({ content: [{ type: "text", text: "echoed" }] });
          },
        ),
    );

    const internals = transport as unknown as {
      inFlightControllers: Map<string | number, AbortController>;
      activeToolCalls: number;
    };

    const ws1 = attachAndHandshake(transport);
    ws1.handlers.message?.(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "gatedTool", arguments: {} },
        }),
      ),
    );

    // Wait for the gated call to actually be in flight, parked on the gate.
    const deadline1 = Date.now() + 1000;
    while (!resolveGate && Date.now() < deadline1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(internals.inFlightControllers.has(1)).toBe(true);
    expect(internals.activeToolCalls).toBe(1);

    // Hard reconnect (NOT detachSoft): new generation, counters reset.
    const ws2 = attachAndHandshake(transport);

    // New connection's client reuses id=1 (typical: ids restart per connection).
    ws2.handlers.message?.(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo", arguments: {} },
        }),
      ),
    );

    const deadline2 = Date.now() + 1000;
    while (!resolveEcho && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(internals.inFlightControllers.has(1)).toBe(true);
    expect(internals.activeToolCalls).toBe(1); // new generation's own call

    // Now the STALE (old-generation) approval decision resolves.
    if (!resolveGate) throw new Error("gate never invoked");
    resolveGate("rejected");
    await new Promise((r) => setTimeout(r, 30));

    // The new generation's live call must be untouched by the stale decision.
    expect(internals.activeToolCalls).toBe(1);
    expect(internals.inFlightControllers.has(1)).toBe(true);

    // Clean up the still-pending echo call.
    resolveEcho?.();
    await new Promise((r) => setTimeout(r, 10));
  });
});
