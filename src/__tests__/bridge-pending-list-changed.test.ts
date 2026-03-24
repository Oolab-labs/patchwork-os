/**
 * Tests for Bridge's pendingListChanged flag.
 *
 * Bug: when sendListChanged fires while all WebSocket sessions are closed
 * (e.g. during the grace period after a shim disconnect), the notification
 * is silently dropped. The next session to connect and complete the MCP
 * handshake should immediately receive a tools/list_changed notification
 * so it re-queries the tool list and sees the current extension state.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";
import { send, waitFor } from "./wsHelpers.js";

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

// ---------------------------------------------------------------------------
// Scaffold that mirrors bridge.ts multi-session connection handler,
// plus a pendingListChanged flag and onInitialized hook support.
// ---------------------------------------------------------------------------

function buildScaffold() {
  const authToken = randomUUID();
  const logger = new Logger(false);
  const server = new Server(authToken, logger);

  let pendingListChanged = false;
  const sessions = new Map<
    string,
    {
      ws: WebSocket;
      transport: McpTransport;
      graceTimer: ReturnType<typeof setTimeout> | null;
    }
  >();

  function sendListChangedToAll() {
    let notifiedAny = false;
    for (const s of sessions.values()) {
      if (s.ws.readyState === WebSocket.OPEN) {
        McpTransport.sendNotification(
          s.ws,
          "notifications/tools/list_changed",
          undefined,
          logger,
        );
        notifiedAny = true;
      }
    }
    // If nobody received the notification, mark it pending for the next session
    if (!notifiedAny) {
      pendingListChanged = true;
    }
  }

  server.on("connection", (ws: WebSocket) => {
    const sessionId = randomUUID();
    const transport = new McpTransport(logger);

    // BUG target: onInitialized hook does NOT exist yet on McpTransport.
    // Once added, we hook it here to flush pendingListChanged.
    if ("onInitialized" in transport) {
      (transport as unknown as { onInitialized: () => void }).onInitialized =
        () => {
          if (pendingListChanged && ws.readyState === WebSocket.OPEN) {
            McpTransport.sendNotification(
              ws,
              "notifications/tools/list_changed",
              undefined,
              logger,
            );
            pendingListChanged = false;
          }
        };
    }

    const session = {
      ws,
      transport,
      graceTimer: null as ReturnType<typeof setTimeout> | null,
    };
    sessions.set(sessionId, session);
    transport.attach(ws);

    ws.on("close", () => {
      session.graceTimer = setTimeout(() => {
        transport.detach();
        sessions.delete(sessionId);
      }, 30_000);
    });
  });

  return {
    server,
    authToken,
    sendListChangedToAll,
    getSessions: () => sessions,
  };
}

// ---------------------------------------------------------------------------

async function doHandshake(ws: WebSocket): Promise<void> {
  // MCP initialize request
  send(ws, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.1" },
    },
  });
  // Wait for initialize response
  await waitFor(ws, (m) => m.id === 1 && "result" in m, 3000);
  // Send initialized notification
  send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
}

// ---------------------------------------------------------------------------

describe("pendingListChanged flag", () => {
  it("fires tools/list_changed on new session after notification was missed while disconnected", async () => {
    const { server, authToken, sendListChangedToAll } = buildScaffold();
    servers.push(server);
    const port = await server.findAndListen(null);

    // Connect first client, complete handshake
    const clientA = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    openedClients.push(clientA);
    await new Promise<void>((res, rej) => {
      clientA.on("open", res);
      clientA.on("error", rej);
    });
    await doHandshake(clientA);

    // Disconnect clientA — session enters grace period, WS closed
    clientA.close();
    await new Promise<void>((res) => clientA.once("close", res));
    // Wait past 500ms connection rate limit before connecting clientB
    await new Promise((r) => setTimeout(r, 510));

    // sendListChanged while no sessions have open WS — should mark pendingListChanged
    sendListChangedToAll();

    // Connect second client
    const clientB = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    openedClients.push(clientB);
    await new Promise<void>((res, rej) => {
      clientB.on("open", res);
      clientB.on("error", rej);
    });

    // Complete handshake — onInitialized should flush pendingListChanged
    const listChangedPromise = waitFor(
      clientB,
      (m) => m.method === "notifications/tools/list_changed",
      3000,
    );
    await doHandshake(clientB);

    // BUG: without onInitialized hook + pendingListChanged flag this FAILS —
    // the notification is never sent to clientB
    await expect(listChangedPromise).resolves.toMatchObject({
      method: "notifications/tools/list_changed",
    });

    clientB.close();
  });

  it("does NOT send tools/list_changed on new session if all sessions received it", async () => {
    const { server, authToken, sendListChangedToAll } = buildScaffold();
    servers.push(server);
    const port = await server.findAndListen(null);

    // Connect client, complete handshake
    const clientA = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    openedClients.push(clientA);
    await new Promise<void>((res, rej) => {
      clientA.on("open", res);
      clientA.on("error", rej);
    });
    await doHandshake(clientA);

    // sendListChanged while clientA IS connected — should notify and clear flag
    sendListChangedToAll();
    // Wait for the notification on clientA
    await waitFor(
      clientA,
      (m) => m.method === "notifications/tools/list_changed",
      2000,
    );

    // Disconnect clientA
    clientA.close();
    await new Promise<void>((res) => clientA.once("close", res));
    // Wait past 500ms connection rate limit before connecting clientB
    await new Promise((r) => setTimeout(r, 510));

    // Connect clientB — pendingListChanged should be false, so NO extra list_changed
    const clientB = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    openedClients.push(clientB);
    await new Promise<void>((res, rej) => {
      clientB.on("open", res);
      clientB.on("error", rej);
    });

    const { assertNoMessage } = await import("./wsHelpers.js");
    const noExtraNotification = assertNoMessage(
      clientB,
      (m) => m.method === "notifications/tools/list_changed",
      1500,
    );
    await doHandshake(clientB);
    // Should complete without receiving an unwanted list_changed
    await expect(noExtraNotification).resolves.toBeUndefined();

    clientB.close();
  });
});
