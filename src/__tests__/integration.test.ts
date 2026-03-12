/**
 * Integration tests — compose Bridge components without Bridge.start()
 * (which registers process signal handlers and calls process.exit).
 *
 * Wiring mirrors what Bridge does in bridge.ts:
 *   Server -> emits "connection" -> McpTransport.attach(ws)
 *   Server -> emits "extension" -> ExtensionClient.handleExtensionConnection(ws)
 *   registerAllTools(transport, config, openedFiles, probes, extensionClient)
 */

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
import { registerAllTools } from "../tools/index.js";
import { McpTransport } from "../transport.js";
import { send, waitFor } from "./wsHelpers.js";

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
      git: true,
      rg: false,
      fd: false,
      tsc: false,
      eslint: false,
      pyright: false,
      ruff: false,
      cargo: false,
      go: false,
      biome: false,
      vitest: false,
      jest: false,
      pytest: false,
      gh: false,
    };
    registerAllTools(
      transport,
      config,
      new Set<string>(),
      probes,
      extensionClient,
      activityLog,
    );
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

  return {
    server,
    transport,
    extensionClient,
    port,
    authToken,
    workspace,
    connectClaude,
    connectExtension,
  };
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
    send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 10));

    const initResult = initResp.result as Record<string, unknown>;
    expect(typeof initResult.protocolVersion).toBe("string");
    expect(initResult.protocolVersion).toBeTruthy();

    send(ws, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listResp = await waitFor(ws, (m) => m.id === 2);

    const listResult = listResp.result as {
      tools: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(listResult.tools)).toBe(true);
    expect(listResult.tools.length).toBeGreaterThan(0);

    // Spot-check a known pure tool
    const gitStatus = listResult.tools.find((t) => t.name === "getGitStatus");
    expect(gitStatus).toBeDefined();
  });
});

describe("Integration: extension connect notification", () => {
  it("Claude receives notifications/tools/list_changed when extension connects", async () => {
    // Build a custom setup where we wire the notification in the server "extension" handler
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "bridge-integ-notif-"),
    );
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
        McpTransport.sendNotification(
          claudeWs,
          "notifications/tools/list_changed",
          undefined,
          logger,
        );
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
  });
});

describe("Integration: pure tool call without extension", () => {
  it("getWorkspaceFolders returns a valid MCP result with no extension connected", async () => {
    const bridge = await setupBridge(true);
    const ws = await bridge.connectClaude();

    send(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(ws, (m) => m.id === 1);
    send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 10));

    send(ws, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "getWorkspaceFolders", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 2, 8000);

    // Must be a valid MCP result (not a JSON-RPC error)
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]?.type).toBe("text");

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.success).toBe(true);
    expect(Array.isArray(parsed.folders)).toBe(true);
  });
});

describe("Integration: extension proxy graceful error", () => {
  it("readClipboard returns valid MCP result (not a JSON-RPC error) when extension is not connected", async () => {
    const bridge = await setupBridge(true);
    const ws = await bridge.connectClaude();

    send(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(ws, (m) => m.id === 1);
    send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 10));

    send(ws, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "readClipboard", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 2, 8000);

    // Must NOT be a JSON-RPC error — MCP spec says tool errors go in content.
    // readClipboard now has a native fallback so it may succeed or return isError:true
    // with a "clipboard unavailable" message (never a JSON-RPC-level error).
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    if (result.isError) {
      // When native tools unavailable, error message must mention clipboard
      expect(result.content[0]?.text.toLowerCase()).toContain("clipboard");
    }
  });
});

// ── Stress tests: extensionRequired filtering ─────────────────────────────────

const EXTENSION_REQUIRED_TOOLS = [
  "listTerminals",
  "getTerminalOutput",
  "createTerminal",
  "waitForTerminalOutput",
  "runInTerminal",
  "disposeTerminal",
  "sendTerminalCommand",
  "getDebugState",
  "evaluateInDebugger",
  "setDebugBreakpoints",
  "startDebugging",
  "stopDebugging",
  // getNotebookCells, getNotebookOutput — now have native fs fallback, no longer extension-required
  "runNotebookCell",
  // readClipboard, writeClipboard — now have native CLI fallback, no longer extension-required
  // listTasks — now has native fallback (.vscode/tasks.json + Makefile), no longer extension-required
  "runTask",
  "setEditorDecorations",
  "clearEditorDecorations",
  "closeTab",
  "organizeImports",
  "getInlayHints",
  // watchDiagnostics — now has native CLI linter fallback, no longer extension-required
  "executeVSCodeCommand",
  "listVSCodeCommands",
  "getHover",
  "getCodeActions",
  "applyCodeAction",
  "renameSymbol",
  "getCallHierarchy",
];

describe("Integration: extensionRequired full-registry filter", () => {
  it("tools/list hides all extensionRequired tools when extension is disconnected", async () => {
    const bridge = await setupBridge(true);
    // Must wire the fn — setupBridge does not do this; without it the default is ?? true (all visible)
    bridge.transport.setExtensionConnectedFn(() =>
      bridge.extensionClient.isConnected(),
    );
    const ws = await bridge.connectClaude();

    send(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(ws, (m) => m.id === 1);
    send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 10));

    send(ws, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const resp = await waitFor(ws, (m) => m.id === 2);
    const tools = (resp.result as { tools: Array<{ name: string }> }).tools;
    const names = new Set(tools.map((t) => t.name));

    for (const toolName of EXTENSION_REQUIRED_TOOLS) {
      expect(
        names.has(toolName),
        `${toolName} should be hidden when extension disconnected`,
      ).toBe(false);
    }
    // Pure tools must still be present
    expect(names.has("getGitStatus")).toBe(true);
    expect(names.has("getGitDiff")).toBe(true);
    expect(names.has("getGitLog")).toBe(true);
    // Registry must not be vacuously empty
    expect(tools.length).toBeGreaterThanOrEqual(15);
  });
});

describe("Integration: extensionRequired tools/call isError", () => {
  it("calling extensionRequired tools without extension returns isError:true for tools across different modules", async () => {
    const bridge = await setupBridge(true);
    bridge.transport.setExtensionConnectedFn(() =>
      bridge.extensionClient.isConnected(),
    );
    const ws = await bridge.connectClaude();

    send(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(ws, (m) => m.id === 1);
    send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 10));

    // One tool from each of: terminal.ts, debug.ts, lsp.ts (getHover needs valid args)
    const toolsToTest = [
      { name: "listTerminals", arguments: {} },
      { name: "getDebugState", arguments: {} },
      {
        name: "getHover",
        arguments: {
          filePath: `${bridge.workspace}/file.ts`,
          line: 1,
          column: 1,
        },
      },
    ];

    for (let i = 0; i < toolsToTest.length; i++) {
      const { name, arguments: args } = toolsToTest[i]!;
      send(ws, {
        jsonrpc: "2.0",
        id: 10 + i,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const resp = await waitFor(ws, (m) => m.id === 10 + i, 8000);

      expect(
        resp.error,
        `${name} must not return JSON-RPC error`,
      ).toBeUndefined();
      const result = resp.result as {
        content: Array<{ text: string }>;
        isError: boolean;
      };
      expect(result.isError, `${name} must have isError: true`).toBe(true);
      expect((result.content[0]?.text ?? "").toLowerCase()).toContain(
        "extension",
      );
    }
  });
});

describe("Integration: tools/list_changed on extension disconnect", () => {
  it("Claude receives notifications/tools/list_changed when extension disconnects", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "bridge-integ-disc-"),
    );
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

    // On extension connect: immediate notification (mirrors bridge.ts)
    server.on("extension", (ws: WebSocket) => {
      extensionClient.handleExtensionConnection(ws);
      if (claudeWs && (claudeWs as WebSocket).readyState === WebSocket.OPEN) {
        McpTransport.sendNotification(
          claudeWs,
          "notifications/tools/list_changed",
          undefined,
          logger,
        );
      }
    });

    // On extension disconnect: debounced notification (mirrors bridge.ts:80-113)
    let listChangedTimer: ReturnType<typeof setTimeout> | null = null;
    extensionClient.onExtensionDisconnected = () => {
      if (listChangedTimer) return;
      listChangedTimer = setTimeout(() => {
        listChangedTimer = null;
        if (claudeWs && (claudeWs as WebSocket).readyState === WebSocket.OPEN) {
          McpTransport.sendNotification(
            claudeWs,
            "notifications/tools/list_changed",
            undefined,
            logger,
          );
        }
      }, 2000);
    };

    transport.setExtensionConnectedFn(() => extensionClient.isConnected());

    const port = await server.findAndListen(null);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    openedClients.push(ws);

    send(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(ws, (m) => m.id === 1);
    send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });

    // Connect extension (wait past rate limit)
    await new Promise((r) => setTimeout(r, 1100));
    const extWs = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-ide-extension": authToken },
    });
    await new Promise<void>((resolve, reject) => {
      extWs.on("open", resolve);
      extWs.on("error", reject);
    });
    openedClients.push(extWs);

    // Consume the connect notification before testing disconnect
    await waitFor(
      ws,
      (m) => m.method === "notifications/tools/list_changed",
      5000,
    );

    // Now disconnect and wait for the debounced disconnect notification (~2s)
    const disconnectNotifPromise = waitFor(
      ws,
      (m) => m.method === "notifications/tools/list_changed",
      5000,
    );
    extWs.close();

    const notif = await disconnectNotifPromise;
    expect(notif.method).toBe("notifications/tools/list_changed");
  });
});
