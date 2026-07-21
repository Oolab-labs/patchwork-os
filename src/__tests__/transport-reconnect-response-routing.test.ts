/**
 * Bug: a tool call that completes AFTER a grace-period reconnect sends its
 * response on the stale, closed WebSocket instead of the reconnected
 * client's current socket.
 *
 * `detachSoft()` intentionally preserves in-flight tool calls across a
 * grace-period reconnect (see transport-detachSoft-leak.test.ts) — the
 * reconnected client is meant to receive the eventual result of a write it
 * kicked off before disconnecting. But the message listener that dispatches
 * `tools/call` closes over the `ws` parameter passed to `attach()` at the
 * time the request arrived. If the tool handler's promise resolves after a
 * `detachSoft()` + `attach(newWs)` cycle, the final `safeSend` in that
 * listener still targets the ORIGINAL (now-closed) socket — the reconnected
 * client never sees the response and may retry an already-completed write
 * (the side effect already happened; only the acknowledgement was lost).
 *
 * The dynamic-tool-dispatch branch already reroutes through `this.activeWs`
 * for exactly this reason (with a generation guard) — the tools/call path
 * didn't, and unlike the dynamic branch, a *generation* guard alone is
 * wrong here: `detachSoft()` deliberately preserves the call across the
 * generation bump, so the fix must redirect for that specific case
 * (`detachSoftInflight` / `wasSoftPreserved`), not skip sending outright.
 *
 * Fix: `respondViaActiveWs` is set when the completing call's id was
 * snapshotted by `detachSoft()`, and the final response send targets
 * `this.activeWs` instead of the closed-over `ws` in that case only — a
 * hard reconnect (unrelated new client, `detachSoftInflight` does NOT
 * contain the id) must never redirect, since that would leak a response to
 * a different client's session.
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

describe("transport reconnect response routing", () => {
  it("delivers a tool call's response on the RECONNECTED socket, not the stale one, after a grace-period reconnect", async () => {
    const transport = new McpTransport(new Logger(false));

    let resolveTool: ((value: unknown) => void) | null = null;
    transport.registerTool(
      {
        name: "writeTool",
        description: "long-running write tool for reconnect test",
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

    ws1.handlers.message?.(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: { name: "writeTool", arguments: {} },
        }),
      ),
    );

    const internals = transport as unknown as {
      inFlightControllers: Map<string | number, AbortController>;
    };
    const startDeadline = Date.now() + 1000;
    while (
      !internals.inFlightControllers.has(99) &&
      Date.now() < startDeadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(internals.inFlightControllers.has(99)).toBe(true);

    // Grace-period reconnect: detachSoft + attach(new ws).
    transport.detachSoft();
    const ws2 = attachAndHandshake(transport);

    // The call the ORIGINAL client made now settles. Read via a getter
    // (rather than the bare `resolveTool` reference) so TS's control-flow
    // analysis doesn't narrow the closure-reassigned variable to `never`
    // after the guard below.
    const getResolver = () => resolveTool;
    const resolve = getResolver();
    if (!resolve) throw new Error("tool never started");
    resolve({ content: [{ type: "text", text: "write completed" }] });

    await new Promise((r) => setTimeout(r, 30));

    // The reconnected client (ws2) must see the response...
    const ws2Response = ws2.sent
      .map((s) => JSON.parse(s) as McpMessage)
      .find((m) => m.id === 99);
    expect(ws2Response).toBeDefined();
    expect(ws2Response?.result).toMatchObject({
      content: [{ type: "text", text: "write completed" }],
    });

    // ...and the stale, disconnected socket (ws1) must NOT have received it
    // (it was sent exactly one message before the reconnect — the initial
    // handshake response already captured by attachAndHandshake — so no
    // NEW message should have arrived for id 99).
    const ws1Response = ws1.sent
      .map((s) => JSON.parse(s) as McpMessage)
      .find((m) => m.id === 99);
    expect(ws1Response).toBeUndefined();
  });

  it("does NOT redirect to a new socket after a HARD reconnect (unrelated client) — response is simply dropped, never cross-delivered", async () => {
    const transport = new McpTransport(new Logger(false));

    let resolveTool: ((value: unknown) => void) | null = null;
    transport.registerTool(
      {
        name: "writeTool",
        description: "long-running write tool for hard-reconnect test",
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

    ws1.handlers.message?.(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "writeTool", arguments: {} },
        }),
      ),
    );

    const internals = transport as unknown as {
      inFlightControllers: Map<string | number, AbortController>;
    };
    const startDeadline = Date.now() + 1000;
    while (
      !internals.inFlightControllers.has(7) &&
      Date.now() < startDeadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(internals.inFlightControllers.has(7)).toBe(true);

    // HARD detach (a genuinely different client connecting, not a
    // grace-period resumption) — detach() aborts in-flight calls and does
    // NOT snapshot them into detachSoftInflight.
    transport.detach();
    const ws2 = attachAndHandshake(transport);

    const getResolver2 = () => resolveTool;
    const resolve2 = getResolver2();
    if (!resolve2) throw new Error("tool never started");
    resolve2({ content: [{ type: "text", text: "write completed" }] });

    await new Promise((r) => setTimeout(r, 30));

    // Neither socket should have received a response keyed to the old
    // call's id — it must never be cross-delivered to the new, unrelated
    // client's session.
    const ws2Response = ws2.sent
      .map((s) => JSON.parse(s) as McpMessage)
      .find((m) => m.id === 7);
    expect(ws2Response).toBeUndefined();
  });
});
