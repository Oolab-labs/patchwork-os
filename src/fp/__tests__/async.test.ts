import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { longPoll } from "../async.js";

describe("longPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves changed:false on timeout", async () => {
    const snapshot = 0;
    const promise = longPoll({
      timeoutMs: 1000,
      getSnapshot: () => snapshot,
      subscribe: (_onChange) => () => {},
      hasChanged: () => false,
    });

    vi.advanceTimersByTime(1000);
    const result = await promise;
    expect(result.changed).toBe(false);
    expect(result.value).toBe(0);
  });

  it("resolves changed:true when subscriber fires", async () => {
    let snapshot = 0;
    let triggerChange: (() => void) | undefined;

    const promise = longPoll({
      timeoutMs: 5000,
      getSnapshot: () => snapshot,
      subscribe: (onChange) => {
        triggerChange = onChange;
        return () => {};
      },
      hasChanged: () => false,
    });

    snapshot = 42;
    triggerChange!();
    const result = await promise;
    expect(result.changed).toBe(true);
    expect(result.value).toBe(42);
  });

  it("resolves changed:false on abort signal", async () => {
    const controller = new AbortController();
    const snapshot = 7;

    const promise = longPoll({
      timeoutMs: 5000,
      signal: controller.signal,
      getSnapshot: () => snapshot,
      subscribe: (_onChange) => () => {},
      hasChanged: () => false,
    });

    controller.abort();
    const result = await promise;
    expect(result.changed).toBe(false);
    expect(result.value).toBe(7);
  });

  it("resolves immediately on already-aborted signal (fast path)", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await longPoll({
      timeoutMs: 5000,
      signal: controller.signal,
      getSnapshot: () => 99,
      subscribe: (_onChange) => () => {},
      hasChanged: () => false,
    });

    expect(result.changed).toBe(false);
    expect(result.value).toBe(99);
  });

  it("resolves changed:true on TOCTOU (change before subscribe completes)", async () => {
    // hasChanged() returns true immediately → settle without waiting for event
    const promise = longPoll({
      timeoutMs: 5000,
      getSnapshot: () => 55,
      subscribe: (_onChange) => () => {},
      hasChanged: () => true,
    });

    const result = await promise;
    expect(result.changed).toBe(true);
    expect(result.value).toBe(55);
  });

  it("calls unsubscribe after timeout", async () => {
    const unsub = vi.fn();
    const promise = longPoll({
      timeoutMs: 500,
      getSnapshot: () => 0,
      subscribe: (_onChange) => unsub,
      hasChanged: () => false,
    });

    vi.advanceTimersByTime(500);
    await promise;
    expect(unsub).toHaveBeenCalledOnce();
  });

  it("calls unsubscribe after change fires", async () => {
    const unsub = vi.fn();
    let trigger: (() => void) | undefined;

    const promise = longPoll({
      timeoutMs: 5000,
      getSnapshot: () => 0,
      subscribe: (onChange) => {
        trigger = onChange;
        return unsub;
      },
      hasChanged: () => false,
    });

    trigger!();
    await promise;
    expect(unsub).toHaveBeenCalledOnce();
  });

  it("does not settle twice when both timeout and change race", async () => {
    let settleCount = 0;
    let trigger: (() => void) | undefined;

    const promise = longPoll({
      timeoutMs: 100,
      getSnapshot: () => {
        settleCount++;
        return settleCount;
      },
      subscribe: (onChange) => {
        trigger = onChange;
        return () => {};
      },
      hasChanged: () => false,
    });

    // Fire both at same tick
    vi.advanceTimersByTime(100);
    trigger!();

    await promise;
    // getSnapshot should only have been called once (on first settle)
    expect(settleCount).toBe(1);
  });
});
