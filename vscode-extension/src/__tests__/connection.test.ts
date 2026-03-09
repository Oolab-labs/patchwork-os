import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __reset } from "./__mocks__/vscode";
import * as vscode from "vscode";

// Mock the ws module
vi.mock("ws", () => {
  const { EventEmitter } = require("events");
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
    removeListener = vi.fn(function (this: MockWebSocket, event: string, fn: Function) {
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

// Must import after mocks are set up
import { BridgeConnection } from "../connection";
import { readLockFilesAsync } from "../lockfiles";
import WebSocket from "ws";

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
    expect(bridge.ws!.send).toHaveBeenCalledWith('{"test":true}');
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
    expect(bridge.ws!.send).not.toHaveBeenCalled();
  });

  it("swallows send errors", () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;
    (bridge.ws!.send as any).mockImplementation(() => { throw new Error("broken"); });

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
    const sent = JSON.parse((bridge.ws!.send as any).mock.calls[0][0]);
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
    const sent = JSON.parse((bridge.ws!.send as any).mock.calls[0][0]);
    expect(sent.id).toBe(1);
    expect(sent.result).toEqual({ data: "ok" });
  });

  it("sends error response", () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    bridge.sendResponse(1, undefined, { code: -32000, message: "fail" });
    const sent = JSON.parse((bridge.ws!.send as any).mock.calls[0][0]);
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

    bridge.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test/method", params: { x: 1 } }));
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledWith({ x: 1 }, expect.any(AbortSignal));
    expect(bridge.ws!.send).toHaveBeenCalled();
    const sent = JSON.parse((bridge.ws!.send as any).mock.calls[0][0]);
    expect(sent.result).toEqual({ result: "ok" });
  });

  it("returns -32601 for unknown methods", () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    bridge.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unknown/method" }));
    const sent = JSON.parse((bridge.ws!.send as any).mock.calls[0][0]);
    expect(sent.error.code).toBe(-32601);
  });

  it("returns error when handler throws", async () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    bridge.setHandlers({ "test/fail": vi.fn(async () => { throw new Error("boom"); }) });
    bridge.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test/fail" }));
    await vi.advanceTimersByTimeAsync(0);

    const sent = JSON.parse((bridge.ws!.send as any).mock.calls[0][0]);
    expect(sent.error.code).toBe(-32000);
    expect(sent.error.message).toContain("boom");
  });

  it("times out handlers after HANDLER_TIMEOUT", async () => {
    const bridge = createBridge();
    bridge.ws = new WebSocket("ws://fake") as any;
    (bridge.ws as any).readyState = WebSocket.OPEN;

    const neverResolve = vi.fn(() => new Promise(() => {}));
    bridge.setHandlers({ "test/hang": neverResolve });
    bridge.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test/hang" }));

    await vi.advanceTimersByTimeAsync(30_000);

    const sent = JSON.parse((bridge.ws!.send as any).mock.calls[0][0]);
    expect(sent.error.message).toContain("timed out");
  });

  it("processes bridge/claudeConnectionChanged notification", () => {
    const bridge = createBridge();
    expect(bridge.claudeConnected).toBe(false);

    bridge.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "bridge/claudeConnectionChanged",
      params: { connected: true },
    }));
    expect(bridge.claudeConnected).toBe(true);
  });

  it("silently handles invalid JSON", () => {
    const bridge = createBridge();
    expect(() => bridge.handleMessage("not json")).not.toThrow();
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
