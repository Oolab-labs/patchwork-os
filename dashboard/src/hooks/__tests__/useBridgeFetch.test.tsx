/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBridgeFetch } from "../useBridgeFetch";

// useBridgeFetch is a polling fetch hook with status-aware branches:
//   200 ok+JSON  → data + ok=false-loading + status set
//   404          → unsupported=true + data=unsupportedValue
//   503          → error="Bridge not running" (no exponential punish)
//   other !ok    → error="Request failed: <status>"
//   throw        → error=err.message
// Plus a `transform` hook for shaping the raw response, and an
// `enabled: false` short-circuit. Tests assert the FIRST tick's
// effect; renderHook's unmount cancels the scheduled poll.

type Json = Record<string, unknown>;

function jsonResponse(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useBridgeFetch — happy path", () => {
  it("populates data + clears loading on a 200 + JSON response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 7 }));

    const { result } = renderHook(() => useBridgeFetch<{ count: number }>("/api/x"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ count: 7 });
    expect(result.current.error).toBeUndefined();
    expect(result.current.status).toBe(200);
    expect(result.current.unsupported).toBe(false);
  });

  it("applies the transform fn to the raw response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [1, 2, 3] }));

    const { result } = renderHook(() =>
      useBridgeFetch<number>("/api/x", {
        transform: (raw) => (raw as { items: number[] }).items.length,
      }),
    );

    await waitFor(() => expect(result.current.data).toBe(3));
    expect(result.current.error).toBeUndefined();
  });
});

describe("useBridgeFetch — error branches", () => {
  it("404 sets unsupported=true and uses unsupportedValue as data", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("not here", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
    );

    const fallback = { items: [] };
    const { result } = renderHook(() =>
      useBridgeFetch<{ items: number[] }>("/api/x", {
        unsupportedValue: fallback,
      }),
    );

    await waitFor(() => expect(result.current.unsupported).toBe(true));
    expect(result.current.data).toEqual(fallback);
    expect(result.current.error).toBeUndefined();
    expect(result.current.status).toBe(404);
    expect(result.current.loading).toBe(false);
  });

  it("404 stops the polling loop — no further fetches fire", async () => {
    // Regression test for the session-detail / older-bridge case where a 404
    // would re-poll forever at intervalMs. 404 is a stable state — neither a
    // missing endpoint nor a missing resource will materialise from polling,
    // and the network noise was filling browser/server logs. Callers that
    // want to retry call refetch() explicitly.
    fetchMock.mockResolvedValueOnce(
      new Response("nope", { status: 404, headers: { "content-type": "text/plain" } }),
    );

    const { result } = renderHook(() =>
      useBridgeFetch("/api/missing", { intervalMs: 50 }),
    );

    await waitFor(() => expect(result.current.status).toBe(404));
    const callsAfterFirst = fetchMock.mock.calls.length;
    // Wait several intervals — if the hook was still polling we'd see
    // additional fetch() invocations stack up.
    await new Promise((r) => setTimeout(r, 250));
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it("503 sets a 'Bridge not running' error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("down", { status: 503 }),
    );

    const { result } = renderHook(() => useBridgeFetch("/api/x"));

    await waitFor(() => expect(result.current.error).toBe("Bridge not running"));
    expect(result.current.data).toBeNull();
    expect(result.current.status).toBe(503);
    expect(result.current.loading).toBe(false);
  });

  it("non-ok non-503/404 status sets a generic 'Request failed: <code>' error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("oops", { status: 500 }),
    );

    const { result } = renderHook(() => useBridgeFetch("/api/x"));

    await waitFor(() => expect(result.current.error).toBe("Request failed: 500"));
    expect(result.current.status).toBe(500);
  });

  it("rejection (network throw) surfaces the error message", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));

    const { result } = renderHook(() => useBridgeFetch("/api/x"));

    await waitFor(() => expect(result.current.error).toBe("network down"));
    // status was never set (the catch path doesn't observe a response)
    expect(result.current.status).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("rejection with a non-Error value still surfaces a string", async () => {
    fetchMock.mockRejectedValueOnce("plain-string");

    const { result } = renderHook(() => useBridgeFetch("/api/x"));

    await waitFor(() => expect(result.current.error).toBe("plain-string"));
  });
});

describe("useBridgeFetch — enabled flag", () => {
  it("does not call fetch when enabled is false", async () => {
    const { result } = renderHook(() =>
      useBridgeFetch("/api/x", { enabled: false }),
    );

    // Give the hook a chance to mount and run any effects.
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchMock).not.toHaveBeenCalled();
    // Initial state is preserved — loading defaults to true.
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });
});

describe("useBridgeFetch — path change resets loading (dashboard-ui-3)", () => {
  it("resets loading=true and clears stale data when path changes mid-flight", async () => {
    // First path resolves quickly so data/loading settle.
    fetchMock.mockResolvedValueOnce(jsonResponse({ which: "A" }));

    const { result, rerender } = renderHook(
      ({ p }: { p: string }) => useBridgeFetch<{ which: string }>(p),
      { initialProps: { p: "/api/run-A" } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ which: "A" });

    // Second path never resolves — the hook must NOT keep showing path A's data
    // with loading=false; it must flip back to the loading state immediately.
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    rerender({ p: "/api/run-B" });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });
});

describe("useBridgeFetch — initial state", () => {
  it("starts as { data: null, loading: true, status: null, unsupported: false, refetch: fn }", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useBridgeFetch("/api/x"));
    expect(result.current).toEqual({
      data: null,
      error: undefined,
      loading: true,
      status: null,
      unsupported: false,
      refetch: expect.any(Function),
      stale: false,
    });
  });
});

describe("useBridgeFetch — cache: no-store (M6)", () => {
  it("passes cache: no-store on every fetch call so stale 404s are not served after bridge restart", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const { result } = renderHook(() => useBridgeFetch("/api/x"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalled();
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(opts?.cache).toBe("no-store");
  });
});

describe("useBridgeFetch — staleness (dashboard-gap-remediation #1)", () => {
  // Regression coverage for: the hook kept last-good `data` forever when
  // polling failed, with no signal to the consumer that the data on
  // screen might be frozen. `stale` flips true once
  // Date.now() - lastSuccessAt exceeds 3 * intervalMs, and must
  // re-evaluate over time even if the poll loop itself has stalled
  // (i.e. no new fetch happening) — so it can't only be computed
  // inside tick().

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flips stale=true after 3x intervalMs of no successful fetch, then clears on recovery", async () => {
    const intervalMs = 1000;

    // First call succeeds; every call after that hangs forever (never
    // resolves) — simulates the bridge going unresponsive mid-poll.
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 1 }));
    fetchMock.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() =>
      useBridgeFetch<{ count: number }>("/api/x", {
        intervalMs,
        trackStaleness: true,
      }),
    );

    // Let the first successful tick land.
    await vi.waitFor(() => expect(result.current.data).toEqual({ count: 1 }));
    expect(result.current.stale).toBe(false);

    // Advance past 3x the interval — the poll loop scheduled a next tick
    // at `intervalMs` which is now hung, so only a staleness re-check
    // ticker (not a new fetch) can flip `stale` here.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * intervalMs + 1500);
    });

    expect(result.current.stale).toBe(true);
    // Last-good data must still be shown — staleness is a signal, not a
    // data-clearing operation.
    expect(result.current.data).toEqual({ count: 1 });

    // Recovery: a subsequent successful fetch clears `stale` back to false.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ count: 2 }));
    result.current.refetch();

    await vi.waitFor(() => expect(result.current.data).toEqual({ count: 2 }));
    expect(result.current.stale).toBe(false);
  });

  it("does not expose staleness tracking unless trackStaleness is set (opt-in)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 1 }));
    const { result } = renderHook(() =>
      useBridgeFetch<{ count: number }>("/api/x", { intervalMs: 1000 }),
    );
    await vi.waitFor(() => expect(result.current.data).toEqual({ count: 1 }));
    expect(result.current.stale).toBe(false);
  });
});
