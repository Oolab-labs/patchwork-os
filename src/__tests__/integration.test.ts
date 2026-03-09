/**
 * Integration tests — compose Bridge components without Bridge.start()
 * (which registers process signal handlers and calls process.exit).
 *
 * Wiring mirrors what Bridge does in bridge.ts:
 *   Server -> emits "connection" -> McpTransport.attach(ws)
 *   Server -> emits "extension" -> ExtensionClient.handleExtensionConnection(ws)
 *   registerAllTools(transport, config, openedFiles, probes, extensionClient)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ActivityLog } from "../activityLog.js";
import type { Config } from "../config.js";
import { ExtensionClient } from "../extensionClient.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";
import { registerAllTools } from "../tools/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

function waitFor(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for message")),
      timeoutMs,
    );
    const handler = (data: Buffer | string) => {
      const parsed = JSON.parse(data.toString("utf-8"));
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(parsed);
      }
    };
    ws.on("message", handler);
  });
}

function makeMinimalConfig(workspace: string): Config {
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
  };
}

// ── Test scaffold ─────────────────────────────────────────────────────────────

interface TestBridge {
  server: Server;
  transport: McpTransport;
  extensionClient: ExtensionClient;
  port: number;
  authToken: string;
  workspace: string;
  connectClaude(): Promise<WebSocket>;
  connectExtension(): Promise<WebSocket>;
}

const openedClients: WebSocket[] = [];
const servers: Server[] = [];

async function setupBridge(registerTools = false): Promise<TestBridge> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-integ-"));
  // Make it a valid git repo so git tools don't error
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });

  const authToken = randomUUID();
  const logger = new Logger(false);
  const server = new Server(authToken, logger);
  const transport = new McpTransport(logger);
  const extensionClient = new ExtensionClient(logger);
  const activityLog = new ActivityLog();
  transport.setActivityLog(activityLog);

  server.on("connection", (ws: WebSocket) => {
    transport.attach(ws);
  });

  server.on("extension", (ws: WebSocket) => {
    extensionClient.handleExtensionConnection(ws);
  });

  if (registerTools) {
    const config = makeMinimalConfig(workspace);
    const probes = {
      git: true, rg: false, fd: false, tsc: false, eslint: false,
      pyright: false, ruff: false, cargo: false, go: false, biome: false,
      vitest: false, jest: false, pytest: false, gh: false,
    };
    registerAllTools(transport, config, new Set<string>(), probes, extensionClient, activityLog);
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

  const connectExtension = async (): Promise<WebSocket> => {
    // Wait past the MIN_CONNECTION_INTERVAL_MS (1000ms) to avoid rate-limit rejection
    await new Promise((r) => setTimeout(r, 1100));
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-ide-extension": authToken },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    openedClients.push(ws);
    return ws;
  };

  return { server, transport, extensionClient, port, authToken, workspace, connectClaude, connectExtension };
}

afterEach(async () => {
  for (const ws of openedClients) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
  openedClients.length = 0;
  for (const s of servers) {
    await s.close();
  }
  servers.length = 0;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Integration: initialize + tools/list", () => {
  it("initialize returns protocolVersion and tools/list returns a non-empty array", async () => {
    const bridge = await setupBridge(true);
    const ws = await bridge.connectClaude();

    send(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const initResp = await waitFor(ws, (m) => m.id === 1);

    const initResult = initResp.result as Record<string, unknown>;
    expect(typeof initResult.protocolVersion).toBe("string");
    expect(initResult.protocolVersion).toBeTruthy();

    send(ws, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listResp = await waitFor(ws, (m) => m.id === 2);

    const listResult = listResp.result as { tools: Array<Record<string, unknown>> };
    expect(Array.isArray(listResult.tools)).toBe(true);
    expect(listResult.tools.length).toBeGreaterThan(0);

    // Spot-check a known pure tool
    const gitStatus = listResult.tools.find((t) => t.name === "getGitStatus");
    expect(gitStatus).toBeDefined();
  }, 10000);
});

describe("Integration: extension connect notification", () => {
  it("Claude receives notifications/tools/list_changed when extension connects", async () => {
    // Build a custom setup where we wire the notification in the server "extension" handler
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-integ-notif-"));
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    const authToken = randomUUID();
    const logger = new Logger(false);
    const server = new Server(authToken, logger);
    servers.push(server);
    const transport = new McpTransport(logger);
    const extensionClient = new ExtensionClient(logger);

    let claudeWs: WebSocket | null = null;

    server.on("connection", (ws: WebSocket) => {
      claudeWs = ws;
      transport.attach(ws);
    });

    // Wire extension notification as bridge.ts does
    server.on("extension", (ws: WebSocket) => {
      extensionClient.handleExtensionConnection(ws);
      if (claudeWs && (claudeWs as WebSocket).readyState === WebSocket.OPEN) {
        McpTransport.sendNotification(claudeWs, "notifications/tools/list_changed", undefined, logger);
      }
    });

    const port = await server.findAndListen(null);

    // Connect Claude WS
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    openedClients.push(ws);

    // Initialize
    send(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(ws, (m) => m.id === 1);
    send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });

    // Set up notification listener BEFORE connecting extension
    const notifPromise = waitFor(
      ws,
      (m) => m.method === "notifications/tools/list_changed",
      5000,
    );

    // Wait past rate limit, then connect extension
    await new Promise((r) => setTimeout(r, 1100));
    const extWs = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-ide-extension": authToken },
    });
    await new Promise<void>((resolve, reject) => {
      extWs.on("open", resolve);
      extWs.on("error", reject);
    });
    openedClients.push(extWs);

    const notif = await notifPromise;
    expect(notif.method).toBe("notifications/tools/list_changed");
  }, 15000);
});

describe("Integration: pure tool call without extension", () => {
  it("getWorkspaceFolders returns a valid MCP result with no extension connected", async () => {
    const bridge = await setupBridge(true);
    const ws = await bridge.connectClaude();

    send(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(ws, (m) => m.id === 1);

    send(ws, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "getWorkspaceFolders", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 2, 8000);

    // Must be a valid MCP result (not a JSON-RPC error)
    expect(resp.error).toBeUndefined();
    const result = resp.result as { content: Array<{ type: string; text: string }> };
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]?.type).toBe("text");

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(true);
    expect(Array.isArray(parsed.folders)).toBe(true);
  }, 10000);
});

describe("Integration: extension proxy graceful error", () => {
  it("readClipboard returns isError:true (not a JSON-RPC error) when extension is not connected", async () => {
    const bridge = await setupBridge(true);
    const ws = await bridge.connectClaude();

    send(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(ws, (m) => m.id === 1);

    send(ws, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "readClipboard", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 2, 8000);

    // Must NOT be a JSON-RPC error — MCP spec says tool errors go in content
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("extension");
  }, 10000);
});
