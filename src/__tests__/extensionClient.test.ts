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
  client.disconnect();
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
});

describe("ExtensionClient", () => {
  it("isConnected returns false initially", () => {
    expect(client.isConnected()).toBe(false);
  });

  it("connects and reports isConnected true", async () => {
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });

    // Simulate extension connecting to bridge
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;

    // Bridge receives connection from extension and hands it to client
    client.handleExtensionConnection(serverWs);
    expect(client.isConnected()).toBe(true);

    ws.close();
  });

  it("handles request/response cycle", async () => {
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    // Extension side: respond to requests
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf-8"));
      if (msg.method === "extension/getSelection") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              file: "/test.ts",
              startLine: 1,
              startColumn: 1,
              endLine: 1,
              endColumn: 5,
              selectedText: "test",
            },
          }),
        );
      }
    });

    const selection = await client.getSelection();
    expect(selection).not.toBeNull();
    expect(selection?.file).toBe("/test.ts");
    expect(selection?.selectedText).toBe("test");

    ws.close();
  });

  it("returns null when not connected", async () => {
    const result = await client.getDiagnostics();
    expect(result).toBeNull();
  });

  it("handles push notifications updating cached state", async () => {
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    // Send a push notification from extension
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "extension/selectionChanged",
        params: {
          file: "/hello.ts",
          startLine: 10,
          startColumn: 1,
          endLine: 10,
          endColumn: 20,
          selectedText: "selected text",
        },
      }),
    );

    // Wait a tick for message processing
    await new Promise((r) => setTimeout(r, 50));

    expect(client.latestSelection).not.toBeNull();
    expect(client.latestSelection?.file).toBe("/hello.ts");
    expect(client.latestSelection?.selectedText).toBe("selected text");

    ws.close();
  });

  it("handles disconnection gracefully", async () => {
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);
    expect(client.isConnected()).toBe(true);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(client.isConnected()).toBe(false);
  });

  it("backoff starts inactive", () => {
    const state = client.getCircuitBreakerState();
    expect(state.suspended).toBe(false);
    expect(state.failures).toBe(0);
  });

  it("suspends after first timeout with exponential backoff", async () => {
    vi.useFakeTimers();
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    // One request that times out (no response)
    const request = client.getDiagnostics().catch(() => null);
    await vi.advanceTimersByTimeAsync(10_001); // just past REQUEST_TIMEOUT
    await request;

    const state = client.getCircuitBreakerState();
    expect(state.suspended).toBe(true);
    expect(state.failures).toBe(1);

    ws.close();
    vi.useRealTimers();
  });

  it("backoff resets to inactive on reconnect", async () => {
    // Establish both connections with real timers first, then switch to fake timers
    const connections: WebSocket[] = [];
    wss.on("connection", (ws) => connections.push(ws));

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws1);
    await waitForOpen(ws2);
    await new Promise((r) => setTimeout(r, 50)); // let server-side events settle

    vi.useFakeTimers();
    try {
      // Trigger suspension via the first connection
      client.handleExtensionConnection(connections[0]!);
      const request = client.getDiagnostics().catch(() => null);
      await vi.advanceTimersByTimeAsync(10_001);
      await request;
      expect(client.getCircuitBreakerState().suspended).toBe(true);

      // Reconnect via the second server-side socket — backoff should reset immediately
      client.handleExtensionConnection(connections[1]!);
      const state = client.getCircuitBreakerState();
      expect(state.suspended).toBe(false);
      expect(state.failures).toBe(0);
    } finally {
      vi.useRealTimers();
      ws1.close();
      ws2.close();
      await new Promise((r) => setTimeout(r, 50));
    }
  }, 10_000);

  it("clears diagnosticsListeners on extension disconnect to prevent listener leak", async () => {
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    // Simulate watchDiagnostics adding a listener
    const remove1 = client.addDiagnosticsListener(() => {});
    const remove2 = client.addDiagnosticsListener(() => {});
    void remove1; void remove2; // suppress unused warning

    // Verify listeners were added (via side-effect: disconnect should clear them)
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(client.isConnected()).toBe(false);

    // After disconnect, adding a new listener and reconnecting should start fresh
    const connections: WebSocket[] = [];
    wss.on("connection", (ws2) => connections.push(ws2));
    const ws3 = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws3);
    await new Promise((r) => setTimeout(r, 30));

    client.handleExtensionConnection(connections[0]!);

    // Add one listener to the new session
    let callCount = 0;
    client.addDiagnosticsListener(() => { callCount++; });

    // Send a diagnosticsChanged notification FROM the extension side (ws3) to the bridge
    ws3.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "extension/diagnosticsChanged",
      params: { file: "/foo.ts", diagnostics: [{ file: "/foo.ts", line: 1, column: 1, severity: "error", message: "oops" }] },
    }));
    await new Promise((r) => setTimeout(r, 50));

    // Only the one new listener should fire — not the two stale ones from before disconnect
    expect(callCount).toBe(1);

    ws3.close();
  });

  it("logs warning on extension/hello major version mismatch", async () => {
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    // Spy on the logger — Logger exposes .warn() publicly
    const warnSpy = vi.spyOn(client["logger" as never] as { warn: (msg: string) => void }, "warn");

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "extension/hello",
        params: { extensionVersion: "99.0.0", vscodeVersion: "1.85.0" },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("major version mismatch"));

    ws.close();
  });

  it("circuit breaker fast-fails when open", async () => {
    vi.useFakeTimers();
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    // Trigger suspension (1 timeout = 1s backoff)
    const triggerRequest = client.getDiagnostics().catch(() => null);
    await vi.advanceTimersByTimeAsync(10_001); // just past REQUEST_TIMEOUT
    await triggerRequest;
    expect(client.getCircuitBreakerState().suspended).toBe(true);

    // Next request should throw ExtensionTimeoutError immediately (still within 1s backoff)
    const start = Date.now();
    await expect(client.getDiagnostics()).rejects.toThrow(ExtensionTimeoutError);
    expect(Date.now() - start).toBeLessThan(100); // synchronous fast-fail

    ws.close();
    vi.useRealTimers();
  });
});
