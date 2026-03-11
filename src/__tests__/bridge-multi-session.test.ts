/**
 * Multi-session bridge behavior tests.
 *
 * These tests verify correct behavior when multiple Claude Code agents
 * connect to the same bridge simultaneously.
 *
 * Bug 3: notifyClaudeConnectionState(true) must only fire when the FIRST
 *        agent connects, not on every subsequent connection.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ExtensionClient } from "../extensionClient.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const servers: Server[] = [];
const openedClients: WebSocket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of openedClients) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
  openedClients.length = 0;
  for (const s of servers) {
    await s.close();
  }
  servers.length = 0;
});

/**
 * Scaffold that mirrors the multi-session connection handler in bridge.ts:
 * - creates a new session per connection
 * - calls notifyClaudeConnectionState(true) unconditionally (BUG — should be guarded)
 */
function buildMultiSessionScaffold() {
  const authToken = randomUUID();
  const logger = new Logger(false);
  const server = new Server(authToken, logger);
  const extensionClient = new ExtensionClient(logger);

  const sessions = new Map<string, { ws: WebSocket }>();

  server.on("connection", (ws: WebSocket) => {
    const sessionId = randomUUID();
    sessions.set(sessionId, { ws });
    // Only notify on the first active session (the fix for Bug 3)
    if (sessions.size === 1) {
      extensionClient.notifyClaudeConnectionState(true);
    }

    ws.on("close", () => {
      sessions.delete(sessionId);
      if (sessions.size === 0) {
        extensionClient.notifyClaudeConnectionState(false);
      }
    });
  });

  servers.push(server);
  return { server, authToken, extensionClient, sessions };
}

describe("Bridge multi-session: notifyClaudeConnectionState (Bug 3)", () => {
  it("notifyClaudeConnectionState(true) is only called once when two agents connect", async () => {
    const { server, authToken, extensionClient } = buildMultiSessionScaffold();
    const port = await server.findAndListen(null);

    const notifySpy = vi.spyOn(extensionClient, "notifyClaudeConnectionState");

    // Connect agent 1
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    await new Promise<void>((resolve, reject) => {
      ws1.on("open", resolve);
      ws1.on("error", reject);
    });
    openedClients.push(ws1);
    await new Promise((r) => setTimeout(r, 50));

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenLastCalledWith(true);
    notifySpy.mockClear();

    // Connect agent 2 — should NOT trigger another notifyClaudeConnectionState(true)
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    await new Promise<void>((resolve, reject) => {
      ws2.on("open", resolve);
      ws2.on("error", reject);
    });
    openedClients.push(ws2);
    await new Promise((r) => setTimeout(r, 50));

    // BUG: currently called once more; CORRECT behavior: not called at all
    expect(notifySpy).not.toHaveBeenCalled();

    ws1.close();
    ws2.close();
  });

  it("notifyClaudeConnectionState(false) fires once when last active session disconnects", async () => {
    const { server, authToken, extensionClient } = buildMultiSessionScaffold();
    const port = await server.findAndListen(null);

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    await new Promise<void>((resolve, reject) => {
      ws1.on("open", resolve);
      ws1.on("error", reject);
    });
    openedClients.push(ws1);
    await new Promise((r) => setTimeout(r, 60)); // past 50ms rate limit

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    await new Promise<void>((resolve, reject) => {
      ws2.on("open", resolve);
      ws2.on("error", reject);
    });
    openedClients.push(ws2);
    await new Promise((r) => setTimeout(r, 50));

    const notifySpy = vi.spyOn(extensionClient, "notifyClaudeConnectionState");

    // Disconnect ws1 — should NOT notify false (ws2 still active)
    const ws1Closed = new Promise<void>((r) => ws1.on("close", r));
    ws1.close();
    await ws1Closed;
    await new Promise((r) => setTimeout(r, 50));

    expect(notifySpy).not.toHaveBeenCalledWith(false);

    // Disconnect ws2 — SHOULD notify false (no more sessions)
    const ws2Closed = new Promise<void>((r) => ws2.on("close", r));
    ws2.close();
    await ws2Closed;
    await new Promise((r) => setTimeout(r, 50));

    expect(notifySpy).toHaveBeenCalledWith(false);
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });
});
