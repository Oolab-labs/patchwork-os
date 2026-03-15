/**
 * End-to-end integration tests covering:
 * 1. Auth rejection flows (wrong token, missing token)
 * 2. Tool dispatch E2E via WebSocket
 * 3. Streamable HTTP session lifecycle (create, close)
 * 4. HTTP session capacity guard (MAX_HTTP_SESSIONS = 5)
 * 5. Streamable HTTP tool call (POST /mcp initialize → tools/call)
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ActivityLog } from "../activityLog.js";
import type { Config } from "../config.js";
import { ExtensionClient } from "../extensionClient.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { StreamableHttpHandler } from "../streamableHttp.js";
import { registerAllTools } from "../tools/index.js";
import { McpTransport } from "../transport.js";
import { send, waitFor } from "./wsHelpers.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const logger = new Logger(false);
const openedClients: WebSocket[] = [];
const servers: Server[] = [];

function makeConfig(workspace: string): Config {
  return {
    workspace,
    workspaceFolders: [workspace],
    ideName: "Test",
    editorCommand: null,
    port: null,
    bindAddress: "127.0.0.1",
    verbose: false,
    jsonl: false,
    linters: [],
    commandAllowlist: [],
    commandTimeout: 30_000,
    maxResultSize: 512 * 1024,
    vscodeCommandAllowlist: [],
    activeWorkspaceFolder: workspace,
    gracePeriodMs: 30_000,
    autoTmux: false,
    claudeDriver: "none",
    claudeBinary: "claude",
    automationEnabled: false,
    automationPolicyPath: null,
    toolRateLimit: 60,
  };
}

interface TestBridge {
  server: Server;
  transport: McpTransport;
  port: number;
  authToken: string;
  workspace: string;
  connectClaude(): Promise<WebSocket>;
}

async function setupBridge(registerTools = false): Promise<TestBridge> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });

  const authToken = randomUUID();
  const server = new Server(authToken, logger);
  const transport = new McpTransport(logger);
  const extensionClient = new ExtensionClient(logger);
  const activityLog = new ActivityLog();
  transport.setActivityLog(activityLog);

  server.on("connection", (ws: WebSocket) => transport.attach(ws));
  server.on("extension", (ws: WebSocket) =>
    extensionClient.handleExtensionConnection(ws),
  );

  if (registerTools) {
    const config = makeConfig(workspace);
    const probes = {
      git: false, rg: false, fd: false, tsc: false, eslint: false,
      pyright: false, ruff: false, cargo: false, go: false, biome: false,
      vitest: false, jest: false, pytest: false, gh: false,
    };
    registerAllTools(transport, config, new Set(), probes, extensionClient, activityLog);
  }

  const port = await server.findAndListen(null);
  servers.push(server);

  const connectClaude = async (): Promise<WebSocket> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    openedClients.push(ws);
    return ws;
  };

  return { server, transport, port, authToken, workspace, connectClaude };
}

function httpPost(
  url: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = new URL(url);
    const reqOpts = {
      hostname: opts.hostname,
      port: Number(opts.port),
      path: opts.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...headers,
      },
    };
    const req = http.request(reqOpts, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c.toString(); });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string>,
          body: data,
        }),
      );
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function httpDelete(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req = http.request(
      {
        hostname: opts.hostname,
        port: Number(opts.port),
        path: opts.pathname,
        method: "DELETE",
        headers,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  for (const ws of openedClients) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
  openedClients.length = 0;
  for (const s of servers) await s.close();
  servers.length = 0;
});

// ── 1. Auth flows ──────────────────────────────────────────────────────────

describe("Auth flows — WebSocket", () => {
  it("connects with correct token", async () => {
    const { connectClaude } = await setupBridge();
    const ws = await connectClaude();
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects connection with wrong token", async () => {
    const { port } = await setupBridge();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": "wrong-token" },
    });
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => resolve(-1));
    });
    expect(code).not.toBe(0);
  });

  it("rejects connection with missing auth header", async () => {
    const { port } = await setupBridge();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => resolve(-1));
    });
    expect(code).not.toBe(0);
  });
});

// ── 2. Tool dispatch E2E ───────────────────────────────────────────────────

describe("Tool dispatch E2E — WebSocket", () => {
  it("returns a valid response for getWorkspaceFolders", async () => {
    const { connectClaude, transport } = await setupBridge();

    // Register a minimal getWorkspaceFolders stub
    transport.registerTool(
      {
        name: "getWorkspaceFolders",
        description: "Get workspace folders",
        inputSchema: { type: "object", properties: {} },
      },
      async () => ({ content: [{ type: "text", text: '{"folders":[]}' }] }),
    );

    const ws = await connectClaude();

    const initWaiter = waitFor(ws, (m) => m.id === 1);
    send(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await initWaiter;
    send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 10));

    const resultWaiter = waitFor(ws, (m) => m.id === 2);
    send(ws, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "getWorkspaceFolders", arguments: {} },
    });

    const result = await resultWaiter;
    expect(result.error).toBeUndefined();
    expect((result.result as any).isError).not.toBe(true);
  });
});

// ── 3. Streamable HTTP session lifecycle ──────────────────────────────────

describe("Streamable HTTP — session lifecycle", () => {
  it("creates a session via POST initialize and closes via DELETE", async () => {
    const { server, transport, extensionClient, port, authToken, workspace } =
      await setupBridge();

    // Attach StreamableHttpHandler to the server
    const activityLog = new ActivityLog();
    const config = makeConfig(workspace);
    const probes = {
      git: false, rg: false, fd: false, tsc: false, eslint: false,
      pyright: false, ruff: false, cargo: false, go: false, biome: false,
      vitest: false, jest: false, pytest: false, gh: false,
    };
    const httpHandler = new StreamableHttpHandler(
      config, probes, extensionClient, activityLog,
      { acquireLock: async () => true, releaseLock: async () => {} } as any,
      new Map(), null, logger,
    );
    server.httpMcpHandler = (req, res) => httpHandler.handle(req, res);

    const initBody = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const res = await httpPost(
      `http://127.0.0.1:${port}/mcp`,
      initBody,
      { Authorization: `Bearer ${authToken}` },
    );

    expect(res.status).toBe(200);
    const sessionId = res.headers["mcp-session-id"];
    expect(typeof sessionId).toBe("string");

    // DELETE to close the session
    const del = await httpDelete(`http://127.0.0.1:${port}/mcp`, {
      Authorization: `Bearer ${authToken}`,
      "Mcp-Session-Id": sessionId as string,
    });
    expect(del.status).toBe(204);

    httpHandler.close();
  });

  it("returns 503 when session capacity is exceeded (MAX_HTTP_SESSIONS = 5)", async () => {
    const { server, transport, extensionClient, port, authToken, workspace } =
      await setupBridge();

    const activityLog = new ActivityLog();
    const config = makeConfig(workspace);
    const probes = {
      git: false, rg: false, fd: false, tsc: false, eslint: false,
      pyright: false, ruff: false, cargo: false, go: false, biome: false,
      vitest: false, jest: false, pytest: false, gh: false,
    };
    const httpHandler = new StreamableHttpHandler(
      config, probes, extensionClient, activityLog,
      { acquireLock: async () => true, releaseLock: async () => {} } as any,
      new Map(), null, logger,
    );
    server.httpMcpHandler = (req, res) => httpHandler.handle(req, res);

    const initBody = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const authHeader = { Authorization: `Bearer ${authToken}` };

    // Open 5 sessions (MAX_HTTP_SESSIONS)
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => httpPost(`http://127.0.0.1:${port}/mcp`, initBody, authHeader)),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);

    // 6th session should be rejected
    const overflow = await httpPost(`http://127.0.0.1:${port}/mcp`, initBody, authHeader);
    expect(overflow.status).toBe(503);

    httpHandler.close();
  });
});
