/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock isDemoMode so we control whether the hook short-circuits.
let demoModeFlag = false;
vi.mock("@/lib/demoMode", () => ({
  isDemoMode: () => demoModeFlag,
}));

import { useBridgeStream } from "../useBridgeStream";

// Minimal EventSource shim — exposes the same surface jsdom doesn't
// implement and lets tests fire onopen/onerror/onmessage manually.
type Handler = ((ev: unknown) => void) | null;
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  onopen: Handler = null;
  onerror: Handler = null;
  onmessage: Handler = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

let originalEventSource: typeof EventSource | undefined;

beforeEach(() => {
  demoModeFlag = false;
  FakeEventSource.instances = [];
  originalEventSource = (globalThis as { EventSource?: typeof EventSource }).EventSource;
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalEventSource) {
    (globalThis as { EventSource?: typeof EventSource }).EventSource = originalEventSource;
  }
  vi.useRealTimers();
});

function latest(): FakeEventSource {
  const es = FakeEventSource.instances.at(-1);
  if (!es) throw new Error("no EventSource constructed");
  return es;
}

describe("useBridgeStream — connect lifecycle", () => {
  it("constructs an EventSource at apiPath(path) on mount", () => {
    renderHook(() =>
      useBridgeStream("/api/bridge/stream", () => {}),
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    // apiPath is a passthrough in dev; just assert the trailing path made it in.
    expect(latest().url).toContain("/api/bridge/stream");
  });

  it("sets connected=true with no error after onopen", async () => {
    const { result } = renderHook(() =>
      useBridgeStream("/api/bridge/stream", () => {}),
    );

    act(() => {
      latest().onopen?.(new Event("open"));
    });

    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current.error).toBeUndefined();
  });

  it("clears error on subsequent onopen (after a reconnect)", async () => {
    const { result } = renderHook(() =>
      useBridgeStream("/api/bridge/stream", () => {}),
    );
    act(() => {
      latest().onerror?.(new Event("error"));
    });
    await waitFor(() => expect(result.current.error).toBeDefined());

    // The error handler closes the current ES and schedules a reconnect via
    // setTimeout. We cheat by constructing the next ES synchronously and
    // firing onopen on it — that exercises the open-after-error path.
    vi.useFakeTimers();
    vi.advanceTimersByTime(3000);
    vi.useRealTimers();

    act(() => {
      latest().onopen?.(new Event("open"));
    });

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
      expect(result.current.error).toBeUndefined();
    });
  });
});

describe("useBridgeStream — error + reconnect", () => {
  it("onerror sets connected=false, error string, and closes the ES", async () => {
    const { result } = renderHook(() =>
      useBridgeStream("/api/bridge/stream", () => {}),
    );
    const first = latest();

    act(() => {
      first.onerror?.(new Event("error"));
    });

    await waitFor(() => {
      expect(result.current.connected).toBe(false);
      expect(result.current.error).toBe("Disconnected — reconnecting…");
    });
    expect(first.closed).toBe(true);
  });

  it("schedules a reconnect 3s after onerror", async () => {
    vi.useFakeTimers();
    renderHook(() =>
      useBridgeStream("/api/bridge/stream", () => {}),
    );
    const first = latest();

    act(() => {
      first.onerror?.(new Event("error"));
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest()).not.toBe(first);
  });

  it("cleanup cancels the pending reconnect timer", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() =>
      useBridgeStream("/api/bridge/stream", () => {}),
    );
    const first = latest();

    act(() => {
      first.onerror?.(new Event("error"));
    });
    unmount();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // No reconnect after unmount — only the original ES exists.
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe("useBridgeStream — onmessage dispatch", () => {
  it("parses JSON and invokes onEvent with (type, data)", () => {
    const onEvent = vi.fn();
    renderHook(() =>
      useBridgeStream("/api/bridge/stream", onEvent),
    );

    act(() => {
      latest().onmessage?.({
        type: "approval_decision",
        data: JSON.stringify({ toolName: "Bash", decision: "approve" }),
      });
    });

    expect(onEvent).toHaveBeenCalledExactlyOnceWith("approval_decision", {
      toolName: "Bash",
      decision: "approve",
    });
  });

  it("falls back to type 'message' when msg.type is empty", () => {
    const onEvent = vi.fn();
    renderHook(() =>
      useBridgeStream("/api/bridge/stream", onEvent),
    );

    act(() => {
      latest().onmessage?.({
        type: "",
        data: JSON.stringify({ x: 1 }),
      });
    });

    expect(onEvent).toHaveBeenCalledWith("message", { x: 1 });
  });

  it("silently drops unparseable JSON without throwing", () => {
    const onEvent = vi.fn();
    renderHook(() =>
      useBridgeStream("/api/bridge/stream", onEvent),
    );

    expect(() => {
      act(() => {
        latest().onmessage?.({ type: "x", data: "{not json" });
      });
    }).not.toThrow();

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("uses the latest onEvent ref (no stale closure on rerender)", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb }: { cb: (t: string, d: unknown) => void }) =>
        useBridgeStream("/api/bridge/stream", cb),
      { initialProps: { cb: first as (t: string, d: unknown) => void } },
    );

    rerender({ cb: second as (t: string, d: unknown) => void });

    act(() => {
      latest().onmessage?.({
        type: "x",
        data: JSON.stringify({ ok: 1 }),
      });
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("x", { ok: 1 });
  });
});

describe("useBridgeStream — short-circuit guards", () => {
  it("does not construct an EventSource when enabled=false", () => {
    renderHook(() =>
      useBridgeStream("/api/bridge/stream", () => {}, { enabled: false }),
    );
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("does not construct an EventSource when isDemoMode()=true", () => {
    demoModeFlag = true;
    renderHook(() =>
      useBridgeStream("/api/bridge/stream", () => {}),
    );
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("swallows EventSource constructor throws (no crash, no connection)", () => {
    class ThrowingEventSource {
      constructor() {
        throw new Error("blocked by CSP");
      }
    }
    vi.stubGlobal("EventSource", ThrowingEventSource);

    expect(() => {
      renderHook(() =>
        useBridgeStream("/api/bridge/stream", () => {}),
      );
    }).not.toThrow();
  });
});

describe("useBridgeStream — initial + cleanup", () => {
  it("starts as { connected: false, error: undefined }", () => {
    const { result } = renderHook(() =>
      useBridgeStream("/api/bridge/stream", () => {}),
    );
    expect(result.current).toEqual({ connected: false, error: undefined });
  });

  it("closes the EventSource on unmount", () => {
    const { unmount } = renderHook(() =>
      useBridgeStream("/api/bridge/stream", () => {}),
    );
    const es = latest();
    unmount();
    expect(es.closed).toBe(true);
  });
});
