/**
 * End-to-end regression test for the persistent "Not initialized" (-32600)
 * loop after a bridge restart / shim reconnect.
 *
 * ROOT CAUSE (this test guards against a regression of it):
 *   The WebSocket new-session path in bridge.ts generated its OWN random UUID
 *   as the session key and stored `this.sessions.set(randomUUID, session)` —
 *   it never keyed the map by the client-supplied `X-Claude-Code-Session-Id`.
 *   The grace-period resumption lookup at the TOP of the same handler does
 *   `this.sessions.get(clientSessionId)`, so it could NEVER match after any
 *   disconnect/reconnect. Every reconnect silently fell through to a brand-new,
 *   UN-initialized session. The stdio shim (scripts/mcp-stdio-shim.cjs) treats
 *   reconnects transparently — it drops pendingLines and never resends
 *   `initialize` — so the downstream MCP client's original handshake was never
 *   replayed and every tool call returned -32600 "Not initialized".
 *
 * The prior session-resumption unit tests all used a hand-written SCAFFOLD that
 * (correctly) keyed by clientSessionId — so they passed while the real Bridge
 * stayed broken. These tests instead exercise the REAL `Bridge` class.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Config } from "../config.js";
import { makeConfig as buildConfig } from "./helpers/fixtures.js";
import { send, waitFor } from "./wsHelpers.js";

vi.mock("../bridgeToken.js", () => ({
  loadOrCreateBridgeToken: vi.fn(() => "bridge-test-token"),
}));
vi.mock("../probe.js", () => ({ probeAll: vi.fn(async () => ({})) }));
vi.mock("../pluginLoader.js", () => ({
  loadPlugins: vi.fn(async () => []),
  loadPluginsFull: vi.fn(async () => []),
}));
vi.mock("../bridgeToolsRules.js", () => ({
  repairBridgeToolsRulesIfStale: vi.fn(),
}));
vi.mock("../telemetry.js", () => ({
  initTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(async () => {}),
}));

const { Bridge } = await import("../bridge.js");

const AUTH = "bridge-fixed-token";

function makeConfig(workspace: string): Config {
  return buildConfig({
    workspace,
    workspaceFolders: [workspace],
    ideName: "Test",
    maxResultSize: 512 * 1024,
    gracePeriodMs: 5_000,
    driver: "none",
    toolRateLimit: 100,
    fixedToken: AUTH,
    fullMode: false,
    analyticsEnabled: false,
    wsPingIntervalMs: 0,
    lspVerbosity: "minimal",
  });
}

function connect(port: number, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: {
      "x-claude-code-ide-authorization": AUTH,
      "x-claude-code-session-id": sessionId,
    },
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SessionsMap = Map<string, { transport: { isReady: boolean } }>;
function sessionsOf(bridge: unknown): SessionsMap {
  return (bridge as { sessions: SessionsMap }).sessions;
}

describe("real Bridge session resumption keys sessions by client session id", () => {
  let tempDir = "";
  let prevHome: string | undefined;
  let prevCfgDir: string | undefined;
  const clients: WebSocket[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-real-resume-"));
    prevHome = process.env.HOME;
    prevCfgDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = tempDir;
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, ".claude");
  });

  afterEach(() => {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
    clients.length = 0;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfgDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("indexes this.sessions by the client-supplied session id (not a random UUID)", async () => {
    const workspace = fs.mkdtempSync(path.join(tempDir, "ws-"));
    const bridge = new Bridge(makeConfig(workspace));
    try {
      await bridge.start();
      const port = bridge.getPort();
      const clientId = randomUUID();

      const ws = await connect(port, clientId);
      clients.push(ws);
      await delay(50);

      const sessions = sessionsOf(bridge);
      // The bug: the session was stored under a fresh randomUUID, so a lookup
      // by the client's own id — exactly what the grace-resume path does —
      // never matches.
      expect(sessions.has(clientId)).toBe(true);
    } finally {
      await bridge.stop();
    }
  });

  it("resumes an initialized session across a reconnect without a second initialize", async () => {
    const workspace = fs.mkdtempSync(path.join(tempDir, "ws-"));
    const bridge = new Bridge(makeConfig(workspace));
    try {
      await bridge.start();
      const port = bridge.getPort();
      const clientId = randomUUID();

      // 1. First connection — full MCP handshake once.
      const ws1 = await connect(port, clientId);
      clients.push(ws1);
      send(ws1, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
      await waitFor(ws1, (m) => m.id === 0);
      send(ws1, { jsonrpc: "2.0", method: "notifications/initialized" });
      await delay(50);

      const sessions = sessionsOf(bridge);
      expect(sessions.get(clientId)?.transport.isReady).toBe(true);

      // 2. Disconnect — grace timer starts, session preserved.
      await new Promise<void>((resolve) => {
        ws1.on("close", () => resolve());
        ws1.close();
      });
      await delay(50);
      expect(sessions.has(clientId)).toBe(true);

      // 3. Reconnect with the SAME session id (past the per-client rate limit).
      //    The shim never resends `initialize` on reconnect, so the resumed
      //    session MUST already be ready — otherwise every tool call -32600s.
      await delay(1100);
      const ws2 = await connect(port, clientId);
      clients.push(ws2);
      await delay(50);

      expect(sessions.get(clientId)?.transport.isReady).toBe(true);

      // A tool-dispatch request must succeed WITHOUT re-initializing.
      const waiter = waitFor(ws2, (m) => m.id === 1);
      send(ws2, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      const resp = await waiter;
      expect(resp.error).toBeUndefined();
      expect(resp.result).toBeDefined();
    } finally {
      await bridge.stop();
    }
  });
});
