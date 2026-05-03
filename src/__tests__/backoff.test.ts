/**
 * Tests for the windowed circuit breaker in ExtensionClient.
 * Circuit opens only after CIRCUIT_THRESHOLD (3) timeouts within CIRCUIT_WINDOW_MS (30s).
 * A single slow LSP response no longer trips the breaker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ExtensionClient, ExtensionTimeoutError } from "../extensionClient.js";
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
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

async function connectClient(): Promise<{
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

/** Trigger n timeouts in succession using fake timers. */
async function triggerTimeouts(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const req = client.getDiagnostics().catch(() => null);
    await vi.advanceTimersByTimeAsync(10_001); // past REQUEST_TIMEOUT
    await req;
    // The connector's failure-recording catch lives later in the same promise
    // chain than our `.catch(() => null)`. Flush enough microtask turns for
    // circuit-breaker state to settle — Node 22 schedules internal catch
    // continuations later than Node 20, so we need more flushes.
    for (let f = 0; f < 8; f++) await Promise.resolve();
  }
}

describe("ExtensionClient windowed circuit breaker", () => {
  it("single timeout: records failure but circuit stays open (no suspension)", async () => {
    vi.useFakeTimers();
    const { clientWs } = await connectClient();

    await triggerTimeouts(1);

    const state = client.getCircuitBreakerState();
    expect(state.failures).toBe(1);
    expect(state.suspended).toBe(false); // one failure is not enough
    expect(state.suspendedUntil).toBe(0);

    clientWs.close();
  });

  it("two timeouts: records failures but circuit stays open", async () => {
    vi.useFakeTimers();
    const { clientWs } = await connectClient();

    await triggerTimeouts(2);

    const state = client.getCircuitBreakerState();
    expect(state.failures).toBe(2);
    expect(state.suspended).toBe(false); // two failures still below threshold
    expect(state.suspendedUntil).toBe(0);

    clientWs.close();
  });

  it("three timeouts within window: opens circuit and suspends", async () => {
    vi.useFakeTimers();
    const { clientWs } = await connectClient();

    await triggerTimeouts(3);

    const state = client.getCircuitBreakerState();
    expect(state.failures).toBe(3);
    expect(state.suspended).toBe(true); // 3 failures hits threshold
    expect(state.suspendedUntil).toBeGreaterThan(Date.now());

    clientWs.close();
  });

  it("failure outside the 30s window does not count toward threshold", async () => {
    vi.useFakeTimers();
    const { clientWs } = await connectClient();

    // Two timeouts
    await triggerTimeouts(2);
    expect(client.getCircuitBreakerState().failures).toBe(2);

    // Advance past the 30s window so both failures expire
    await vi.advanceTimersByTimeAsync(30_001);

    // Third timeout — the earlier two are now stale
    await triggerTimeouts(1);

    const state = client.getCircuitBreakerState();
    expect(state.failures).toBe(1); // only the fresh failure counts
    expect(state.suspended).toBe(false); // circuit stays open

    clientWs.close();
  });

  it("fast-fail during suspension after 3 failures: throws ExtensionTimeoutError immediately", async () => {
    vi.useFakeTimers();
    const { clientWs } = await connectClient();

    await triggerTimeouts(3);
    expect(client.getCircuitBreakerState().suspended).toBe(true);

    // Next request should fast-fail without waiting for REQUEST_TIMEOUT
    const start = Date.now();
    await expect(client.getDiagnostics()).rejects.toThrow(
      ExtensionTimeoutError,
    );
    expect(Date.now() - start).toBeLessThan(100);

    clientWs.close();
    vi.useRealTimers();
  });

  it("success after circuit recovers resets failure times", async () => {
    vi.useFakeTimers();
    const { clientWs } = await connectClient();

    // Open the circuit
    await triggerTimeouts(3);
    expect(client.getCircuitBreakerState().suspended).toBe(true);

    // Advance past backoff window (generous margin for jitter)
    await vi.advanceTimersByTimeAsync(100_000);
    expect(client.getCircuitBreakerState().suspended).toBe(false);

    // Respond successfully to the probe
    clientWs.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf-8"));
      clientWs.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: [] }));
    });

    await client.getDiagnostics();

    const state = client.getCircuitBreakerState();
    expect(state.failures).toBe(0);
    expect(state.suspended).toBe(false);
    expect(state.suspendedUntil).toBe(0);

    clientWs.close();
  });

  it("new extension connection resets circuit breaker state", async () => {
    vi.useFakeTimers();
    const { clientWs } = await connectClient();

    await triggerTimeouts(3);
    expect(client.getCircuitBreakerState().suspended).toBe(true);

    // Simulate a new extension connecting
    const serverConn2 = new Promise<WebSocket>((resolve) => {
      wss.once("connection", resolve);
    });
    const clientWs2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(clientWs2);
    const serverWs2 = await serverConn2;
    client.handleExtensionConnection(serverWs2);

    const state = client.getCircuitBreakerState();
    expect(state.failures).toBe(0);
    expect(state.suspended).toBe(false);
    expect(state.suspendedUntil).toBe(0);

    clientWs.close();
    clientWs2.close();
  });
});
