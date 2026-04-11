/**
 * Tests for WebSocket session resumption via X-Claude-Code-Session-Id.
 *
 * When a client disconnects and reconnects within the grace period, it sends
 * the same session ID it used on the initial connection. The bridge detects
 * the matching grace-period session, cancels the cleanup timer, and reattaches
 * the new WebSocket to the existing session — preserving openedFiles and
 * rate-limit state without duplicating session entries.
 *
 * These tests scaffold the same connection-handler logic as bridge.ts to keep
 * the tests fast (no full Bridge startup needed).
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";

// Must be long enough to outlive the 1000ms rate-limit window between connections.
const GRACE_PERIOD_MS = 5_000;

const servers: Server[] = [];
const openedClients: WebSocket[] = [];

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

interface SessionEntry {
  id: string;
  ws: WebSocket;
  transport: McpTransport;
  openedFiles: Set<string>;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Scaffold that mirrors bridge.ts session resumption logic:
 * - Uses clientSessionId as the session key when provided (stable across reconnects)
 * - Falls back to a random UUID when no clientSessionId header is present
 * - Grace-period sessions are reattached instead of replaced
 */
function buildResumptionScaffold() {
  const authToken = randomUUID();
  const logger = new Logger(false);
  const server = new Server(authToken, logger);
  const sessions = new Map<string, SessionEntry>();

  function startGrace(ws: WebSocket, sessionId: string): void {
    const s = sessions.get(sessionId);
    // Only start grace if this WS is still the current one for the session
    if (s && s.ws === ws && !s.graceTimer) {
      s.graceTimer = setTimeout(() => {
        s.transport.detach();
        s.openedFiles.clear();
        sessions.delete(sessionId);
      }, GRACE_PERIOD_MS);
    }
  }

  server.on("connection", (ws: WebSocket) => {
    const clientId = (ws as WebSocket & { clientSessionId?: string })
      .clientSessionId;

    // ── Session resumption ──────────────────────────────────────────────────
    if (clientId) {
      const existing = sessions.get(clientId);
      if (existing?.graceTimer) {
        clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
        existing.ws = ws;
        existing.transport.attach(ws);
        ws.on("close", () => startGrace(ws, clientId));
        ws.on("error", () => {
          /* suppress in tests */
        });
        return; // reattached — do not create a new session
      }
    }

    // ── New session ─────────────────────────────────────────────────────────
    // Use the client-provided ID as the session key so reconnects can find it.
    const sessionId = clientId ?? randomUUID();
    const transport = new McpTransport(logger);
    const openedFiles = new Set<string>();
    const entry: SessionEntry = {
      id: sessionId,
      ws,
      transport,
      openedFiles,
      graceTimer: null,
    };
    sessions.set(sessionId, entry);
    transport.attach(ws);
    ws.on("close", () => startGrace(ws, sessionId));
    ws.on("error", () => {
      /* suppress in tests */
    });
  });

  servers.push(server);
  return { server, authToken, sessions };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function connectClient(
  port: number,
  authToken: string,
  sessionId?: string,
): Promise<WebSocket> {
  const headers: Record<string, string> = {
    "x-claude-code-ide-authorization": authToken,
  };
  if (sessionId) headers["x-claude-code-session-id"] = sessionId;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  openedClients.push(ws);
  return ws;
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.on("close", resolve));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("session resumption via X-Claude-Code-Session-Id", () => {
  it("reattaches to the grace-period session and preserves openedFiles", async () => {
    const { server, authToken, sessions } = buildResumptionScaffold();
    const port = await server.findAndListen(null);

    const clientId = randomUUID();

    // First connection — creates a new session keyed by clientId
    const ws1 = await connectClient(port, authToken, clientId);
    await delay(50);
    expect(sessions.has(clientId)).toBe(true);

    const entry = sessions.get(clientId)!;
    entry.openedFiles.add("/workspace/foo.ts");
    expect(entry.openedFiles.size).toBe(1);

    // Disconnect — grace timer starts
    const closePromise = waitForClose(ws1);
    ws1.close();
    await closePromise;
    await delay(50);

    // Session still present in grace period
    expect(sessions.has(clientId)).toBe(true);
    expect(sessions.get(clientId)!.graceTimer).not.toBeNull();

    // Wait past the per-client rate limit (MIN_CONNECTION_INTERVAL_MS ≈ 1000ms)
    await delay(1100);

    // Reconnect with the same session ID — should reattach
    const ws2 = await connectClient(port, authToken, clientId);
    await delay(50);

    const resumed = sessions.get(clientId)!;
    // Grace timer must be cancelled
    expect(resumed.graceTimer).toBeNull();
    // openedFiles preserved — same session object, not a new one
    expect(resumed.openedFiles.size).toBe(1);
    expect(resumed.openedFiles.has("/workspace/foo.ts")).toBe(true);
    // Only one session entry (not duplicated)
    expect(sessions.size).toBe(1);

    ws2.close();
  });

  it("creates a new session when no session ID header is sent", async () => {
    const { server, authToken, sessions } = buildResumptionScaffold();
    const port = await server.findAndListen(null);

    // Connect without a session ID — gets a random-UUID session
    const ws1 = await connectClient(port, authToken);
    await delay(50);
    expect(sessions.size).toBe(1);

    const closePromise = waitForClose(ws1);
    ws1.close();
    await closePromise;
    await delay(50);
    await delay(1100); // rate limit

    // Reconnect without session ID — creates a second session
    const ws2 = await connectClient(port, authToken);
    await delay(50);

    // Two sessions: old one in grace, new one active
    expect(sessions.size).toBe(2);

    ws2.close();
  });

  it("creates a new session when the session ID does not match any existing session", async () => {
    const { server, authToken, sessions } = buildResumptionScaffold();
    const port = await server.findAndListen(null);

    const clientId1 = randomUUID();
    const clientId2 = randomUUID(); // unknown to the bridge

    const ws1 = await connectClient(port, authToken, clientId1);
    await delay(50);
    expect(sessions.has(clientId1)).toBe(true);

    const closePromise = waitForClose(ws1);
    ws1.close();
    await closePromise;
    await delay(50);
    await delay(1100);

    // Connect with a different unknown ID — cannot reattach, creates new session
    const ws2 = await connectClient(port, authToken, clientId2);
    await delay(50);

    expect(sessions.has(clientId1)).toBe(true); // old session still in grace
    expect(sessions.has(clientId2)).toBe(true); // new independent session
    expect(sessions.size).toBe(2);

    ws2.close();
  });

  it("grace period cleanup fires if the reconnect never happens", async () => {
    const SHORT_GRACE_MS = 200;
    // Override: use a tiny grace period for this test only
    const authToken = randomUUID();
    const logger = new Logger(false);
    const server2 = new Server(authToken, logger);
    const sessions2 = new Map<string, SessionEntry>();

    function startGrace2(ws: WebSocket, sessionId: string): void {
      const s = sessions2.get(sessionId);
      if (s && s.ws === ws && !s.graceTimer) {
        s.graceTimer = setTimeout(() => {
          s.transport.detach();
          s.openedFiles.clear();
          sessions2.delete(sessionId);
        }, SHORT_GRACE_MS);
      }
    }

    server2.on("connection", (ws: WebSocket) => {
      const clientId2 = (ws as WebSocket & { clientSessionId?: string })
        .clientSessionId;
      const sessionId = clientId2 ?? randomUUID();
      const transport = new McpTransport(logger);
      const entry: SessionEntry = {
        id: sessionId,
        ws,
        transport,
        openedFiles: new Set(),
        graceTimer: null,
      };
      sessions2.set(sessionId, entry);
      transport.attach(ws);
      ws.on("close", () => startGrace2(ws, sessionId));
    });

    servers.push(server2);
    const port2 = await server2.findAndListen(null);

    const clientId = randomUUID();
    const ws1 = await connectClient(port2, authToken, clientId);
    await delay(50);
    expect(sessions2.has(clientId)).toBe(true);

    const closePromise = waitForClose(ws1);
    ws1.close();
    await closePromise;

    // Wait for the short grace period to expire
    await delay(SHORT_GRACE_MS + 100);

    // Session should have been cleaned up
    expect(sessions2.has(clientId)).toBe(false);
  });
});
