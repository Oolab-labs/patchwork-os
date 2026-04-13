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

afterEach(() => {
  vi.useRealTimers();
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

  it("getSelection returns null when handler returns an error object (tryRequest)", async () => {
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf-8"));
      if (msg.method === "extension/getSelection") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { error: "No active editor" },
          }),
        );
      }
    });

    // Extension error-object response must NOT leak through as a valid SelectionState.
    const selection = await client.getSelection();
    expect(selection).toBeNull();

    ws.close();
  });

  it("getWorkspaceFolders unwraps { folders, count } response (validatedRequest)", async () => {
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf-8"));
      if (msg.method === "extension/getWorkspaceFolders") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              folders: [
                { name: "root", path: "/ws", uri: "file:///ws", index: 0 },
                { name: "sub", path: "/ws2", uri: "file:///ws2", index: 1 },
              ],
              count: 2,
            },
          }),
        );
      }
    });

    const folders = await client.getWorkspaceFolders();
    expect(folders).not.toBeNull();
    expect(Array.isArray(folders)).toBe(true);
    expect(folders?.length).toBe(2);
    expect(folders?.[0]?.path).toBe("/ws");

    ws.close();
  });

  it("getWorkspaceFolders accepts legacy array-shape response", async () => {
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf-8"));
      if (msg.method === "extension/getWorkspaceFolders") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: [
              {
                name: "legacy",
                path: "/legacy",
                uri: "file:///legacy",
                index: 0,
              },
            ],
          }),
        );
      }
    });

    const folders = await client.getWorkspaceFolders();
    expect(folders).not.toBeNull();
    expect(folders?.length).toBe(1);
    expect(folders?.[0]?.path).toBe("/legacy");

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

  it("suspends after 3 timeouts within the 30s window (windowed circuit breaker)", async () => {
    vi.useFakeTimers();
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    // Three requests that time out — circuit opens only after the 3rd
    for (let i = 0; i < 3; i++) {
      const request = client.getDiagnostics().catch(() => null);
      await vi.advanceTimersByTimeAsync(10_001);
      await request;
    }

    const state = client.getCircuitBreakerState();
    expect(state.suspended).toBe(true);
    expect(state.failures).toBe(3);

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
      // Trigger suspension via the first connection (3 timeouts needed)
      client.handleExtensionConnection(connections[0]!);
      for (let i = 0; i < 3; i++) {
        const request = client.getDiagnostics().catch(() => null);
        await vi.advanceTimersByTimeAsync(10_001);
        await request;
      }
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
  });

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
    void remove1;
    void remove2; // suppress unused warning

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
    client.addDiagnosticsListener(() => {
      callCount++;
    });

    // Send a diagnosticsChanged notification FROM the extension side (ws3) to the bridge
    ws3.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "extension/diagnosticsChanged",
        params: {
          file: "/foo.ts",
          diagnostics: [
            {
              file: "/foo.ts",
              line: 1,
              column: 1,
              severity: "error",
              message: "oops",
            },
          ],
        },
      }),
    );
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
    const warnSpy = vi.spyOn(
      client["logger" as never] as { warn: (msg: string) => void },
      "warn",
    );

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "extension/hello",
        params: { extensionVersion: "99.0.0", vscodeVersion: "1.85.0" },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("major version mismatch"),
    );

    ws.close();
  });

  it("disconnect() does not fire onExtensionDisconnected (spurious-callback fix)", async () => {
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);
    expect(client.isConnected()).toBe(true);

    let callCount = 0;
    client.onExtensionDisconnected = () => {
      callCount++;
    };

    // Bridge-initiated shutdown: disconnect() must NOT trigger the callback
    client.disconnect();
    // Give the async "close" event time to fire (it would have, before the fix)
    await new Promise((r) => setTimeout(r, 100));

    expect(callCount).toBe(0);
    ws.close();
  });

  it("diagnosticsChanged forwards sanitized data, not raw fields", async () => {
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    let received: unknown[] = [];
    client.addDiagnosticsListener((_file, diags) => {
      received = diags as unknown[];
    });

    // Send a notification with a wrong-typed field (line is a string) and an
    // extra unexpected field (__proto__) that must not appear in the output.
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "extension/diagnosticsChanged",
        params: {
          file: "/bad.ts",
          diagnostics: [
            {
              file: "/bad.ts",
              line: "not-a-number", // wrong type — should be sanitized to undefined
              column: 5,
              severity: "error",
              message: "oops",
              extra: "should be dropped", // unknown field
            },
          ],
        },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    const d = received[0] as Record<string, unknown>;
    // Wrong-typed field becomes undefined
    expect(d.line).toBeUndefined();
    // Valid field is preserved
    expect(d.column).toBe(5);
    expect(d.message).toBe("oops");
    // Unknown field is stripped
    expect("extra" in d).toBe(false);

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

    // Trigger suspension (3 timeouts within 30s window open the circuit)
    for (let i = 0; i < 3; i++) {
      const request = client.getDiagnostics().catch(() => null);
      await vi.advanceTimersByTimeAsync(10_001);
      await request;
    }
    expect(client.getCircuitBreakerState().suspended).toBe(true);

    // Next request should throw ExtensionTimeoutError immediately (circuit open)
    const start = Date.now();
    await expect(client.getDiagnostics()).rejects.toThrow(
      ExtensionTimeoutError,
    );
    expect(Date.now() - start).toBeLessThan(100); // synchronous fast-fail

    ws.close();
    vi.useRealTimers();
  });

  it("circuit breaker rejects in-flight requests immediately when circuit opens (2d)", async () => {
    vi.useFakeTimers();
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    // Start 3 early requests at t=0 — all time out at t=10001ms, opening the circuit.
    // A 4th request (req2) is started at t=1s; its own timeout would fire at t=11001ms.
    // When the 3 early requests expire at t=10001ms, the circuit opens and
    // rejectAllPending() clears req2 before its own timeout fires.
    client.getDiagnostics().catch(() => null); // early-a
    client.getDiagnostics().catch(() => null); // early-b
    client.getDiagnostics().catch(() => null); // early-c

    // Advance 1s — the 3 early requests are still in-flight
    await vi.advanceTimersByTimeAsync(1_000);

    // Start req2 AFTER the 3 early requests — timeout would fire at t=11001ms
    const req2 = client.getSelection();

    // Advance to just past the 3 early timeouts (total ~10001ms)
    // All 3 expire → circuit opens → rejectAllPending() → req2 cleared immediately
    await vi.advanceTimersByTimeAsync(9_001);

    // req2's own timeout (at t=11001ms) has NOT fired yet (we are at ~10001ms).
    // req2 should already be settled via rejectAllPending, not still pending.
    expect((client as any).pendingRequests.size).toBe(0);
    expect(client.getCircuitBreakerState().suspended).toBe(true);

    const result2 = await req2; // resolves immediately — already settled
    expect(result2).toBeNull(); // proxy converts rejection → null (fast-fail via rejectAllPending)

    ws.close();
    vi.useRealTimers();
  });

  it("tracks lspReady notifications per language", async () => {
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    expect(client.lspReadyLanguages.size).toBe(0);

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "extension/lspReady",
        params: { languageId: "typescript", timestamp: Date.now() },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(client.lspReadyLanguages.has("typescript")).toBe(true);
    expect(client.lspReadyLanguages.has("python")).toBe(false);

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "extension/lspReady",
        params: { languageId: "python", timestamp: Date.now() },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(client.lspReadyLanguages.has("python")).toBe(true);
    expect(client.lspReadyLanguages.size).toBe(2);

    ws.close();
  });

  it("clears lspReadyLanguages on reconnect", async () => {
    // First connection
    const conn1 = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws1);
    const serverWs1 = await conn1;
    client.handleExtensionConnection(serverWs1);

    ws1.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "extension/lspReady",
        params: { languageId: "typescript", timestamp: Date.now() },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(client.lspReadyLanguages.has("typescript")).toBe(true);

    // Reconnect — should clear
    const conn2 = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws2);
    const serverWs2 = await conn2;
    client.handleExtensionConnection(serverWs2);

    expect(client.lspReadyLanguages.size).toBe(0);

    ws1.close();
    ws2.close();
  });

  it("ignores malformed lspReady notifications", async () => {
    const serverConn = new Promise<WebSocket>((resolve) => {
      wss.on("connection", resolve);
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);
    const serverWs = await serverConn;
    client.handleExtensionConnection(serverWs);

    // Missing languageId
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "extension/lspReady",
        params: { timestamp: Date.now() },
      }),
    );
    // Non-string languageId
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "extension/lspReady",
        params: { languageId: 42, timestamp: Date.now() },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(client.lspReadyLanguages.size).toBe(0);

    ws.close();
  });
});
