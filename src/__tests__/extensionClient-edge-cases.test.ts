import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ExtensionClient } from "../extensionClient.js";
import { Logger } from "../logger.js";

let wss: WebSocketServer;
let port: number;
let client: ExtensionClient;

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.on("open", resolve);
  });
}

/** Create a server-side connection from the wss and hand it to the client. */
async function connectExtension(): Promise<{
  clientWs: WebSocket;
  serverWs: WebSocket;
}> {
  const serverConn = new Promise<WebSocket>((resolve) => {
    wss.once("connection", resolve);
  });
  const clientWs = new WebSocket(`ws://127.0.0.1:${port}`);
  await waitForOpen(clientWs);
  const serverWs = await serverConn;
  client.handleExtensionConnection(serverWs);
  return { clientWs, serverWs };
}

beforeEach(async () => {
  const logger = new Logger(false);
  client = new ExtensionClient(logger);
  wss = new WebSocketServer({ port: 0 });
  const addr = wss.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterEach(async () => {
  vi.useRealTimers();
  client.disconnect();
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
});

// ── MAX_PENDING_REQUESTS overflow ─────────────────────────────────────────────

describe("ExtensionClient: MAX_PENDING_REQUESTS overflow", () => {
  it("101st raw request() throws 'Too many pending'", async () => {
    // Establish connection with real timers
    const connections: WebSocket[] = [];
    wss.on("connection", (ws) => connections.push(ws));

    const clientWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(clientWs);
    await new Promise((r) => setTimeout(r, 50)); // let server-side settle

    client.handleExtensionConnection(connections[0]!);

    // Use the private request() method directly — it throws (rather than returning null)
    // for "Too many pending" (non-timeout errors from request() are re-thrown only for
    // ExtensionTimeoutError by requestOrNull; other errors are swallowed to null).
    const rawRequest = (
      client as unknown as {
        request: (
          method: string,
          params?: unknown,
          timeoutMs?: number,
        ) => Promise<unknown>;
      }
    ).request.bind(client);

    // Fill pending requests to 100 using a very long timeout so they don't expire
    // during the test (pass a large timeoutMs to prevent early rejection)
    const LONG_TIMEOUT = 60_000;
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      pending.push(
        rawRequest("extension/getDiagnostics", undefined, LONG_TIMEOUT).catch(
          () => null,
        ),
      );
    }

    // Give a tick for the requests to be queued (they each await waitForDrain)
    await new Promise((r) => setTimeout(r, 50));

    // The 101st raw request should reject synchronously with "Too many pending"
    await expect(
      rawRequest("extension/getDiagnostics", undefined, LONG_TIMEOUT),
    ).rejects.toThrow(/too many pending/i);

    // Verify the cap: pendingRequests size should be exactly 100
    const internalPendingRequests = (
      client as unknown as { pendingRequests: Map<number, unknown> }
    ).pendingRequests;
    expect(internalPendingRequests.size).toBe(100);

    // Clean up: reject all pending by disconnecting
    client.disconnect();
    await Promise.all(pending);

    clientWs.close();
  });
});

// ── Connection replacement rejects pending requests ───────────────────────────

describe("ExtensionClient: connection replacement", () => {
  it("pending requests are rejected when a new extension connection replaces the old one", async () => {
    // Establish two server-side connections (ws1 and ws2) first
    const connections: WebSocket[] = [];
    wss.on("connection", (ws) => connections.push(ws));

    const clientWs1 = new WebSocket(`ws://127.0.0.1:${port}`);
    const clientWs2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(clientWs1);
    await waitForOpen(clientWs2);
    await new Promise((r) => setTimeout(r, 50)); // let server-side events settle

    // Hand ws1 to client — start a request via the private request() method
    // (getDiagnostics() uses requestOrNull which swallows non-timeout errors to null)
    // We access the private request() method directly to get the raw rejection.
    client.handleExtensionConnection(connections[0]!);
    const rawRequest = (
      client as unknown as { request: (method: string) => Promise<unknown> }
    ).request.bind(client);
    const requestPromise = rawRequest("extension/getDiagnostics");

    // Small delay to ensure the request is in-flight
    await new Promise((r) => setTimeout(r, 20));

    // Replace with ws2 — should reject pending from ws1
    client.handleExtensionConnection(connections[1]!);

    // The raw promise from ws1 should now reject with "Extension reconnected"
    await expect(requestPromise).rejects.toThrow(/Extension reconnected/i);

    clientWs1.close();
    clientWs2.close();
  });

  it("isConnected is true after replacement", async () => {
    const connections: WebSocket[] = [];
    wss.on("connection", (ws) => connections.push(ws));

    const clientWs1 = new WebSocket(`ws://127.0.0.1:${port}`);
    const clientWs2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(clientWs1);
    await waitForOpen(clientWs2);
    await new Promise((r) => setTimeout(r, 50));

    client.handleExtensionConnection(connections[0]!);
    expect(client.isConnected()).toBe(true);

    client.handleExtensionConnection(connections[1]!);
    expect(client.isConnected()).toBe(true);

    clientWs1.close();
    clientWs2.close();
  });
});

// ── Settled flag: no double-resolve/reject ────────────────────────────────────

describe("ExtensionClient: settled flag (double-reject prevention)", () => {
  it("promise settles exactly once even when timeout and abort race", async () => {
    // Establish connection with real timers first, then switch
    const connections: WebSocket[] = [];
    wss.on("connection", (ws) => connections.push(ws));

    const clientWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(clientWs);
    await new Promise((r) => setTimeout(r, 50));

    vi.useFakeTimers({ now: Date.now() });
    client.handleExtensionConnection(connections[0]!);

    const controller = new AbortController();
    let settleCount = 0;

    // Use private request() directly to get raw promise (getDiagnostics -> requestOrNull -> null)
    const rawRequest = (
      client as unknown as {
        request: (
          method: string,
          params?: unknown,
          timeoutMs?: number,
          signal?: AbortSignal,
        ) => Promise<unknown>;
      }
    ).request.bind(client);

    const requestPromise = rawRequest(
      "extension/getDiagnostics",
      undefined,
      undefined,
      controller.signal,
    ).catch(() => {
      settleCount++;
    });

    // Race: advance timers to REQUEST_TIMEOUT + also abort
    const advancePromise = vi.advanceTimersByTimeAsync(10_001);
    controller.abort();

    await advancePromise;
    await requestPromise;

    expect(settleCount).toBe(1);

    vi.useRealTimers();
    clientWs.close();
  });

  it("aborting before sending does not cause unhandled rejections", async () => {
    const { clientWs } = await connectExtension();

    const controller = new AbortController();
    controller.abort(); // abort before request starts

    // getSelection() uses requestOrNull which swallows non-timeout errors.
    // Use the private request() directly to observe the raw rejection.
    const rawRequest = (
      client as unknown as {
        request: (
          method: string,
          params?: unknown,
          timeoutMs?: number,
          signal?: AbortSignal,
        ) => Promise<unknown>;
      }
    ).request.bind(client);

    await expect(
      rawRequest(
        "extension/getSelection",
        undefined,
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow(/aborted/i);

    clientWs.close();
  });
});

// ── Disconnect clears state ───────────────────────────────────────────────────

describe("ExtensionClient: disconnect clears state", () => {
  it("isConnected returns false after disconnect()", async () => {
    const { clientWs } = await connectExtension();
    expect(client.isConnected()).toBe(true);

    client.disconnect();
    expect(client.isConnected()).toBe(false);

    clientWs.close();
  });

  it("request() rejects when not connected", async () => {
    // No connection established — getDiagnostics uses requestOrNull which converts to null.
    // Use the private request() directly to observe the raw rejection.
    const rawRequest = (
      client as unknown as { request: (method: string) => Promise<unknown> }
    ).request.bind(client);
    await expect(rawRequest("extension/getDiagnostics")).rejects.toThrow(
      /not connected/i,
    );
  });

  it("onExtensionDisconnected callback fires when extension closes", async () => {
    const { clientWs } = await connectExtension();

    let disconnectFired = false;
    client.onExtensionDisconnected = () => {
      disconnectFired = true;
    };

    clientWs.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(disconnectFired).toBe(true);
  });
});

// ── Circuit breaker half-open probe ──────────────────────────────────────────

describe("ExtensionClient: circuit breaker half-open", () => {
  it("after backoff window expires, allows one probe through (half-open)", async () => {
    vi.useFakeTimers({ now: Date.now() });
    const { clientWs, serverWs } = await connectExtension();

    // Trigger one timeout to suspend
    const first = client.getDiagnostics().catch(() => null);
    await vi.advanceTimersByTimeAsync(10_001);
    await first;

    const state = client.getCircuitBreakerState();
    expect(state.suspended).toBe(true);
    const suspendedUntil = state.suspendedUntil;

    // Advance past the suspension window
    const remaining = suspendedUntil - Date.now() + 100;
    await vi.advanceTimersByTimeAsync(remaining);

    // Circuit breaker should no longer be fully suspended (backoff expired)
    const stateAfter = client.getCircuitBreakerState();
    expect(stateAfter.suspended).toBe(false);

    // But failures count is still non-zero (half-open state)
    expect(stateAfter.failures).toBeGreaterThan(0);

    vi.useRealTimers();
    clientWs.close();
    void serverWs;
  });
});

// ── Notification handling ─────────────────────────────────────────────────────

describe("ExtensionClient: notification handling", () => {
  it("malformed diagnosticsChanged notification is ignored gracefully", async () => {
    const { clientWs } = await connectExtension();

    // Send malformed notification (missing required fields)
    clientWs.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "extension/diagnosticsChanged",
        params: { badField: true }, // missing file and diagnostics
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    // Should not crash — connection still valid
    expect(client.isConnected()).toBe(true);

    clientWs.close();
  });

  it("unknown notification is ignored gracefully", async () => {
    const { clientWs } = await connectExtension();

    clientWs.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "extension/unknownEvent",
        params: { data: "whatever" },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(client.isConnected()).toBe(true);

    clientWs.close();
  });

  it("malformed JSON from extension is ignored gracefully", async () => {
    const { clientWs } = await connectExtension();

    clientWs.send("this is not JSON {{{{");

    await new Promise((r) => setTimeout(r, 50));
    expect(client.isConnected()).toBe(true);

    clientWs.close();
  });

  it("diagnostics cache capped at 500 entries", async () => {
    const { clientWs } = await connectExtension();

    // Send 510 distinct file diagnostics
    for (let i = 0; i < 510; i++) {
      clientWs.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "extension/diagnosticsChanged",
          params: {
            file: `/file${i}.ts`,
            diagnostics: [
              {
                file: `/file${i}.ts`,
                line: 1,
                column: 1,
                severity: "error",
                message: "error",
              },
            ],
          },
        }),
      );
    }

    await new Promise((r) => setTimeout(r, 200));

    // The cache should be capped at 500
    const cached = client.getCachedDiagnostics();
    expect(cached.length).toBeLessThanOrEqual(500);

    clientWs.close();
  });
});
