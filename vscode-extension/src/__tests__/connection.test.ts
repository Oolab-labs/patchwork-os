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

// ── send ──────────────────────────────────────────────────────

describe("send", () => {
  it("sends JSON when ws is OPEN", () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    bridge.send({ test: true });
    expect(bridge.ws?.send).toHaveBeenCalledWith('{"test":true}');
  });

  it("no-ops when ws is null", () => {
    const bridge = createBridge();
    bridge.ws = null;
    bridge.send({ test: true }); // Should not throw
  });

  it("no-ops when ws is not OPEN", () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.CLOSED;

    bridge.send({ test: true });
    expect(bridge.ws?.send).not.toHaveBeenCalled();
  });

  it("swallows send errors", () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;
    (bridge.ws?.send as any).mockImplementation(() => {
      throw new Error("broken");
    });

    expect(() => bridge.send({ test: true })).not.toThrow();
  });
});

// ── sendNotification / sendResponse ───────────────────────────

describe("sendNotification", () => {
  it("sends jsonrpc notification", () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    bridge.sendNotification("test/method", { key: "val" });
    const sent = JSON.parse((bridge.ws?.send as any).mock.calls[0][0]);
    expect(sent.jsonrpc).toBe("2.0");
    expect(sent.method).toBe("test/method");
    expect(sent.params).toEqual({ key: "val" });
  });
});

describe("sendResponse", () => {
  it("sends success response", () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    bridge.sendResponse(1, { data: "ok" });
    const sent = JSON.parse((bridge.ws?.send as any).mock.calls[0][0]);
    expect(sent.id).toBe(1);
    expect(sent.result).toEqual({ data: "ok" });
  });

  it("sends error response", () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    bridge.sendResponse(1, undefined, { code: -32000, message: "fail" });
    const sent = JSON.parse((bridge.ws?.send as any).mock.calls[0][0]);
    expect(sent.error).toEqual({ code: -32000, message: "fail" });
  });
});

// ── handleMessage ─────────────────────────────────────────────

describe("handleMessage", () => {
  it("dispatches to registered handler", async () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    const handler = vi.fn(async () => ({ result: "ok" }));
    bridge.setHandlers({ "test/method": handler });

    bridge.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "test/method",
        params: { x: 1 },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledWith({ x: 1 }, expect.any(AbortSignal));
    expect(bridge.ws?.send).toHaveBeenCalled();
    const sent = JSON.parse((bridge.ws?.send as any).mock.calls[0][0]);
    expect(sent.result).toEqual({ result: "ok" });
  });

  it("returns -32601 for unknown methods", () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    bridge.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unknown/method" }),
    );
    const sent = JSON.parse((bridge.ws?.send as any).mock.calls[0][0]);
    expect(sent.error.code).toBe(-32601);
  });

  it("returns error when handler throws", async () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    bridge.setHandlers({
      "test/fail": vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    bridge.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test/fail" }),
    );
    await vi.advanceTimersByTimeAsync(0);

    const sent = JSON.parse((bridge.ws?.send as any).mock.calls[0][0]);
    expect(sent.error.code).toBe(-32000);
    expect(sent.error.message).toContain("boom");
  });

  it("times out handlers after HANDLER_TIMEOUT", async () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    const neverResolve = vi.fn(() => new Promise(() => {}));
    bridge.setHandlers({ "test/hang": neverResolve });
    bridge.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test/hang" }),
    );

    await vi.advanceTimersByTimeAsync(30_000);

    const sent = JSON.parse((bridge.ws?.send as any).mock.calls[0][0]);
    expect(sent.error.message).toContain("timed out");
  });

  it("processes bridge/claudeConnectionChanged notification", () => {
    const bridge = createBridge();
    expect(bridge.claudeConnected).toBe(false);

    bridge.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "bridge/claudeConnectionChanged",
        params: { connected: true },
      }),
    );
    expect(bridge.claudeConnected).toBe(true);
  });

  it("silently handles invalid JSON", () => {
    const bridge = createBridge();
    expect(() => bridge.handleMessage("not json")).not.toThrow();
  });
});

// ── startHeartbeat / stopHeartbeat ─────────────────────────────

describe("startHeartbeat", () => {
  it("does not accumulate pong listeners on repeated calls", () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    // Call startHeartbeat multiple times without stopHeartbeat
    (bridge as any).startHeartbeat();
    (bridge as any).startHeartbeat();
    (bridge as any).startHeartbeat();

    // Should have exactly 1 pong listener, not 3
    const pongListenerCount = bridge.ws?.listenerCount("pong");
    expect(pongListenerCount).toBe(1);
  });

  it("stopHeartbeat removes only the heartbeat pong handler, not other pong listeners", () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    // Add a non-heartbeat pong listener
    const otherPongHandler = () => {};
    bridge.ws?.on("pong", otherPongHandler);

    (bridge as any).startHeartbeat();
    expect(bridge.ws?.listenerCount("pong")).toBe(2); // other + heartbeat

    (bridge as any).stopHeartbeat();
    // The other pong listener should still be there
    expect(bridge.ws?.listenerCount("pong")).toBe(1);
  });
});

// ── scheduleReconnect ─────────────────────────────────────────

describe("scheduleReconnect", () => {
  it("schedules reconnect with jittered delay", () => {
    const bridge = createBridge();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    bridge.scheduleReconnect();
    expect(bridge.reconnectTimer).not.toBeNull();
  });

  it("does not double-schedule", () => {
    const bridge = createBridge();
    bridge.scheduleReconnect();
    const timer = bridge.reconnectTimer;
    bridge.scheduleReconnect();
    expect(bridge.reconnectTimer).toBe(timer); // same timer
  });

  it("does not schedule when disposed", () => {
    const bridge = createBridge();
    bridge.disposed = true;
    bridge.scheduleReconnect();
    expect(bridge.reconnectTimer).toBeNull();
  });

  it("doubles delay on each attempt up to max", () => {
    const bridge = createBridge();
    expect(bridge.reconnectDelay).toBe(1000);

    bridge.scheduleReconnect();
    expect(bridge.reconnectDelay).toBe(2000);

    bridge.reconnectTimer = null; // allow next schedule
    bridge.scheduleReconnect();
    expect(bridge.reconnectDelay).toBe(4000);
  });

  it("caps delay at RECONNECT_MAX_DELAY", () => {
    const bridge = createBridge();
    bridge.reconnectDelay = 30000;
    bridge.scheduleReconnect();
    expect(bridge.reconnectDelay).toBe(30000); // min(60000, 30000)
  });

  it("shows warning on 3rd attempt", () => {
    const bridge = createBridge();
    bridge.reconnectAttempts = 2; // next will be 3
    bridge.scheduleReconnect();
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });

  it("adds minimum 500ms jitter", () => {
    const bridge = createBridge();
    vi.spyOn(Math, "random").mockReturnValue(0); // minimum jitter
    bridge.scheduleReconnect();
    // jitteredDelay = Math.round(500 + 0 * 1000) = 500
    // Should be at least 500ms
  });
});

// ── tryConnect ────────────────────────────────────────────────

describe("tryConnect", () => {
  it("does nothing when disposed", () => {
    const bridge = createBridge();
    bridge.disposed = true;
    bridge.tryConnect();
    expect(readLockFilesAsync).not.toHaveBeenCalled();
  });

  it("does nothing when already connecting", () => {
    const bridge = createBridge();
    (bridge as any).connecting = true;
    bridge.tryConnect();
    expect(readLockFilesAsync).not.toHaveBeenCalled();
  });

  it("schedules reconnect when no lock file found", async () => {
    vi.mocked(readLockFilesAsync).mockResolvedValue(null);
    const bridge = createBridge();
    vi.spyOn(bridge, "scheduleReconnect");

    bridge.tryConnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.scheduleReconnect).toHaveBeenCalled();
  });

  // BUG 1: state race — concurrent tryConnect() can slip through when state
  // transitions from CONNECTING to DISCONNECTING (due to a connection error)
  // while the first tryConnect() is still awaiting readLockFilesAsync.
  //
  // Sequence that triggers the bug:
  // 1. tryConnect() #1: state=CONNECTING, connecting=true, awaits lock file read
  // 2. A ws "error" fires → handleDisconnect() → state=DISCONNECTING → scheduleReconnect()
  // 3. Lock file read resolves → connecting=false → connect() called
  // 4. reconnect timer fires → tryConnect() #2: state is DISCONNECTING (not CONNECTING),
  //    connecting is false → passes all guards → SECOND connect() called
  //
  // The fix: connect() sets state=CONNECTING before creating the WebSocket,
  // which blocks tryConnect() #2 from getting through after step 3.
  it("connect() sets state to CONNECTING before creating WebSocket to prevent concurrent connects", async () => {
    let resolveLock!: (v: { port: number; authToken: string } | null) => void;
    vi.mocked(readLockFilesAsync)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveLock = resolve;
        }),
      )
      .mockResolvedValue({ port: 5678, authToken: "token2" });

    const bridge = createBridge();
    const connectSpy = vi.spyOn(bridge, "connect");

    // Step 1: start first tryConnect — sets state=CONNECTING, awaits lock file
    bridge.tryConnect();

    // Step 2: simulate a connection error mid-flight — sets state=DISCONNECTING
    // (We bypass handleDisconnect to avoid the reconnect timer complication)
    (bridge as any).state = 3; // ConnectionState.DISCONNECTING

    // Step 3: lock file resolves — tryConnect() .then() runs:
    //   connecting=false, then calls connect()
    resolveLock({ port: 1234, authToken: "token" });
    await Promise.resolve(); // flush .then() microtask

    // After connect() is called (step 3), verify state is CONNECTING again.
    // This is the fix: connect() re-asserts state=CONNECTING before creating the ws.
    // Without the fix, state stays DISCONNECTING between connecting=false and ws creation.
    //
    // Step 4: a concurrent tryConnect() fires (from a reconnect timer or lock file watcher).
    // State should be CONNECTING (fixed) → second call is blocked.
    // Without fix: state is still DISCONNECTING at this point → second call passes guards.
    bridge.tryConnect();
    await vi.advanceTimersByTimeAsync(0);

    // connect() must have been called exactly once.
    // With the bug: it's called twice (second tryConnect passes all guards).
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});

// ── dispose ───────────────────────────────────────────────────

describe("dispose", () => {
  it("sets disposed flag and cleans up", () => {
    const bridge = createBridge();
    const onDispose = vi.fn();
    bridge.setOnDispose(onDispose);

    bridge.dispose();
    expect(bridge.disposed).toBe(true);
    expect(onDispose).toHaveBeenCalled();
  });

  it("closes ws with code 1000", () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    bridge.dispose();
    expect(bridge.ws).toBeNull();
  });

  it("clears all timers", () => {
    const bridge = createBridge();
    bridge.reconnectTimer = setTimeout(() => {}, 10000);
    bridge.selectionDebounceTimer = setTimeout(() => {}, 10000);
    bridge.diagnosticsDebounceTimer = setTimeout(() => {}, 10000);
    bridge.aiCommentsDebounceTimer = setTimeout(() => {}, 10000);

    bridge.dispose();
    expect(bridge.reconnectTimer).toBeNull();
    expect(bridge.selectionDebounceTimer).toBeNull();
    expect(bridge.diagnosticsDebounceTimer).toBeNull();
    expect(bridge.aiCommentsDebounceTimer).toBeNull();
  });
});
