/**
 * Tests for the WebSocket keepalive heartbeat.
 *
 * The bridge pings all active (non-grace) sessions every wsPingIntervalMs.
 * Sessions that respond with a pong stay alive. Sessions that miss a pong
 * have their WebSocket terminated, triggering the normal grace-period flow.
 *
 * These tests scaffold the heartbeat logic directly using a real Server +
 * WebSocket pair — the same pattern as bridge-connectivity.test.ts — without
 * spinning up a full Bridge instance.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const servers: Server[] = [];
const openedClients: WebSocket[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const ws of openedClients) {
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    )
      ws.terminate();
  }
  openedClients.length = 0;
  for (const s of servers) {
    await s.close();
  }
  servers.length = 0;
});

// ── Helpers ────────────────────────────────────────────────────────────────────

interface HeartbeatSession {
  ws: WebSocket;
  wsAlive: boolean;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Scaffold that mirrors bridge.ts _startWsHeartbeat logic.
 * Returns the sessions map, a start function, and a stop function.
 */
function buildHeartbeatScaffold(intervalMs: number) {
  const authToken = randomUUID();
  const logger = new Logger(false);
  const server = new Server(authToken, logger);
  servers.push(server);

  const sessions = new Map<string, HeartbeatSession>();
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  server.on("connection", (ws: WebSocket) => {
    const id = randomUUID();
    const session: HeartbeatSession = { ws, wsAlive: true, graceTimer: null };
    sessions.set(id, session);
    ws.on("pong", () => {
      session.wsAlive = true;
    });
    ws.on("close", () => {
      sessions.delete(id);
    });
  });

  function startHeartbeat(): void {
    if (heartbeatInterval) return;
    heartbeatInterval = setInterval(() => {
      for (const [id, session] of sessions) {
        if (session.graceTimer) continue;
        const { ws } = session;
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (!session.wsAlive) {
          ws.terminate();
          sessions.delete(id);
          continue;
        }
        session.wsAlive = false;
        try {
          ws.ping();
        } catch {
          /* broken socket */
        }
      }
    }, intervalMs);
    heartbeatInterval.unref();
  }

  function stopHeartbeat(): void {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  return { server, sessions, startHeartbeat, stopHeartbeat, authToken };
}

function connect(server: Server, authToken: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    server.findAndListen(null).then((port) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { "x-claude-code-ide-authorization": authToken },
      });
      openedClients.push(ws);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  });
}

function waitForEvent(
  ws: WebSocket,
  event: string,
  timeoutMs = 2000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${event}"`)),
      timeoutMs,
    );
    ws.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("WS heartbeat — pings connected sessions", () => {
  it("sends a ping to an active session after the interval", async () => {
    const { server, startHeartbeat, authToken } = buildHeartbeatScaffold(100);
    const ws = await connect(server, authToken);

    startHeartbeat();

    await waitForEvent(ws, "ping", 2000);
    // If we reach here, the ping was received — heartbeat is firing
  });

  it("session stays open when pong is returned (ws auto-responds)", async () => {
    const { server, sessions, startHeartbeat, authToken } =
      buildHeartbeatScaffold(80);
    const ws = await connect(server, authToken);

    // Wait for session to be registered
    await new Promise((r) => setTimeout(r, 20));
    expect(sessions.size).toBe(1);

    startHeartbeat();

    // Wait for 3 heartbeat cycles — ws library auto-responds with pong
    await new Promise((r) => setTimeout(r, 300));

    // Session should still be alive and WS should still be open
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(sessions.size).toBe(1);
  });
});

describe("WS heartbeat — terminates sessions that miss pong", () => {
  it("terminates ws and removes session when wsAlive is false at ping time", async () => {
    const { server, sessions, startHeartbeat, authToken } =
      buildHeartbeatScaffold(80);
    await connect(server, authToken);

    // Wait for session to register
    await new Promise((r) => setTimeout(r, 20));
    expect(sessions.size).toBe(1);

    // Simulate a missed pong: mark wsAlive = false before heartbeat fires
    for (const session of sessions.values()) {
      session.wsAlive = false;
    }

    startHeartbeat();

    // After one heartbeat interval, terminate should have been called
    await new Promise((r) => setTimeout(r, 150));

    expect(sessions.size).toBe(0);
  });

  it("client receives close event when terminated by heartbeat", async () => {
    const { server, sessions, startHeartbeat, authToken } =
      buildHeartbeatScaffold(80);
    const ws = await connect(server, authToken);

    await new Promise((r) => setTimeout(r, 20));

    for (const session of sessions.values()) {
      session.wsAlive = false;
    }

    startHeartbeat();

    await waitForEvent(ws, "close", 2000);
    // Reached here — client saw the connection drop
  });
});

describe("WS heartbeat — skips grace-period sessions", () => {
  it("does not ping a session that has a graceTimer set", async () => {
    const { server, sessions, startHeartbeat, authToken } =
      buildHeartbeatScaffold(80);
    const ws = await connect(server, authToken);

    await new Promise((r) => setTimeout(r, 20));
    expect(sessions.size).toBe(1);

    // Put the session in grace (simulate a disconnected-but-not-cleaned-up state)
    for (const session of sessions.values()) {
      session.graceTimer = setTimeout(() => {}, 60_000) as ReturnType<
        typeof setTimeout
      >;
      session.wsAlive = false; // would normally trigger terminate
    }

    startHeartbeat();
    await new Promise((r) => setTimeout(r, 200));

    // ws should still be open because the heartbeat skipped the grace session
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Clean up grace timers
    for (const session of sessions.values()) {
      if (session.graceTimer) clearTimeout(session.graceTimer);
    }
  });
});

describe("WS heartbeat — stop clears interval", () => {
  it("no longer sends pings after stopHeartbeat()", async () => {
    const { server, startHeartbeat, stopHeartbeat, authToken } =
      buildHeartbeatScaffold(80);
    const ws = await connect(server, authToken);

    startHeartbeat();
    // Wait for first ping to confirm it was running
    await waitForEvent(ws, "ping", 1000);

    stopHeartbeat();

    // Count pings after stop — should receive none in 300ms
    let pingCount = 0;
    ws.on("ping", () => pingCount++);
    await new Promise((r) => setTimeout(r, 300));
    expect(pingCount).toBe(0);
  });
});
