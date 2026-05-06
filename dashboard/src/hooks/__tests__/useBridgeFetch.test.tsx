/** @vitest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react";
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

describe("useBridgeFetch — initial state", () => {
  it("starts as { data: null, loading: true, status: null, unsupported: false }", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useBridgeFetch("/api/x"));
    expect(result.current).toEqual({
      data: null,
      error: undefined,
      loading: true,
      status: null,
      unsupported: false,
    });
  });
});
