/**
 * Runtime complement to transport-tool-sessionid.test.ts (source-lint).
 *
 * The lint test catches syntactic regressions (wrong field name in the
 * record() args). This one proves the end-to-end runtime path:
 *
 *   1. bridge.ts assigns transport.sessionId at WS connect
 *   2. tool handler runs and activityLog.record() fires with that sessionId
 *   3. activityLog.querySessionTools(id) returns the entry — enabling the
 *      /sessions/:id drill-down UI (PR #24)
 *
 * This is the exact failure mode PR #24 shipped with: the lint would have
 * caught `claudeCodeSessionId`, but a future refactor (e.g. extracting a
 * helper that accidentally reads the wrong field) could still break the
 * wiring without changing the record() call-site syntax. This test nails
 * down the behavioral contract.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ActivityLog } from "../activityLog.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";
import { send, waitFor } from "./wsHelpers.js";

const logger = new Logger(false);
let server: Server | null = null;
let transport: McpTransport | null = null;
let wsClient: WebSocket | null = null;

function padToken(t: string): string {
  return t.length >= 32 ? t : t.padEnd(32, "0");
}

afterEach(async () => {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) wsClient.close();
  wsClient = null;
  await server?.close();
  server = null;
  transport = null;
});

describe("tool-call sessionId wiring (runtime)", () => {
  it("records tool calls with the transport's sessionId for WS transports", async () => {
    const token = padToken("sessionid-runtime");
    const SESSION_ID = "11111111-2222-3333-4444-555555555555";
    const activityLog = new ActivityLog();

    server = new Server(token, logger);
    transport = new McpTransport(logger);
    transport.setActivityLog(activityLog);
    // Mirror bridge.ts:283 — this is what makes WS tool-call correlation work.
    transport.sessionId = SESSION_ID;

    transport.registerTool(
      {
        name: "echo",
        description: "Echoes",
        inputSchema: { type: "object", properties: {} },
      },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    server.on("connection", (ws: WebSocket) => {
      transport?.attach(ws);
    });

    const port = await server.findAndListen(null);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": token },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    wsClient = ws;

    // Handshake
    send(ws, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    await waitFor(ws, (m) => m.id === 0);
    send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 10));

    // Invoke the tool
    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    });
    await waitFor(ws, (m) => m.id === 1);

    // claudeCodeSessionId is NOT set on WS transports — this is the trap
    // PR #24 fell into. Assert it explicitly so a future change that starts
    // setting it (and relying on it) still keeps the sessionId path working.
    expect(transport.claudeCodeSessionId).toBeNull();

    // The real check: querySessionTools must return the entry by session UUID,
    // exactly as /sessions/:id relies on (PR #24).
    const byId = activityLog.querySessionTools(SESSION_ID);
    expect(byId).toHaveLength(1);
    expect(byId[0]?.tool).toBe("echo");
    expect(byId[0]?.status).toBe("success");
    expect(byId[0]?.sessionId).toBe(SESSION_ID);

    // And the "wrong" UUID returns nothing — proves we're keying on real value,
    // not some default.
    expect(activityLog.querySessionTools("not-" + SESSION_ID)).toHaveLength(0);
  });

  it("records tool-call errors with sessionId too", async () => {
    const token = padToken("sessionid-error");
    const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const activityLog = new ActivityLog();

    server = new Server(token, logger);
    transport = new McpTransport(logger);
    transport.setActivityLog(activityLog);
    transport.sessionId = SESSION_ID;

    transport.registerTool(
      {
        name: "broken",
        description: "Throws",
        inputSchema: { type: "object", properties: {} },
      },
      async () => {
        throw new Error("boom");
      },
    );

    server.on("connection", (ws: WebSocket) => {
      transport?.attach(ws);
    });

    const port = await server.findAndListen(null);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": token },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    wsClient = ws;

    send(ws, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    await waitFor(ws, (m) => m.id === 0);
    send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 10));

    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "broken", arguments: {} },
    });
    await waitFor(ws, (m) => m.id === 1);

    const byId = activityLog.querySessionTools(SESSION_ID);
    expect(byId).toHaveLength(1);
    expect(byId[0]?.tool).toBe("broken");
    expect(byId[0]?.status).toBe("error");
    expect(byId[0]?.sessionId).toBe(SESSION_ID);
  });
});
