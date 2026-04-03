/**
 * Tests for the Bridge grace period race condition.
 *
 * When Client A disconnects and the grace timer starts, then Client B
 * connects within the grace period, openedFiles must be cleared because
 * Client B is a potentially different session.
 *
 * This test wires up the same connection handler logic as bridge.ts
 * to verify openedFiles state across connection lifecycles.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";

const CLAUDE_RECONNECT_GRACE_MS = 30_000;

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

/**
 * Build a minimal scaffold that mirrors Bridge's connection handler logic
 * (lines 43-88 of bridge.ts), exposing openedFiles for assertions.
 */
function setupGracePeriodScaffold() {
  const authToken = randomUUID();
  const logger = new Logger(false);
  const server = new Server(authToken, logger);
  const transport = new McpTransport(logger);
  const openedFiles = new Set<string>();

  let currentWs: WebSocket | null = null;
  let claudeDisconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function startClaudeDisconnectGrace(): void {
    if (claudeDisconnectTimer) return;
    claudeDisconnectTimer = setTimeout(() => {
      claudeDisconnectTimer = null;
      transport.detach();
      openedFiles.clear();
    }, CLAUDE_RECONNECT_GRACE_MS);
  }

  // Mirror bridge.ts connection handler exactly
  server.on("connection", (ws: WebSocket) => {
    // If reconnecting within grace period, cancel the deferred cleanup
    if (claudeDisconnectTimer) {
      clearTimeout(claudeDisconnectTimer);
      claudeDisconnectTimer = null;
      // BUG: openedFiles is NOT cleared here — stale state from old session persists
    }

    // Clean up previous connection if any
    if (currentWs) {
      transport.detach();
      currentWs.removeAllListeners();
      if (currentWs.readyState === WebSocket.OPEN) {
        currentWs.terminate();
      }
      // Don't clear openedFiles — preserve state for reconnecting session
    } else if (!claudeDisconnectTimer) {
      // Truly new connection (not a reconnect) — reset file tracking
      openedFiles.clear();
    }

    currentWs = ws;
    transport.attach(ws);

    ws.on("close", () => {
      if (currentWs === ws) {
        currentWs = null;
        startClaudeDisconnectGrace();
      }
    });

    ws.on("error", (_err) => {
      if (currentWs === ws) {
        currentWs = null;
        startClaudeDisconnectGrace();
      }
    });
  });

  return { server, authToken, openedFiles, transport };
}

describe("Bridge grace period: openedFiles cleanup", () => {
  it("clears openedFiles when a new client connects during grace period", async () => {
    const { server, authToken, openedFiles } = setupGracePeriodScaffold();
    servers.push(server);
    const port = await server.findAndListen(null);

    // 1. Client A connects
    const clientA = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    await new Promise<void>((resolve, reject) => {
      clientA.on("open", resolve);
      clientA.on("error", reject);
    });
    openedClients.push(clientA);

    // Simulate files being tracked during Client A's session
    openedFiles.add("/workspace/fileA.ts");
    openedFiles.add("/workspace/fileB.ts");
    expect(openedFiles.size).toBe(2);

    // 2. Client A disconnects — grace timer starts
    const disconnectPromise = new Promise<void>((resolve) => {
      clientA.on("close", () => resolve());
    });
    clientA.close();
    await disconnectPromise;

    // Small delay to ensure the close handler fires on server side
    await new Promise((r) => setTimeout(r, 50));

    // Files should still be present (grace period, not expired yet)
    expect(openedFiles.size).toBe(2);

    // 3. Client B connects within grace period (wait past rate limit)
    await new Promise((r) => setTimeout(r, 1100));
    const clientB = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    await new Promise<void>((resolve, reject) => {
      clientB.on("open", resolve);
      clientB.on("error", reject);
    });
    openedClients.push(clientB);

    // Small delay to ensure the connection handler fires
    await new Promise((r) => setTimeout(r, 50));

    // 4. openedFiles MUST be cleared — Client B is a new session
    expect(openedFiles.size).toBe(0);
  });
});
