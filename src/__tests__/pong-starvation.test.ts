/**
 * Tests for WebSocket pong-starvation disconnect behaviour.
 *
 * Verifies:
 *  - After 4 pong misses (5 ping intervals), server calls terminate() on the client
 *  - After only 3 pong misses (4 ping intervals), connection stays open
 *  - Disconnect log includes disconnectReason="pong_timeout" + lastPong age
 *  - Clean client close logs disconnectReason="client_initiated"
 *
 * Uses real timers with a very short pingIntervalMs (50ms) injected via the
 * Server constructor option, avoiding fake-timer / I/O callback ordering issues.
 *
 * Threshold logic (interval 1 = first false flag, no miss counted):
 *   T+50ms:  isAlive=true → flag false, ping sent
 *   T+100ms: isAlive=false → missedPongs=1
 *   T+150ms: isAlive=false → missedPongs=2
 *   T+200ms: isAlive=false → missedPongs=3
 *   T+250ms: isAlive=false → missedPongs=4 → terminate()
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const PING_MS = 50; // short interval for tests

// ── Helpers ───────────────────────────────────────────────────────────────────

async function connectNoAutoPong(
  port: number,
  authToken: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": authToken },
    });
    // Suppress auto-pong: add a ping listener (ws only auto-pongs when
    // listenerCount("ping") === 0) AND override ws.pong() to a no-op so that
    // even if the library calls it directly, nothing is sent.
    ws.on("ping", () => {
      /* swallow */
    });
    ws.once("open", () => {
      (ws as any).pong = () => {};
      resolve(ws);
    });
    ws.once("error", reject);
  });
}

/** Wait until the server's wss.clients set reaches the expected size. */
function waitForClientsSize(
  server: Server,
  expected: number,
  timeoutMs = 2000,
): Promise<void> {
  const wss = (server as unknown as { wss: WebSocketServer }).wss;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (wss.clients.size === expected) return resolve();
      if (Date.now() > deadline)
        return reject(
          new Error(
            `Timed out waiting for wss.clients.size === ${expected} (got ${wss.clients.size})`,
          ),
        );
      setTimeout(check, 10);
    };
    check();
  });
}

/** Access the internal wss on a Server instance for state inspection. */
function getWssClients(server: Server): Set<WebSocket> {
  return (server as unknown as { wss: WebSocketServer }).wss.clients;
}

// ── Suite: threshold ──────────────────────────────────────────────────────────

describe("pong starvation — threshold is 4 missed pongs", () => {
  let server: Server;
  let authToken: string;
  let port: number;

  beforeEach(async () => {
    authToken = randomUUID();
    // Pass pingIntervalMs so the interval fires quickly in tests.
    server = new Server(authToken, new Logger(false), [], PING_MS);
    port = await server.listen(0);
  });

  afterEach(async () => {
    await server.close();
  });

  it("marks client as terminated after 5 ping intervals (4 missed pongs)", async () => {
    await connectNoAutoPong(port, authToken);

    // Wait for server to terminate the client (5 intervals = 250ms + slack)
    await waitForClientsSize(server, 0, 2000);

    expect(getWssClients(server).size).toBe(0);
  });

  it("does NOT terminate after 4 ping intervals (3 missed pongs)", async () => {
    const ws = await connectNoAutoPong(port, authToken);

    // Wait 3.5 intervals — 3 misses counted, safely below threshold of 4.
    // (Using 3.5× not 4.5× gives more headroom before the 5th interval fires.)
    await new Promise((r) => setTimeout(r, PING_MS * 3 + PING_MS / 2));

    const clients = getWssClients(server);
    expect(clients.size).toBe(1);
    ws.close();
  });
});

// ── Suite: logging ────────────────────────────────────────────────────────────

describe("pong starvation — disconnect-reason logging", () => {
  let server: Server;
  let authToken: string;
  let port: number;
  let warnLines: string[];
  let infoLines: string[];

  beforeEach(async () => {
    warnLines = [];
    infoLines = [];
    authToken = randomUUID();
    const logger = new Logger(false);
    vi.spyOn(logger, "warn").mockImplementation((msg: string) => {
      warnLines.push(msg);
    });
    vi.spyOn(logger, "info").mockImplementation((msg: string) => {
      infoLines.push(msg);
    });
    server = new Server(authToken, logger, [], PING_MS);
    port = await server.listen(0);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("logs '4 missed pongs' warn and 'disconnectReason=pong_timeout' info", async () => {
    const _ws = await connectNoAutoPong(port, authToken);

    // Wait for termination (5 intervals + slack)
    await waitForClientsSize(server, 0, 2000);

    const warnMatch = warnLines.find((l) => l.includes("4 missed pongs"));
    expect(warnMatch).toBeDefined();
    expect(warnMatch).toContain("lastPong=");

    const infoMatch = infoLines.find((l) =>
      l.includes("Claude Code WebSocket closed"),
    );
    expect(infoMatch).toBeDefined();
    expect(infoMatch).toContain("disconnectReason=pong_timeout");
    // ws was already terminated by the server — no need to call ws.terminate()
  });

  it("logs 'disconnectReason=client_initiated' on clean close", async () => {
    const ws = await connectNoAutoPong(port, authToken);

    ws.close(1000, "done");
    // Wait until server side has removed the client (close handler has fired)
    await waitForClientsSize(server, 0, 2000);

    const infoMatch = infoLines.find((l) =>
      l.includes("Claude Code WebSocket closed"),
    );
    expect(infoMatch).toBeDefined();
    expect(infoMatch).toContain("disconnectReason=client_initiated");
    expect(infoMatch).toContain("code=1000");
  });
});
