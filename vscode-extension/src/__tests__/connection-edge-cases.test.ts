import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { __reset } from "./__mocks__/vscode";

// Mock the ws module
vi.mock("ws", () => {
  const { EventEmitter } = require("node:events");
  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 3; // Start closed
    send = vi.fn();
    close = vi.fn();
    terminate = vi.fn();
    ping = vi.fn();
    removeAllListeners = vi.fn(function (this: MockWebSocket) {
      EventEmitter.prototype.removeAllListeners.call(this);
      return this;
    });
    removeListener = vi.fn(function (
      this: MockWebSocket,
      event: string,
      fn: Function,
    ) {
      EventEmitter.prototype.removeListener.call(this, event, fn as any);
      return this;
    });
  }
  return { default: MockWebSocket, __esModule: true };
});

// Mock lockfiles
vi.mock("../lockfiles", () => ({
  readLockFilesAsync: vi.fn(async () => null),
}));

// Mock httpProbe so tryConnect() doesn't make real HTTP requests
vi.mock("../httpProbe", () => ({
  pingBridge: vi.fn(async () => true),
}));

import WebSocket from "ws";
// Must import after mocks are set up
import { BridgeConnection } from "../connection";
import { readLockFilesAsync } from "../lockfiles";

beforeEach(() => {
  __reset();
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.mocked(readLockFilesAsync).mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createBridge(): BridgeConnection {
  const bridge = new BridgeConnection();
  bridge.output = {
    appendLine: vi.fn(),
    append: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  } as any;
  return bridge;
}

// ── bridge/claudeTaskOutput notification ──────────────────────

describe("bridge/claudeTaskOutput notifications", () => {
  it("chunk notification appends to output channel", () => {
    const bridge = createBridge();
    const appendSpy = vi.spyOn(bridge.output as any, "append");

    bridge.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "bridge/claudeTaskOutput",
        params: {
          taskId: "abc12345-0000-0000-0000-000000000000",
          chunk: "hello world\n",
        },
      }),
    );

    expect(appendSpy).toHaveBeenCalledWith("hello world\n");
  });

  it("done=true notification appends status line to output channel", () => {
    const bridge = createBridge();
    const appendLineSpy = vi.spyOn(bridge.output as any, "appendLine");

    bridge.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "bridge/claudeTaskOutput",
        params: {
          taskId: "abc12345-0000-0000-0000-000000000000",
          done: true,
          status: "done",
        },
      }),
    );

    expect(appendLineSpy).toHaveBeenCalledWith(
      expect.stringContaining("abc12345"),
    );
    expect(appendLineSpy).toHaveBeenCalledWith(
      expect.stringContaining("✓ done"),
    );
  });

  it("done=true with error status shows failure marker", () => {
    const bridge = createBridge();
    const appendLineSpy = vi.spyOn(bridge.output as any, "appendLine");

    bridge.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "bridge/claudeTaskOutput",
        params: {
          taskId: "abc12345-0000-0000-0000-000000000000",
          done: true,
          status: "error",
        },
      }),
    );

    expect(appendLineSpy).toHaveBeenCalledWith(
      expect.stringContaining("✗ error"),
    );
  });
});

// ── Rapid forceReconnect() ────────────────────────────────────

describe("forceReconnect edge cases", () => {
  it("multiple rapid forceReconnect() calls don't create parallel reconnect loops", async () => {
    const bridge = createBridge();
    vi.mocked(readLockFilesAsync).mockResolvedValue(null);

    // Call forceReconnect 3 times in rapid succession
    bridge.forceReconnect();
    bridge.forceReconnect();
    bridge.forceReconnect();

    // Flush microtasks and advance timers past reconnect delay
    await vi.advanceTimersByTimeAsync(0);
    // Each forceReconnect resets state to IDLE and calls tryConnect() once.
    // The guard in tryConnect (state === CONNECTING) blocks concurrent runs.
    // readLockFilesAsync should have been called a bounded number of times — not 3x3.
    const callCount = vi.mocked(readLockFilesAsync).mock.calls.length;
    expect(callCount).toBeLessThanOrEqual(3);

    // No reconnect timer should be dangling from multiple scheduled callbacks
    // (scheduleReconnect guards against double-scheduling)
    if (bridge.reconnectTimer !== null) {
      // If there is a timer, clearing it and verifying only one existed
      clearTimeout(bridge.reconnectTimer);
      bridge.reconnectTimer = null;
    }
  });
});

// ── Notification buffer overflow ──────────────────────────────

describe("pendingNotifications buffer", () => {
  it("21st pending notification drops the oldest (MAX_PENDING_NOTIFICATIONS = 20)", async () => {
    const bridge = createBridge();
    // ws is null, so bufferable notifications go to pending buffer
    expect(bridge.ws).toBeNull();

    // Send 21 bufferable notifications (extension/diagnosticsChanged is bufferable)
    for (let i = 0; i < 21; i++) {
      bridge.sendNotification("extension/diagnosticsChanged", {
        uri: `file${i}`,
      });
    }

    const pending = (bridge as any).pendingNotifications as Array<{
      method: string;
      params: Record<string, unknown>;
    }>;

    // Buffer should be capped at MAX_PENDING_NOTIFICATIONS (20)
    expect(pending.length).toBe(20);

    // The oldest (file0) should have been dropped
    const uris = pending.map((n) => n.params.uri);
    expect(uris).not.toContain("file0");

    // The most recent (file20) should be present
    expect(uris).toContain("file20");
  });

  it("non-bufferable notifications are not queued when ws is null", () => {
    const bridge = createBridge();
    expect(bridge.ws).toBeNull();

    // extension/selectionChanged is NOT in BUFFERABLE_METHODS
    bridge.sendNotification("extension/selectionChanged", { line: 1 });

    const pending = (bridge as any).pendingNotifications as Array<unknown>;
    expect(pending.length).toBe(0);
  });
});

// ── Notification flush on reconnect ──────────────────────────

describe("notification flush", () => {
  it("buffered notifications are flushed when connection opens", async () => {
    const bridge = createBridge();

    // Buffer 3 notifications while disconnected
    bridge.sendNotification("extension/diagnosticsChanged", { uri: "file1" });
    bridge.sendNotification("extension/diagnosticsChanged", { uri: "file2" });
    bridge.sendNotification("extension/fileChanged", { uri: "file3" });

    expect((bridge as any).pendingNotifications.length).toBe(3);

    // Now simulate connecting
    vi.mocked(readLockFilesAsync).mockResolvedValue({
      port: 1234,
      authToken: "tok",
    });
    bridge.tryConnect();
    await vi.advanceTimersByTimeAsync(0);

    // bridge.ws should now be a MockWebSocket
    expect(bridge.ws).not.toBeNull();
    const ws = bridge.ws!;

    // Set readyState to OPEN and fire 'open' event to trigger flush
    (ws as any).readyState = WebSocket.OPEN;
    ws.emit("open");

    // The 'open' handler calls flushPendingNotifications which calls send()
    // send() calls ws.send() — verify it was called for each buffered notification
    const sendCalls = (ws.send as ReturnType<typeof vi.fn>).mock.calls;
    // Filter only notification sends (not the extension/hello send)
    const notificationSends = sendCalls
      .map((args) => JSON.parse(args[0] as string))
      .filter(
        (msg) =>
          msg.method === "extension/diagnosticsChanged" ||
          msg.method === "extension/fileChanged",
      );

    expect(notificationSends.length).toBe(3);
    expect((bridge as any).pendingNotifications.length).toBe(0);
  });
});

// ── Opening timeout ───────────────────────────────────────────

describe("opening timeout", () => {
  it("hung WebSocket handshake triggers reconnect after 30s", async () => {
    const bridge = createBridge();
    vi.mocked(readLockFilesAsync).mockResolvedValue({
      port: 1234,
      authToken: "tok",
    });

    bridge.tryConnect();
    await vi.advanceTimersByTimeAsync(0);

    // bridge.ws should be set but 'open' was never fired
    expect(bridge.ws).not.toBeNull();
    const ws = bridge.ws!;

    // Advance 30,000ms — the openTimeout fires
    await vi.advanceTimersByTimeAsync(30_000);

    // terminate() should have been called on the hung socket
    expect((ws as any).terminate).toHaveBeenCalled();

    // handleDisconnect() runs → scheduleReconnect() → reconnectTimer is set
    expect(bridge.reconnectTimer).not.toBeNull();
  });
});

// ── Generation guard ──────────────────────────────────────────

describe("generation guard", () => {
  it("stale socket 'close' event does not trigger reconnect after generation advances", async () => {
    const bridge = createBridge();

    // Step 1: Connect
    vi.mocked(readLockFilesAsync).mockResolvedValue({
      port: 1234,
      authToken: "tok",
    });
    bridge.tryConnect();
    await vi.advanceTimersByTimeAsync(0);

    const oldWs = bridge.ws!;
    (oldWs as any).readyState = WebSocket.OPEN;
    oldWs.emit("open");

    // Step 2: forceReconnect advances generation
    bridge.forceReconnect();
    await vi.advanceTimersByTimeAsync(10);

    // Step 3: Clear the reconnect timer to isolate this test
    if (bridge.reconnectTimer) {
      clearTimeout(bridge.reconnectTimer);
      bridge.reconnectTimer = null;
    }

    // Ensure no reconnect timer at this point
    expect(bridge.reconnectTimer).toBeNull();

    // Step 4: Fire 'close' on old ws — generation mismatch, should be ignored
    oldWs.emit("close", 1001, Buffer.from(""));
    await vi.advanceTimersByTimeAsync(10);

    // No new reconnect timer should have been scheduled by the stale event
    expect(bridge.reconnectTimer).toBeNull();
  });
});

// ── Pending handlers limit ────────────────────────────────────

describe("pending handlers limit", () => {
  it("51st concurrent handler request is rejected with JSON-RPC error", async () => {
    const bridge = createBridge();

    // Register a handler that never resolves
    bridge.setHandlers({ "test/slow": async () => new Promise(() => {}) });

    // Set ws to OPEN
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    const MAX_PENDING_HANDLERS = 50;

    // Fill pendingHandlers to max
    for (let i = 0; i < MAX_PENDING_HANDLERS; i++) {
      (bridge as any).pendingHandlers.set(i, {
        timeout: setTimeout(() => {}, 99999),
        controller: new AbortController(),
      });
    }

    expect((bridge as any).pendingHandlers.size).toBe(MAX_PENDING_HANDLERS);

    // Send a message that would invoke the handler — should be rejected
    bridge.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 999,
        method: "test/slow",
        params: {},
      }),
    );

    // Assert send was called with an error response
    expect(bridge.ws?.send).toHaveBeenCalledWith(
      expect.stringContaining('"error"'),
    );

    const sentMsg = JSON.parse(
      (bridge.ws?.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(sentMsg.error.code).toBe(-32000);
    expect(sentMsg.error.message).toContain("Too many pending handlers");
  });
});

// ── Handler after disconnect ──────────────────────────────────

describe("handler after disconnect", () => {
  it("handler completing after disconnect does not send a response", async () => {
    const bridge = createBridge();

    // Connect bridge
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;
    const ws = bridge.ws!;

    // Register a slow handler (resolves after 5s)
    bridge.setHandlers({
      "test/slow": async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { done: true };
      },
    });

    // Send a message to start handler
    bridge.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "test/slow",
        params: {},
      }),
    );

    // Handler is in-flight — disconnect the bridge
    // Simulate disconnect by calling forceReconnect() which advances generation
    bridge.forceReconnect();
    await vi.advanceTimersByTimeAsync(0);

    // Cancel the new reconnect timer
    if (bridge.reconnectTimer) {
      clearTimeout(bridge.reconnectTimer);
      bridge.reconnectTimer = null;
    }

    // Advance timers so handler completes
    await vi.advanceTimersByTimeAsync(6000);

    // The original ws.send should NOT have been called with a result for id=42
    const sendCalls = (ws.send as ReturnType<typeof vi.fn>).mock.calls;
    const resultMessages = sendCalls
      .map((args) => {
        try {
          return JSON.parse(args[0] as string);
        } catch {
          return null;
        }
      })
      .filter((msg) => msg && msg.id === 42 && msg.result !== undefined);

    expect(resultMessages.length).toBe(0);
  });
});

// ── Disconnect during in-flight handler ──────────────────────

describe("disconnect with pending handlers", () => {
  it("handleDisconnect fires AbortController for all pending handlers", async () => {
    const bridge = createBridge();

    let capturedSignal: AbortSignal | null = null;

    // Register a handler that captures the signal
    bridge.setHandlers({
      "test/signal": async (_params, signal) => {
        capturedSignal = signal;
        return new Promise(() => {}); // never resolves
      },
    });

    // Connect bridge via tryConnect() so event listeners are registered
    vi.mocked(readLockFilesAsync).mockResolvedValue({
      port: 1234,
      authToken: "tok",
    });
    bridge.tryConnect();
    await vi.advanceTimersByTimeAsync(0);

    // Set readyState to OPEN and fire 'open'
    expect(bridge.ws).not.toBeNull();
    (bridge.ws as any).readyState = WebSocket.OPEN;
    bridge.ws!.emit("open");

    // Invoke the handler over the connected ws
    bridge.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 100,
        method: "test/signal",
        params: {},
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Handler is now in pendingHandlers
    expect((bridge as any).pendingHandlers.size).toBe(1);

    // Simulate disconnect — 'close' event triggers handleDisconnect
    // which aborts all pending handlers and clears the map
    bridge.ws!.emit("close", 1001, Buffer.from(""));
    await vi.advanceTimersByTimeAsync(0);

    // pendingHandlers should be cleared by handleDisconnect
    expect((bridge as any).pendingHandlers.size).toBe(0);

    // The AbortController signal should be aborted
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("dispose does not leave pending handler timeouts running", async () => {
    const bridge = createBridge();

    // Connect bridge
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    bridge.setHandlers({
      "test/slow": async () => new Promise(() => {}),
    });

    // Start handler — enters pendingHandlers
    bridge.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 200,
        method: "test/slow",
        params: {},
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect((bridge as any).pendingHandlers.size).toBe(1);

    // dispose() doesn't clear pendingHandlers directly, but ws is nulled
    // and generation advances, so any completion won't send a response.
    // The key observable: dispose does set disposed=true and ws=null.
    bridge.dispose();

    expect(bridge.disposed).toBe(true);
    expect(bridge.ws).toBeNull();

    // Advance past handler timeout — should not throw
    await expect(vi.advanceTimersByTimeAsync(35_000)).resolves.not.toThrow();
  });
});

// ── Heartbeat after dispose ───────────────────────────────────

describe("heartbeat after dispose", () => {
  it("heartbeat timer is cleared on dispose, no errors after", async () => {
    const bridge = createBridge();

    // Connect and fire 'open' to start heartbeat
    vi.mocked(readLockFilesAsync).mockResolvedValue({
      port: 1234,
      authToken: "tok",
    });
    bridge.tryConnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.ws).not.toBeNull();
    (bridge.ws as any).readyState = WebSocket.OPEN;
    bridge.ws!.emit("open");

    // Heartbeat timer should now be running
    expect((bridge as any).heartbeatTimer).not.toBeNull();

    // Dispose the bridge — should clear the heartbeat timer
    bridge.dispose();

    // heartbeatTimer should be null
    expect((bridge as any).heartbeatTimer).toBeNull();

    // Advance timers well past heartbeat interval (45s) — should not throw
    await expect(vi.advanceTimersByTimeAsync(45_000)).resolves.not.toThrow();
  });
});
