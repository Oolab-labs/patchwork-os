import { describe, expect, it, vi, beforeEach } from "vitest";
import { WebSocket } from "ws";
import { waitForDrain, safeSend, BACKPRESSURE_THRESHOLD } from "../wsUtils.js";

function makeWs(readyState = WebSocket.OPEN, bufferedAmount = 0) {
  return {
    readyState,
    bufferedAmount,
    send: vi.fn(),
    _socket: null as any,
  } as unknown as WebSocket;
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

describe("waitForDrain", () => {
  it("resolves immediately when buffered amount is below threshold", async () => {
    const ws = makeWs(WebSocket.OPEN, 0);
    await expect(waitForDrain(ws, logger)).resolves.toBeUndefined();
  });

  it("resolves immediately at exactly threshold - 1", async () => {
    const ws = makeWs(WebSocket.OPEN, BACKPRESSURE_THRESHOLD - 1);
    await expect(waitForDrain(ws, logger)).resolves.toBeUndefined();
  });

  it("resolves immediately when _socket is null even above threshold", async () => {
    const ws = makeWs(WebSocket.OPEN, BACKPRESSURE_THRESHOLD + 1);
    (ws as any)._socket = null;
    await expect(waitForDrain(ws, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("resolves when socket emits drain", async () => {
    vi.useFakeTimers();
    const ws = makeWs(WebSocket.OPEN, BACKPRESSURE_THRESHOLD + 1);
    const mockSocket = { once: vi.fn(), removeListener: vi.fn(), getMaxListeners: vi.fn(() => 10), setMaxListeners: vi.fn() };
    (ws as any)._socket = mockSocket;

    const drainPromise = waitForDrain(ws, logger);
    // Simulate drain event
    const drainCall = mockSocket.once.mock.calls.find(([ev]) => ev === "drain");
    drainCall?.[1]();

    await expect(drainPromise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("resolves when socket emits close", async () => {
    vi.useFakeTimers();
    const ws = makeWs(WebSocket.OPEN, BACKPRESSURE_THRESHOLD + 1);
    const mockSocket = { once: vi.fn(), removeListener: vi.fn(), getMaxListeners: vi.fn(() => 10), setMaxListeners: vi.fn() };
    (ws as any)._socket = mockSocket;

    const drainPromise = waitForDrain(ws, logger);
    const closeCall = mockSocket.once.mock.calls.find(([ev]) => ev === "close");
    closeCall?.[1]();

    await expect(drainPromise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("resolves after timeout when no drain/close fires", async () => {
    vi.useFakeTimers();
    const ws = makeWs(WebSocket.OPEN, BACKPRESSURE_THRESHOLD + 1);
    const mockSocket = { once: vi.fn(), removeListener: vi.fn(), getMaxListeners: vi.fn(() => 10), setMaxListeners: vi.fn() };
    (ws as any)._socket = mockSocket;

    const drainPromise = waitForDrain(ws, logger);
    vi.advanceTimersByTime(5001);
    await expect(drainPromise).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2); // once on entry, once on timeout
    vi.useRealTimers();
  });
});

describe("safeSend", () => {
  it("returns false when WebSocket is not OPEN", async () => {
    const ws = makeWs(WebSocket.CLOSED);
    expect(await safeSend(ws, "msg", logger)).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("sends and returns true when socket is OPEN and buffer is low", async () => {
    const ws = makeWs(WebSocket.OPEN, 0);
    expect(await safeSend(ws, "hello", logger)).toBe(true);
    expect(ws.send).toHaveBeenCalledWith("hello");
  });

  it("returns false and logs error when send throws", async () => {
    const ws = makeWs(WebSocket.OPEN, 0);
    (ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("boom"); });
    expect(await safeSend(ws, "hello", logger)).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it("returns false when socket closes during drain wait", async () => {
    vi.useFakeTimers();
    const ws = makeWs(WebSocket.OPEN, BACKPRESSURE_THRESHOLD + 1);
    const mockSocket = { once: vi.fn(), removeListener: vi.fn(), getMaxListeners: vi.fn(() => 10), setMaxListeners: vi.fn() };
    (ws as any)._socket = mockSocket;

    const sendPromise = safeSend(ws, "msg", logger);
    // Simulate socket close and ws becoming non-OPEN
    (ws as any).readyState = WebSocket.CLOSED;
    const closeCall = mockSocket.once.mock.calls.find(([ev]) => ev === "close");
    closeCall?.[1]();

    expect(await sendPromise).toBe(false);
    vi.useRealTimers();
  });
});
