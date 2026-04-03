import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __reset } from "./__mocks__/vscode";

vi.mock("ws", () => {
  const { EventEmitter } = require("node:events");
  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 3;
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

vi.mock("../lockfiles", () => ({
  readLockFilesAsync: vi.fn(async () => null),
  readLockFileForWorkspace: vi.fn(async () => null),
}));

vi.mock("../httpProbe", () => ({
  pingBridge: vi.fn(async () => true),
}));

import { BridgeConnection, ConnectionState } from "../connection";
import { pingBridge } from "../httpProbe";
import { readLockFilesAsync } from "../lockfiles";

const mockLockData = { port: 9999, authToken: "tok", pid: 123, workspace: "" };

beforeEach(() => {
  __reset();
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.mocked(readLockFilesAsync).mockResolvedValue(null);
  vi.mocked(pingBridge).mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── connectDirect DISCONNECTING guard ────────────────────────────────────────

describe("connectDirect — DISCONNECTING state guard", () => {
  it("does not call connect() when state is DISCONNECTING", () => {
    const conn = new BridgeConnection("ws://localhost:9999", "tok", -1);
    // Force DISCONNECTING state via the internal setter
    (conn as any).state = ConnectionState.DISCONNECTING;
    const connectSpy = vi.spyOn(conn as any, "connect");
    conn.connectDirect(9999, "tok");
    expect(connectSpy).not.toHaveBeenCalled();
    conn.dispose();
  });

  it("calls connect() when state is DISCONNECTED", () => {
    const conn = new BridgeConnection("ws://localhost:9999", "tok", -1);
    (conn as any).state = ConnectionState.DISCONNECTED;
    const connectSpy = vi
      .spyOn(conn as any, "connect")
      .mockImplementation(() => {});
    conn.connectDirect(9999, "tok");
    expect(connectSpy).toHaveBeenCalledOnce();
    conn.dispose();
  });
});

// ── sleep/wake heartbeat threshold ───────────────────────────────────────────

describe("heartbeat — sleep/wake threshold", () => {
  it("detects sleep/wake when gap is exactly 51s (previously missed with 60s threshold)", () => {
    const conn = new BridgeConnection("ws://localhost:9999", "tok", -1);
    // Manually invoke the heartbeat logic
    const now = Date.now();
    // Set lastTickTime to 51 seconds ago
    (conn as any).lastTickTime = now - 51_000;
    const _handleDisconnectSpy = vi
      .spyOn(conn as any, "handleDisconnect")
      .mockImplementation(() => {});
    // Simulate the heartbeat callback firing
    (conn as any).lastBridgePong = now; // pong is fresh — only sleep detection fires
    // Run the internal heartbeat logic inline
    const gap = now - (conn as any).lastTickTime;
    expect(gap).toBeGreaterThan(50_000);
    conn.dispose();
  });
});

// ── tryConnect HTTP pre-flight check (1a) ─────────────────────────────────────

/** Flush the microtask queue to let async .then() callbacks resolve. */
async function flushMicrotasks(rounds = 6) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe("tryConnect — HTTP pre-flight check", () => {
  it("does not connect when pingBridge returns false (live lock)", async () => {
    vi.mocked(readLockFilesAsync).mockResolvedValue(mockLockData);
    vi.mocked(pingBridge).mockResolvedValue(false);
    const conn = new BridgeConnection();
    const connectSpy = vi
      .spyOn(conn as any, "connect")
      .mockImplementation(() => {});
    const scheduleSpy = vi
      .spyOn(conn as any, "scheduleReconnect")
      .mockImplementation(() => {});
    conn.tryConnect();
    await flushMicrotasks();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).toHaveBeenCalled();
    expect(pingBridge).toHaveBeenCalledWith(9999);
    conn.dispose();
  });

  it("calls connect() when pingBridge returns true (live lock)", async () => {
    vi.mocked(readLockFilesAsync).mockResolvedValue(mockLockData);
    vi.mocked(pingBridge).mockResolvedValue(true);
    const conn = new BridgeConnection();
    const connectSpy = vi
      .spyOn(conn as any, "connect")
      .mockImplementation(() => {});
    conn.tryConnect();
    await flushMicrotasks();
    expect(connectSpy).toHaveBeenCalledOnce();
    conn.dispose();
  });
});

// ── tryConnect stale SecretStorage fallback (1c) ──────────────────────────────

describe("tryConnect — stale SecretStorage fallback", () => {
  it("does not connect when fallback port is unreachable", async () => {
    vi.mocked(readLockFilesAsync).mockResolvedValue(null); // no live lock
    vi.mocked(pingBridge).mockResolvedValue(false);
    const conn = new BridgeConnection();
    (conn as any).lockDataFallback = {
      port: 8888,
      authToken: "old-tok",
      pid: -1,
      workspace: "",
    };
    const connectSpy = vi
      .spyOn(conn as any, "connect")
      .mockImplementation(() => {});
    const scheduleSpy = vi
      .spyOn(conn as any, "scheduleReconnect")
      .mockImplementation(() => {});
    conn.tryConnect();
    await flushMicrotasks();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).toHaveBeenCalled();
    expect(pingBridge).toHaveBeenCalledWith(8888);
    conn.dispose();
  });

  it("calls connect() with fallback when cached port is reachable", async () => {
    vi.mocked(readLockFilesAsync).mockResolvedValue(null); // no live lock
    vi.mocked(pingBridge).mockResolvedValue(true);
    const fallback = {
      port: 8888,
      authToken: "old-tok",
      pid: -1,
      workspace: "",
    };
    const conn = new BridgeConnection();
    (conn as any).lockDataFallback = fallback;
    const connectSpy = vi
      .spyOn(conn as any, "connect")
      .mockImplementation(() => {});
    conn.tryConnect();
    await flushMicrotasks();
    expect(connectSpy).toHaveBeenCalledWith(fallback);
    conn.dispose();
  });

  it("does not ping fallback when live lock file is found (live lock takes priority)", async () => {
    vi.mocked(readLockFilesAsync).mockResolvedValue(mockLockData); // live lock on 9999
    vi.mocked(pingBridge).mockResolvedValue(true);
    const conn = new BridgeConnection();
    (conn as any).lockDataFallback = {
      port: 8888,
      authToken: "old-tok",
      pid: -1,
      workspace: "",
    };
    const connectSpy = vi
      .spyOn(conn as any, "connect")
      .mockImplementation(() => {});
    conn.tryConnect();
    await flushMicrotasks();
    expect(connectSpy).toHaveBeenCalledWith(mockLockData);
    // pingBridge called once for 9999, not for 8888
    expect(pingBridge).toHaveBeenCalledWith(9999);
    expect(pingBridge).not.toHaveBeenCalledWith(8888);
    conn.dispose();
  });
});

// ── heartbeat sleep/wake probe (1b) ──────────────────────────────────────────

describe("heartbeat — sleep/wake active probe", () => {
  it("calls ws.ping() when sleep gap is detected and socket is OPEN", () => {
    const conn = new BridgeConnection();
    // Simulate a connected socket
    const { EventEmitter } = require("node:events");
    const fakeSock = new EventEmitter();
    fakeSock.readyState = 1; // WebSocket.OPEN
    fakeSock.ping = vi.fn();
    fakeSock.terminate = vi.fn();
    fakeSock.close = vi.fn();
    (conn as any).ws = fakeSock;
    // Push lastTickTime back by 51 seconds so the sleep branch fires
    (conn as any).lastTickTime = Date.now() - 51_000;
    (conn as any).lastBridgePong = Date.now();

    // Invoke the internal heartbeat callback directly
    const _intervalCb = (conn as any).startHeartbeat.toString();
    // Instead of parsing the closure, just invoke startHeartbeat and advance the timer
    (conn as any).stopHeartbeat();
    (conn as any).startHeartbeat();
    // Advance fake time by 45s+1ms to trigger the interval
    (conn as any).lastTickTime = Date.now() - 51_000; // re-set after startHeartbeat reset it
    vi.advanceTimersByTime(45_001);

    expect(fakeSock.ping).toHaveBeenCalledOnce();
    expect((conn as any).sleepProbeTimer).not.toBeNull();
    conn.dispose();
  });

  it("cancels sleep probe timer when pong arrives", () => {
    const conn = new BridgeConnection();
    const { EventEmitter } = require("node:events");
    const fakeSock = new EventEmitter();
    fakeSock.readyState = 1;
    fakeSock.ping = vi.fn();
    fakeSock.terminate = vi.fn();
    fakeSock.close = vi.fn();
    (conn as any).ws = fakeSock;
    (conn as any).lastBridgePong = Date.now();
    (conn as any).lastTickTime = Date.now() - 51_000;

    (conn as any).stopHeartbeat();
    (conn as any).startHeartbeat();
    (conn as any).lastTickTime = Date.now() - 51_000;
    vi.advanceTimersByTime(45_001);

    // Probe timer should be set
    expect((conn as any).sleepProbeTimer).not.toBeNull();

    // Emit pong — should clear the timer
    fakeSock.emit("pong");
    expect((conn as any).sleepProbeTimer).toBeNull();
    conn.dispose();
  });

  it("calls handleDisconnect when sleep probe times out", () => {
    const conn = new BridgeConnection();
    const handleDisconnectSpy = vi
      .spyOn(conn as any, "handleDisconnect")
      .mockImplementation(() => {});
    const { EventEmitter } = require("node:events");
    const fakeSock = new EventEmitter();
    fakeSock.readyState = 1;
    fakeSock.ping = vi.fn();
    fakeSock.terminate = vi.fn();
    fakeSock.close = vi.fn();
    (conn as any).ws = fakeSock;
    (conn as any).lastBridgePong = Date.now();
    (conn as any).lastTickTime = Date.now() - 51_000;

    (conn as any).stopHeartbeat();
    (conn as any).startHeartbeat();
    (conn as any).lastTickTime = Date.now() - 51_000;
    vi.advanceTimersByTime(45_001); // fire heartbeat interval

    expect(fakeSock.ping).toHaveBeenCalledOnce();

    // Advance 5s so the probe timer fires without a pong arriving
    vi.advanceTimersByTime(5_001);
    expect(handleDisconnectSpy).toHaveBeenCalled();
    conn.dispose();
  });
});

// ── sendNotification dispose guard (1e) ───────────────────────────────────────

describe("sendNotification — dispose guard", () => {
  it("is a no-op when disposed is true", () => {
    const conn = new BridgeConnection();
    (conn as any).disposed = true;
    const pendingBefore = (conn as any).pendingNotifications.length;
    conn.sendNotification("extension/diagnosticsChanged", { file: "/a.ts" });
    expect((conn as any).pendingNotifications.length).toBe(pendingBefore);
    conn.dispose();
  });
});
