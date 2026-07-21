/**
 * Regression test (diagnostic-report triage): a stale connection's "close"
 * event must not tear down a DIFFERENT, still-live session that happens to
 * share the same session id.
 *
 * ROOT CAUSE: two connections presenting the same X-Claude-Code-Session-Id
 * (a duplicate/racing client, or a client that reconnects while its old
 * socket hasn't actually closed yet) both reach the "fresh session" path
 * when the first session has no grace timer yet (still actively connected).
 * The second connection's `this.sessions.set(sessionId, sessionB)` silently
 * overwrites the map entry that pointed to the first connection's session.
 *
 * When the FIRST (now-superseded) connection's own WebSocket eventually
 * closes, its "close" handler looked up the session purely by id —
 * `this.sessions.get(sessionId)` — with no check that the entry still
 * pointed at ITS OWN `ws`. It found the second connection's (still-live)
 * session object and scheduled that session for grace-period cleanup,
 * eventually tearing it down even though its actual WebSocket was never
 * closed and remained in active use.
 *
 * Fix: both "close" handlers in bridge.ts (resume path and fresh-session
 * path) now check `current.ws === ws` before acting — a close event whose
 * session entry has already been replaced by a newer connection is ignored.
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

interface TestSession {
  ws: WebSocket;
  graceTimer: ReturnType<typeof setTimeout> | null;
  transport: { isReady: boolean };
}
type SessionsMap = Map<string, TestSession>;
function sessionsOf(bridge: unknown): SessionsMap {
  return (bridge as { sessions: SessionsMap }).sessions;
}

describe("duplicate session id — stale close must not tear down the replacement session", () => {
  let tempDir = "";
  let prevHome: string | undefined;
  let prevCfgDir: string | undefined;
  const clients: WebSocket[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dup-session-"));
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

  it("a superseded connection's close event does not schedule cleanup for the replacement session", async () => {
    const workspace = fs.mkdtempSync(path.join(tempDir, "ws-"));
    const bridge = new Bridge(makeConfig(workspace));
    try {
      await bridge.start();
      const port = bridge.getPort();
      const sharedId = randomUUID();

      // Connection A: takes the session id first. No disconnect yet, so it
      // has no grace timer — the exact precondition that sends a second
      // connection with the same id down the "fresh session" path instead
      // of the resume path.
      const wsA = await connect(port, sharedId);
      clients.push(wsA);
      await delay(50);

      const sessions = sessionsOf(bridge);
      const sessionAfterA = sessions.get(sharedId);
      const serverWsA = sessionAfterA?.ws;
      expect(serverWsA).toBeDefined();

      // Connection B: presents the SAME session id while A is still live.
      // This overwrites the map entry — the real, currently-unfixed
      // behavior this test does not change (a duplicate/racing client
      // sharing one session id is a client-side bug in itself); what
      // matters here is what happens next.
      // (Past the bridge's connection-storm throttle — MIN_CONNECTION_INTERVAL_MS.)
      await delay(600);
      const wsB = await connect(port, sharedId);
      clients.push(wsB);
      send(wsB, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
      await waitFor(wsB, (m) => m.id === 0);
      send(wsB, { jsonrpc: "2.0", method: "notifications/initialized" });
      await delay(50);

      const sessionAfterB = sessions.get(sharedId);
      const serverWsB = sessionAfterB?.ws;
      expect(serverWsB).toBeDefined();
      // The map entry was replaced by B's connection (a different
      // server-side ws object than A's).
      expect(serverWsB).not.toBe(serverWsA);
      expect(sessionAfterB).not.toBe(sessionAfterA);

      // Connection A (now superseded) closes.
      await new Promise<void>((resolve) => {
        wsA.on("close", () => resolve());
        wsA.close();
      });
      await delay(50);

      // The session map entry (B's session) must be untouched: still B's
      // server-side ws, and crucially no grace timer was started for it —
      // the bug would have scheduled B's session for teardown based on A's
      // close, since both share the same session id key.
      const sessionAfterAClose = sessions.get(sharedId);
      expect(sessionAfterAClose?.ws).toBe(serverWsB);
      expect(sessionAfterAClose?.graceTimer).toBeNull();

      // B must still be fully usable — a live tool-dispatch round-trip.
      expect(wsB.readyState).toBe(WebSocket.OPEN);
      send(wsB, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      const resp = await waitFor(wsB, (m) => m.id === 1);
      expect(resp.error).toBeUndefined();
      expect(resp.result).toBeDefined();
    } finally {
      await bridge.stop();
    }
  });
});
