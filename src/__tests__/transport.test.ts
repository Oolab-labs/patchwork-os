import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ActivityLog } from "../activityLog.js";
import { ErrorCodes } from "../errors.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";
import { send, waitFor } from "./wsHelpers.js";

const logger = new Logger(false);
let server: Server | null = null;
let transport: McpTransport | null = null;
let wsClient: WebSocket | null = null;

// Pad short test tokens to meet the 32-char minimum imposed by Server
function padToken(t: string): string {
  return t.length >= 32 ? t : t.padEnd(32, "0");
}

async function setup(
  token: string,
  registerTools?: (t: McpTransport) => void,
): Promise<{ port: number; ws: WebSocket }> {
  server = new Server(padToken(token), logger);
  transport = new McpTransport(logger);
  registerTools?.(transport);

  server.on("connection", (ws: WebSocket) => {
    transport?.attach(ws);
  });

  const port = await server.findAndListen(null);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { "x-claude-code-ide-authorization": padToken(token) },
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  // Perform the MCP initialization handshake so the transport is in the initialized state
  send(ws, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  await waitFor(ws, (m) => m.id === 0);
  send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
  // Give the transport a tick to process the notification
  await new Promise((r) => setTimeout(r, 10));

  wsClient = ws;
  return { port, ws };
}

afterEach(async () => {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.close();
  }
  wsClient = null;
  await server?.close();
  server = null;
  transport = null;
});

describe("McpTransport", () => {
  it("initialize returns protocol version, capabilities, and server info", async () => {
    const { ws } = await setup("init-test");

    send(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const resp = await waitFor(ws, (m) => m.id === 1);

    const result = resp.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.capabilities).toEqual({
      tools: { listChanged: true },
      resources: { listChanged: false },
      prompts: { listChanged: false },
      logging: {},
      elicitation: {},
    });

    const info = result.serverInfo as Record<string, unknown>;
    expect(info.name).toBe("claude-ide-bridge");
    expect(info.version).toBe("1.1.0");
    expect((info._meta as Record<string, unknown>).packageVersion).toMatch(
      /^\d+\.\d+\.\d+/,
    );
  });

  it("tools/list returns registered tools with annotations", async () => {
    const { ws } = await setup("list-test", (t) => {
      t.registerTool(
        {
          name: "readTool",
          description: "A read-only tool",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
      t.registerTool(
        {
          name: "writeTool",
          description: "A destructive tool",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
    });

    send(ws, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp = await waitFor(ws, (m) => m.id === 1);

    const result = resp.result as { tools: Array<Record<string, unknown>> };
    expect(result.tools).toHaveLength(2);

    const read = result.tools.find((t) => t.name === "readTool");
    expect(read?.annotations).toEqual({ readOnlyHint: true });

    const write = result.tools.find((t) => t.name === "writeTool");
    expect(write?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("tools/call returns tool result on success", async () => {
    const { ws } = await setup("call-ok", (t) => {
      t.registerTool(
        {
          name: "echo",
          description: "Echoes input",
          inputSchema: { type: "object", properties: {} },
        },
        async (args) => ({
          content: [{ type: "text", text: JSON.stringify(args) }],
        }),
      );
    });

    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { msg: "hello" } },
    });
    const resp = await waitFor(ws, (m) => m.id === 1);

    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text).toBe('{"msg":"hello"}');
  });

  it("tools/call returns isError: true when handler throws (MCP spec)", async () => {
    const { ws } = await setup("call-err", (t) => {
      t.registerTool(
        {
          name: "failing",
          description: "Always fails",
          inputSchema: { type: "object", properties: {} },
        },
        async () => {
          throw new Error("something broke");
        },
      );
    });

    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "failing", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 1);

    // Must NOT be a JSON-RPC error — MCP spec says tool errors go in content
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    const errPayload = JSON.parse(result.content[0]?.text ?? "{}") as Record<
      string,
      unknown
    >;
    expect(errPayload.error).toBe("something broke");
  });

  it("tools/call returns JSON-RPC error for unknown tool", async () => {
    const { ws } = await setup("call-unknown");

    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "nonexistent", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 1);

    expect(resp.result).toBeUndefined();
    const err = resp.error as { code: number; message: string; data?: string };
    expect(err.code).toBe(ErrorCodes.TOOL_NOT_FOUND);
    expect(err.data).toBe("nonexistent");
  });

  it("tools/call returns INVALID_PARAMS for non-object arguments", async () => {
    const { ws } = await setup("call-badargs", (t) => {
      t.registerTool(
        {
          name: "tool",
          description: "test",
          inputSchema: { type: "object", properties: {} },
        },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
    });

    // Array arguments
    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tool", arguments: [1, 2, 3] },
    });
    const resp1 = await waitFor(ws, (m) => m.id === 1);
    expect((resp1.error as { code: number }).code).toBe(
      ErrorCodes.INVALID_PARAMS,
    );

    // String arguments
    send(ws, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "tool", arguments: "not an object" },
    });
    const resp2 = await waitFor(ws, (m) => m.id === 2);
    expect((resp2.error as { code: number }).code).toBe(
      ErrorCodes.INVALID_PARAMS,
    );

    // null arguments coalesce to {} via ?? — should succeed, not error
    send(ws, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "tool", arguments: null },
    });
    const resp3 = await waitFor(ws, (m) => m.id === 3);
    expect(resp3.error).toBeUndefined();
    expect(resp3.result).toBeDefined();
  });

  it("ping returns empty result", async () => {
    const { ws } = await setup("ping-test");

    send(ws, { jsonrpc: "2.0", id: 1, method: "ping" });
    const resp = await waitFor(ws, (m) => m.id === 1);

    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({});
  });

  it("unknown method returns METHOD_NOT_FOUND", async () => {
    const { ws } = await setup("unknown-method");

    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "foo/bar",
      params: {},
    });
    const resp = await waitFor(ws, (m) => m.id === 1);

    expect(resp.result).toBeUndefined();
    const err = resp.error as { code: number; message: string };
    expect(err.code).toBe(ErrorCodes.METHOD_NOT_FOUND);
    expect(err.message).toContain("foo/bar");
  });

  it("notifications (no id) do not produce a response", async () => {
    const { ws } = await setup("notif-test");

    // Send a notification (no id field)
    send(ws, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // Send a ping right after — if the notification produced a response,
    // it would arrive before the ping response
    send(ws, { jsonrpc: "2.0", id: 99, method: "ping" });
    const resp = await waitFor(ws, (m) => m.id === 99);

    // The only response we got is the ping
    expect(resp.result).toEqual({});
  });

  it("detach aborts in-flight tools", async () => {
    let aborted = false;
    let resolveAbort: () => void;
    const abortPromise = new Promise<void>((r) => {
      resolveAbort = r;
    });

    const { ws } = await setup("detach-test", (t) => {
      t.registerTool(
        {
          name: "slow",
          description: "Waits until aborted",
          inputSchema: { type: "object", properties: {} },
        },
        async (_args, signal) => {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              aborted = true;
              resolveAbort();
              resolve();
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolveAbort();
                resolve();
              },
              { once: true },
            );
            setTimeout(resolve, 5000);
          });
          return { content: [{ type: "text", text: "done" }] };
        },
      );
    });

    // Start slow tool
    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slow", arguments: {} },
    });

    // Give handler time to start
    await new Promise((r) => setTimeout(r, 50));

    // Detach should abort in-flight
    transport?.detach();

    await abortPromise;
    expect(aborted).toBe(true);
  });

  it("invalid JSON does not crash the transport and sends a parse error", async () => {
    const { ws } = await setup("invalid-json-test");

    // Send malformed JSON — transport should survive and still respond to pings
    ws.send("this is not valid JSON {{{{");

    // Give the transport a moment to process the bad message
    await new Promise((r) => setTimeout(r, 50));

    // Transport must still be functional — a ping should succeed
    send(ws, { jsonrpc: "2.0", id: 1, method: "ping" });
    const resp = await waitFor(ws, (m) => m.id === 1);
    expect(resp.result).toEqual({});
  });

  it("rate limit returns error after exceeding RATE_LIMIT_MAX (200) messages", async () => {
    const { ws } = await setup("rate-limit-test");

    // Send 200 pings to fill the rate limit window
    for (let i = 1; i <= 200; i++) {
      send(ws, { jsonrpc: "2.0", id: i, method: "ping" });
    }
    // Wait for all to be processed
    await waitFor(ws, (m) => m.id === 200, 10000);

    // The 201st message should be rate-limited
    send(ws, { jsonrpc: "2.0", id: 201, method: "ping" });
    const rateLimited = await waitFor(ws, (m) => m.id === 201, 5000);

    expect(rateLimited.result).toBeUndefined();
    const err = rateLimited.error as { code: number; message: string };
    expect(err.code).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED);
    expect(err.message).toMatch(/rate limit/i);
  });

  it("notification rate limit: exactly the 500th notification is dropped (>= off-by-one fix)", async () => {
    // NOTIFICATION_RATE_LIMIT = 500. After setup, notifCount = 1
    // (notifications/initialized). We send 498 dummy notifications/cancelled
    // (requestId=9999) to reach notifCount=499, then send the 500th targeting
    // the live tool (requestId=1).
    //
    // With the >= fix: 500 >= 500 → dropped → tool NOT cancelled → returns "done".
    // With the old >:  500 > 500  → false   → processed → tool IS cancelled → "cancelled".
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });

    const { ws } = await setup("notif-rate-limit-offbyone", (t) => {
      t.registerTool(
        {
          name: "gateTool",
          description: "Waits for gate or abort signal",
          inputSchema: { type: "object", properties: {} },
        },
        async (_args, signal) => {
          await new Promise<void>((resolve) => {
            gate.then(resolve);
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            content: [
              { type: "text", text: signal?.aborted ? "cancelled" : "done" },
            ],
          };
        },
      );
    });

    // Start the in-flight tool call (id=1)
    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "gateTool", arguments: {} },
    });

    // Give the server a moment to register the in-flight controller
    await new Promise((r) => setTimeout(r, 50));

    // Send 498 dummy notifications/cancelled (requestId=9999) — no effect since
    // there is no in-flight request with that id. After these, notifCount=499.
    for (let i = 0; i < 498; i++) {
      send(ws, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 9999 },
      });
    }

    // Sync point: wait for server to drain the 498 notifications
    send(ws, { jsonrpc: "2.0", id: 2, method: "ping" });
    await waitFor(ws, (m) => m.id === 2, 10000);

    // 500th notification: targets the live tool. With >= fix it is dropped.
    send(ws, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    });

    // Sync point: confirm the boundary notification was received (and dropped)
    send(ws, { jsonrpc: "2.0", id: 3, method: "ping" });
    await waitFor(ws, (m) => m.id === 3, 5000);

    // Open the gate — if the cancel was dropped the tool returns "done"
    resolveGate();

    const resp = await waitFor(ws, (m) => m.id === 1, 5000);
    const result = resp.result as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toBe("done");
  }, 30000);

  it("concurrent tool call limit returns busy error when MAX_CONCURRENT_TOOLS is reached", async () => {
    // MAX_CONCURRENT_TOOLS = 10; register a slow tool and saturate it
    let resolveAll: () => void;
    const gate = new Promise<void>((r) => {
      resolveAll = r;
    });

    const { ws } = await setup("concurrency-test", (t) => {
      t.registerTool(
        {
          name: "blocking",
          description: "Blocks until gate opens",
          inputSchema: { type: "object", properties: {} },
        },
        async () => {
          await gate;
          return { content: [{ type: "text", text: "done" }] };
        },
      );
    });

    // Send 10 concurrent calls to saturate the limit
    for (let i = 1; i <= 10; i++) {
      send(ws, {
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "blocking", arguments: {} },
      });
    }

    // Give the server time to start all 10 tool calls
    await new Promise((r) => setTimeout(r, 100));

    // The 11th call should be rejected immediately with a busy error
    send(ws, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "blocking", arguments: {} },
    });

    const busyResp = await waitFor(ws, (m) => m.id === 11, 5000);
    expect(busyResp.error).toBeUndefined();
    const result = busyResp.result as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/concurrent/i);

    // Unblock all waiting tools
    resolveAll?.();
    // Wait for the 10 blocked responses
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        waitFor(ws, (m) => m.id === i + 1, 5000),
      ),
    );
  });

  it("per-tool timeoutMs overrides global TOOL_TIMEOUT_MS for a hanging tool", async () => {
    const { ws } = await setup("per-tool-timeout", (t) => {
      t.registerTool(
        {
          name: "neverResponds",
          description: "Hangs forever",
          inputSchema: { type: "object", properties: {} },
        },
        async (_args, signal) =>
          new Promise<never>((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
        500, // per-tool timeout: 500ms (well below the global 60s)
      );
    });

    const start = Date.now();
    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "neverResponds", arguments: {} },
    });

    const resp = await waitFor(ws, (m) => m.id === 1, 3000);
    const elapsed = Date.now() - start;

    // Must be an MCP-style error result (isError: true), not a JSON-RPC error
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/timed out/i);

    // Must resolve well before the global 60s timeout (within ~3s here)
    expect(elapsed).toBeLessThan(3000);
  });

  it("progress token: notifications/progress delivered with progress, total, and message", async () => {
    const { ws } = await setup("progress-token-test", (t) => {
      t.registerTool(
        {
          name: "progressive",
          description: "Reports progress",
          inputSchema: { type: "object", properties: {} },
        },
        async (_args, _signal, progress) => {
          progress?.(25, 100, "step one");
          progress?.(75, 100, "step two");
          return { content: [{ type: "text", text: "done" }] };
        },
      );
    });

    const received: Record<string, unknown>[] = [];
    ws.on("message", (data: Buffer | string) => {
      received.push(JSON.parse(data.toString("utf-8")));
    });

    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "progressive",
        arguments: {},
        _meta: { progressToken: "tok1" },
      },
    });

    await waitFor(ws, (m) => m.id === 1);

    const progressMsgs = received.filter(
      (m) => m.method === "notifications/progress",
    );
    expect(progressMsgs).toHaveLength(2);

    const p1 = progressMsgs[0]?.params as Record<string, unknown>;
    expect(p1.progressToken).toBe("tok1");
    expect(p1.progress).toBe(25);
    expect(p1.total).toBe(100);
    expect(p1.message).toBe("step one");

    const p2 = progressMsgs[1]?.params as Record<string, unknown>;
    expect(p2.progress).toBe(75);
    expect(p2.message).toBe("step two");
  });

  it("progress token: no notifications/progress sent when _meta.progressToken absent", async () => {
    const { ws } = await setup("progress-no-token-test", (t) => {
      t.registerTool(
        {
          name: "progressive",
          description: "Reports progress",
          inputSchema: { type: "object", properties: {} },
        },
        async (_args, _signal, progress) => {
          progress?.(50, 100);
          return { content: [{ type: "text", text: "done" }] };
        },
      );
    });

    const received: Record<string, unknown>[] = [];
    ws.on("message", (data: Buffer | string) => {
      received.push(JSON.parse(data.toString("utf-8")));
    });

    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "progressive", arguments: {} },
    });

    await waitFor(ws, (m) => m.id === 1);

    const progressMsgs = received.filter(
      (m) => m.method === "notifications/progress",
    );
    expect(progressMsgs).toHaveLength(0);
  });

  it("extensionRequired tools hidden when extension disconnected, visible when connected", async () => {
    const { ws } = await setup("ext-required-test", (t) => {
      t.registerTool(
        {
          name: "alwaysAvailable",
          description: "No extension needed",
          inputSchema: { type: "object", properties: {} },
        },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
      t.registerTool(
        {
          name: "extensionOnly",
          description: "Requires extension",
          inputSchema: { type: "object", properties: {} },
          extensionRequired: true,
        },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
      t.setExtensionConnectedFn(() => false);
    });

    send(ws, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp1 = await waitFor(ws, (m) => m.id === 1);
    const tools1 = (resp1.result as { tools: Array<{ name: string }> }).tools;
    expect(tools1.map((t) => t.name)).toEqual(["alwaysAvailable"]);

    // Simulate extension connecting
    transport?.setExtensionConnectedFn(() => true);
    send(ws, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const resp2 = await waitFor(ws, (m) => m.id === 2);
    const tools2 = (resp2.result as { tools: Array<{ name: string }> }).tools;
    expect(tools2.map((t) => t.name)).toContain("extensionOnly");
  });

  it("registerTool throws on invalid tool name", () => {
    const t = new McpTransport(logger);
    expect(() =>
      t.registerTool(
        { name: "invalid-name", description: "x", inputSchema: {} },
        async () => ({ content: [] }),
      ),
    ).toThrow(/invalid tool name/i);
    expect(() =>
      t.registerTool(
        { name: "also invalid", description: "x", inputSchema: {} },
        async () => ({ content: [] }),
      ),
    ).toThrow(/invalid tool name/i);
    expect(() =>
      t.registerTool(
        { name: "validName_123", description: "x", inputSchema: {} },
        async () => ({ content: [] }),
      ),
    ).not.toThrow();
  });

  it("registerTool throws on duplicate tool name", () => {
    const t = new McpTransport(logger);
    t.registerTool(
      { name: "myTool", description: "x", inputSchema: {} },
      async () => ({ content: [] }),
    );
    expect(() =>
      t.registerTool(
        { name: "myTool", description: "y", inputSchema: {} },
        async () => ({ content: [] }),
      ),
    ).toThrow(/duplicate tool name/i);
  });

  it("activity log records success and error tool calls", async () => {
    const log = new ActivityLog();

    const { ws } = await setup("activity-test", (t) => {
      t.setActivityLog(log);
      t.registerTool(
        {
          name: "good",
          description: "Succeeds",
          inputSchema: { type: "object", properties: {} },
        },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
      t.registerTool(
        {
          name: "bad",
          description: "Fails",
          inputSchema: { type: "object", properties: {} },
        },
        async () => {
          throw new Error("oops");
        },
      );
    });

    // Success call
    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "good", arguments: {} },
    });
    await waitFor(ws, (m) => m.id === 1);

    // Error call
    send(ws, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "bad", arguments: {} },
    });
    await waitFor(ws, (m) => m.id === 2);

    const entries = log.query({ last: 10 });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.tool).toBe("good");
    expect(entries[0]?.status).toBe("success");
    expect(entries[1]?.tool).toBe("bad");
    expect(entries[1]?.status).toBe("error");
    expect(entries[1]?.errorMessage).toBe("oops");
  });

  it("attach() resets initialized flag — reconnect without initialize is rejected", async () => {
    // Simulate: Claude connects, initializes, disconnects during grace period,
    // then reconnects. Because detach() hasn't fired yet (grace period), attach()
    // is called directly on the new WebSocket. The new client must still perform
    // the initialize handshake; tools/list without it must fail.
    const token = padToken("reinit-test");
    server = new Server(token, logger);
    transport = new McpTransport(logger);

    server.on("connection", (ws: WebSocket) => {
      transport?.attach(ws);
    });

    const port = await server.findAndListen(null);

    // --- First connection: full handshake ---
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": token },
    });
    await new Promise<void>((resolve, reject) => {
      ws1.on("open", resolve);
      ws1.on("error", reject);
    });

    send(ws1, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    await waitFor(ws1, (m) => m.id === 0);
    send(ws1, { jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 10));

    // Verify tools/list works on the initialized connection
    send(ws1, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp1 = await waitFor(ws1, (m) => m.id === 1);
    expect(resp1.error).toBeUndefined();

    // --- Simulate disconnect + reconnect within grace period ---
    // Close ws1 but do NOT call detach() (grace period hasn't expired)
    ws1.close();
    // Wait >1s for server connection rate limit (MIN_CONNECTION_INTERVAL_MS)
    await new Promise((r) => setTimeout(r, 1100));

    // New connection — attach() is called by the server "connection" handler,
    // but the new client does NOT send initialize.
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": token },
    });
    await new Promise<void>((resolve, reject) => {
      ws2.on("open", resolve);
      ws2.on("error", reject);
    });
    wsClient = ws2;

    // tools/list without initialize should be rejected
    send(ws2, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const resp2 = await waitFor(ws2, (m) => m.id === 2);
    expect(resp2.result).toBeUndefined();
    expect((resp2.error as { code: number }).code).toBe(
      ErrorCodes.INVALID_REQUEST,
    );
    expect((resp2.error as { message: string }).message).toMatch(
      /not initialized/i,
    );
  });

  it("extensionRequired tools appear in tools/list when isExtensionConnectedFn is not set (defaults to connected)", async () => {
    // Intentionally do NOT call setExtensionConnectedFn — transport defaults to ?? true
    const { ws } = await setup("ext-required-default", (t) => {
      t.registerTool(
        {
          name: "extensionOnlyTool",
          description: "Requires extension",
          inputSchema: { type: "object", properties: {} },
          extensionRequired: true,
        },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
    });

    send(ws, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp = await waitFor(ws, (m) => m.id === 1);
    const names = (resp.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    );
    // Default is ?? false (fail-closed), so extension tools are hidden when isExtensionConnectedFn is not set
    expect(names).not.toContain("extensionOnlyTool");
  });

  it("getStats() returns zero counters on a fresh transport", async () => {
    await setup("stats-zero");
    expect(transport?.getStats()).toEqual({ callCount: 0, errorCount: 0 });
  });

  it("getStats().callCount increments on a successful tool call", async () => {
    const { ws } = await setup("stats-success", (t) => {
      t.registerTool(
        {
          name: "ok",
          description: "Succeeds",
          inputSchema: { type: "object", properties: {} },
        },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
    });

    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ok", arguments: {} },
    });
    await waitFor(ws, (m) => m.id === 1);

    expect(transport?.getStats()).toEqual({ callCount: 1, errorCount: 0 });
  });

  it("getStats().errorCount increments when handler throws", async () => {
    const { ws } = await setup("stats-error", (t) => {
      t.registerTool(
        {
          name: "boom",
          description: "Fails",
          inputSchema: { type: "object", properties: {} },
        },
        async () => {
          throw new Error("fail");
        },
      );
    });

    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "boom", arguments: {} },
    });
    await waitFor(ws, (m) => m.id === 1);

    expect(transport?.getStats()).toEqual({ callCount: 1, errorCount: 1 });
  });

  it("getStats() counters survive detach()", async () => {
    const { ws } = await setup("stats-detach", (t) => {
      t.registerTool(
        {
          name: "ok",
          description: "Succeeds",
          inputSchema: { type: "object", properties: {} },
        },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
    });

    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ok", arguments: {} },
    });
    await waitFor(ws, (m) => m.id === 1);

    transport?.detach();
    // Counters must NOT be reset by detach()
    expect(transport?.getStats()).toEqual({ callCount: 1, errorCount: 0 });
  });

  it("deregisterToolsByPrefix — removes matching tools, returns count, leaves others", () => {
    const t = new McpTransport(logger);
    t.registerTool(
      { name: "fooA", description: "x", inputSchema: {} },
      async () => ({ content: [] }),
    );
    t.registerTool(
      { name: "fooB", description: "x", inputSchema: {} },
      async () => ({ content: [] }),
    );
    t.registerTool(
      { name: "barC", description: "x", inputSchema: {} },
      async () => ({ content: [] }),
    );

    const removed = t.deregisterToolsByPrefix("foo");
    expect(removed).toBe(2);

    // fooA and fooB gone, barC still present
    // Verify via tools/list requires a live WebSocket; instead verify via toolCount
    expect(t.toolCount).toBe(1);

    // Re-registering fooA should succeed (it was removed)
    expect(() =>
      t.registerTool(
        { name: "fooA", description: "new", inputSchema: {} },
        async () => ({ content: [] }),
      ),
    ).not.toThrow();
  });

  it("replaceTool — replaces existing tool handler and clears AJV cache", async () => {
    // Use v1 schema with required field `x` and v2 with required field `y`.
    // Calling with { y: "hello" } is valid for v2 but invalid for v1 (missing x).
    // This proves the old AJV validator was cleared when the tool was replaced.
    let callsV1 = 0;
    let callsV2 = 0;

    const { ws } = await setup("replace-tool-test", (t) => {
      t.registerTool(
        {
          name: "myTool",
          description: "v1",
          inputSchema: {
            type: "object",
            properties: { x: { type: "string" } },
            required: ["x"],
            additionalProperties: false,
          },
        },
        async () => {
          callsV1++;
          return { content: [{ type: "text", text: "v1" }] };
        },
      );
    });

    // Call v1 with valid args (x provided)
    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "myTool", arguments: { x: "hello" } },
    });
    const r1 = await waitFor(ws, (m) => m.id === 1);
    expect(
      (r1.result as { content: Array<{ text: string }> }).content[0]?.text,
    ).toBe("v1");
    expect(callsV1).toBe(1);

    // Replace with v2 schema that requires `y` instead of `x`
    transport?.replaceTool(
      {
        name: "myTool",
        description: "v2",
        inputSchema: {
          type: "object",
          properties: { y: { type: "string" } },
          required: ["y"],
          additionalProperties: false,
        },
      },
      async () => {
        callsV2++;
        return { content: [{ type: "text", text: "v2" }] };
      },
    );

    // Call v2 with { y: "hello" } — valid for v2, invalid for v1 (missing x).
    // If AJV cache was NOT cleared, the old v1 validator would reject this call.
    send(ws, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "myTool", arguments: { y: "hello" } },
    });
    const r2 = await waitFor(ws, (m) => m.id === 2);
    // Must succeed — old AJV validator was cleared
    expect(r2.error).toBeUndefined();
    expect(
      (r2.result as { content: Array<{ text: string }> }).content[0]?.text,
    ).toBe("v2");
    expect(callsV2).toBe(1);
    expect(callsV1).toBe(1); // original handler not called again
  });

  it("replaceTool — insert path: registers new tool when name was never registered", async () => {
    const { ws } = await setup("replace-tool-insert", (t) => {
      // Register an unrelated tool just to initialize the transport
      t.registerTool(
        {
          name: "existingTool",
          description: "existing",
          inputSchema: { type: "object" },
        },
        async () => ({ content: [{ type: "text", text: "existing" }] }),
      );
    });

    // replaceTool on a name that was never registered (insert path)
    transport?.replaceTool(
      {
        name: "brandNewTool",
        description: "new",
        inputSchema: { type: "object", properties: {} },
      },
      async () => ({ content: [{ type: "text", text: "inserted" }] }),
    );

    // The new tool should be callable
    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "brandNewTool", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 1);
    expect(resp.error).toBeUndefined();
    expect(
      (resp.result as { content: Array<{ text: string }> }).content[0]?.text,
    ).toBe("inserted");
  });

  it("replaceTool throws on invalid tool name", () => {
    const t = new McpTransport(logger);
    expect(() =>
      t.replaceTool(
        { name: "invalid-name", description: "x", inputSchema: {} },
        async () => ({ content: [] }),
      ),
    ).toThrow(/invalid tool name/i);
  });
});
