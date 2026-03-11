/**
 * Tests for the exponential backoff / circuit-breaker in ExtensionClient.
 * These focus on the atomicity fix: ++this.extensionFailures captured before
 * computing backoffMs, so concurrent failures don't race.
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

describe("ExtensionClient exponential backoff atomicity", () => {
  it("after first timeout: failures=1, suspendedUntil ≈ now+1000ms, suspended=true", async () => {
    vi.useFakeTimers();
    const { clientWs } = await connectClient();

    const before = Date.now();
    const req = client.getDiagnostics().catch(() => null);
    await vi.advanceTimersByTimeAsync(10_001); // past REQUEST_TIMEOUT
    await req;

    const state = client.getCircuitBreakerState();
    expect(state.failures).toBe(1);
    expect(state.suspended).toBe(true);
    // suspendedUntil should be ~now + 1000ms (2^0 * 1000)
    expect(state.suspendedUntil).toBeGreaterThanOrEqual(before + 1000);
    expect(state.suspendedUntil).toBeLessThanOrEqual(
      before + 10_001 + 1000 + 50,
    );

    clientWs.close();
  });

  it("after second timeout: failures=2, suspendedUntil ≈ now+2000ms", async () => {
    vi.useFakeTimers();
    const { clientWs } = await connectClient();

    // First timeout
    const req1 = client.getDiagnostics().catch(() => null);
    await vi.advanceTimersByTimeAsync(10_001);
    await req1;

    // Advance past the first backoff window so the second request is sent
    await vi.advanceTimersByTimeAsync(1_001);

    // Second timeout — circuit is now open again, send request
    // Need to advance past the suspension window first
    // At this point suspended=false (1001ms elapsed, backoff was 1000ms)
    const before2 = Date.now();
    const req2 = client.getDiagnostics().catch(() => null);
    await vi.advanceTimersByTimeAsync(10_001);
    await req2;

    const state = client.getCircuitBreakerState();
    expect(state.failures).toBe(2);
    expect(state.suspended).toBe(true);
    // backoff for failure #2 = 2^1 * 1000 = 2000ms
    expect(state.suspendedUntil).toBeGreaterThanOrEqual(before2 + 2000);

    clientWs.close();
  });

  it("after success following suspension: failures=0, suspended=false", async () => {
    vi.useFakeTimers();
    const { clientWs } = await connectClient();

    // Trigger a timeout to activate suspension
    const req = client.getDiagnostics().catch(() => null);
    await vi.advanceTimersByTimeAsync(10_001);
    await req;
    expect(client.getCircuitBreakerState().suspended).toBe(true);

    // Advance past the backoff window
    await vi.advanceTimersByTimeAsync(1_001);
    expect(client.getCircuitBreakerState().suspended).toBe(false);

    // Now respond successfully to the next request
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

  it("fast-fail during suspension window: throws ExtensionTimeoutError immediately", async () => {
    vi.useFakeTimers();
    const { clientWs } = await connectClient();

    // Trigger suspension
    const req = client.getDiagnostics().catch(() => null);
    await vi.advanceTimersByTimeAsync(10_001);
    await req;
    expect(client.getCircuitBreakerState().suspended).toBe(true);

    // Immediately try another request — should fast-fail without waiting for timeout
    const start = Date.now();
    await expect(client.getDiagnostics()).rejects.toThrow(
      ExtensionTimeoutError,
    );
    // Should be nearly instantaneous (not waiting 10s)
    expect(Date.now() - start).toBeLessThan(100);

    clientWs.close();
    vi.useRealTimers();
  });
});
