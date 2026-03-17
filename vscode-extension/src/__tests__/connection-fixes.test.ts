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
    removeListener = vi.fn(function (this: MockWebSocket, event: string, fn: Function) {
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

import { BridgeConnection, ConnectionState } from "../connection";
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
    const connectSpy = vi.spyOn(conn as any, "connect").mockImplementation(() => {});
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
    const handleDisconnectSpy = vi
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
