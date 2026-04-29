/**
 * Regression: ensure the Streamable-HTTP transport registers the same tool
 * deps as the WebSocket transport.
 *
 * Backstory: dogfood (recipe live-fire) found that `ctxSaveTrace`,
 * `ctxQueryTraces`, and any tool gated on disconnect-info,
 * `commitIssueLinkLog`, `recipeRunLog`, or `decisionTraceLog` were
 * silently NOT registering on the Streamable-HTTP MCP path. The root
 * cause was a positional-arg mismatch: bridge.ts passed 19 args to
 * `registerAllTools`, streamableHttp.ts only passed 12 (stopped at
 * `pluginTools`). The handler had no fields for the missing 7 deps.
 *
 * This test pins the parity: when given a fully-populated `toolDeps`
 * object, the handler must invoke `registerAllTools` with all the
 * tail-end dep arguments populated. Catches future drift if anyone
 * adds another dep to the WS path without updating the HTTP path.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { StreamableHttpHandler } from "../streamableHttp.js";

// Capture every call to registerAllTools so we can assert the arg list.
const registerCalls: unknown[][] = [];
vi.mock("../tools/index.js", () => ({
  registerAllTools: (...args: unknown[]) => {
    registerCalls.push(args);
  },
}));

const logger = new Logger(false);
const TOKEN = "test-token-streamable-http-parity-1234567890";

function makeDeps() {
  const config = {
    workspace: "/tmp/test-workspace",
    port: null,
    bindAddress: "127.0.0.1",
    preferredPortRange: null,
    ide: null,
    ideName: "test",
    debug: false,
    editor: null,
    noReady: false,
    configFile: null,
    noLockFile: false,
    claudeDriver: "subprocess" as const,
    claudeBinary: "claude",
    automationPolicy: null,
  };
  const extensionClient = {
    isConnected: () => false,
    on: () => {},
    request: () => Promise.resolve(null),
    removeListener: () => {},
  };
  const activityLog = {
    recordTool: () => {},
    recordEvent: () => {},
    getStats: () => ({
      totalToolCalls: 0,
      errorCount: 0,
      avgDurationMs: 0,
      toolBreakdown: {},
    }),
    queryTimeline: () => [],
  };
  const fileLock = {
    acquire: () => Promise.resolve({ release: () => {} }),
  };
  return { config, extensionClient, activityLog, fileLock };
}

async function post(
  port: number,
  data: Record<string, unknown>,
  sessionId?: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/mcp", method: "POST", headers },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => {
          body += c.toString();
        });
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

let server: Server | null = null;
let handler: StreamableHttpHandler | null = null;
let port: number;

beforeEach(() => {
  registerCalls.length = 0;
});

afterEach(async () => {
  handler?.close();
  handler = null;
  await server?.close();
  server = null;
});

describe("StreamableHttpHandler — registerAllTools arg parity", () => {
  it("passes all tail-end deps when toolDeps is provided", async () => {
    const deps = makeDeps();
    server = new Server(TOKEN, logger);

    // Sentinel objects so we can assert each was forwarded.
    const sentinelAutomation = { kind: "automationHooks" } as never;
    const sentinelCommitLog = { kind: "commitIssueLinkLog" } as never;
    const sentinelRunLog = { kind: "recipeRunLog" } as never;
    const sentinelDecisionLog = { kind: "decisionTraceLog" } as never;
    const sentinelDisconnect = () => ({
      at: "2026-04-29T00:00:00Z",
      code: 1006,
      reason: "test",
    });
    const sentinelCacheUpdated = (_: string) => {};
    const sentinelDisconnectCount = () => 7;

    handler = new StreamableHttpHandler(
      deps.config as never,
      {} as never,
      deps.extensionClient as never,
      deps.activityLog as never,
      deps.fileLock as never,
      new Map(),
      null,
      logger,
      undefined, // getPluginTools
      undefined, // getPluginWatcher
      null, // resolveScopeFn
      null, // instructionsProvider
      {
        automationHooks: sentinelAutomation,
        getDisconnectInfo: sentinelDisconnect,
        onContextCacheUpdated: sentinelCacheUpdated,
        getExtensionDisconnectCount: sentinelDisconnectCount,
        commitIssueLinkLog: sentinelCommitLog,
        recipeRunLog: sentinelRunLog,
        decisionTraceLog: sentinelDecisionLog,
      },
    );

    server.httpMcpHandler = (req, res) => handler!.handle(req, res);
    port = await server.findAndListen(null);

    // Initialize a session — that's what triggers registerAllTools.
    const res = await post(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "parity-test", version: "1.0" },
      },
    });
    expect(res.status).toBe(200);

    // The handler should have called registerAllTools exactly once.
    expect(registerCalls).toHaveLength(1);
    const args = registerCalls[0]!;

    // Position contract — must match the WS-side call in bridge.ts.
    // 0  transport
    // 1  config
    // 2  openedFiles
    // 3  probes
    // 4  extensionClient
    // 5  activityLog
    // 6  terminalPrefix
    // 7  fileLock
    // 8  sessions
    // 9  orchestrator
    // 10 sessionId
    // 11 pluginTools
    // 12 automationHooks            ← was missing pre-fix
    // 13 getDisconnectInfo          ← was missing
    // 14 onContextCacheUpdated      ← was missing
    // 15 getExtensionDisconnectCount← was missing
    // 16 commitIssueLinkLog         ← was missing
    // 17 recipeRunLog               ← was missing
    // 18 decisionTraceLog           ← was missing
    expect(args.length).toBe(19);
    expect(args[12]).toBe(sentinelAutomation);
    expect(args[13]).toBe(sentinelDisconnect);
    expect(args[14]).toBe(sentinelCacheUpdated);
    expect(args[15]).toBe(sentinelDisconnectCount);
    expect(args[16]).toBe(sentinelCommitLog);
    expect(args[17]).toBe(sentinelRunLog);
    expect(args[18]).toBe(sentinelDecisionLog);
  });

  it("passes undefined for tail-end deps when toolDeps is omitted (back-compat)", async () => {
    const deps = makeDeps();
    server = new Server(TOKEN, logger);

    // Construct without the toolDeps argument — pre-fix call shape.
    handler = new StreamableHttpHandler(
      deps.config as never,
      {} as never,
      deps.extensionClient as never,
      deps.activityLog as never,
      deps.fileLock as never,
      new Map(),
      null,
      logger,
    );
    server.httpMcpHandler = (req, res) => handler!.handle(req, res);
    port = await server.findAndListen(null);

    const res = await post(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "parity-test", version: "1.0" },
      },
    });
    expect(res.status).toBe(200);

    expect(registerCalls).toHaveLength(1);
    const args = registerCalls[0]!;
    // Still 19 args — the trailing positions are explicitly undefined.
    expect(args.length).toBe(19);
    for (let i = 12; i <= 18; i++) {
      expect(args[i]).toBeUndefined();
    }
  });
});
