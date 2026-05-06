/** @vitest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBridgeStatus } from "../useBridgeStatus";

// useBridgeStatus polls on a backoff schedule. We don't need to advance
// timers — every test only asserts the FIRST tick's effect on state via
// waitFor. The cleanup returned by useEffect cancels the next setTimeout
// when renderHook unmounts.

type Json = Record<string, unknown>;

function jsonResponse(body: Json, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function plainResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
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

describe("useBridgeStatus — happy path", () => {
  it("sets { ok: true, ...data } on a healthy /status response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        port: 4242,
        workspace: "/work",
        extensionConnected: true,
        slim: false,
        uptimeMs: 1234,
      }),
    );

    const { result } = renderHook(() => useBridgeStatus());

    await waitFor(() => {
      expect(result.current.ok).toBe(true);
    });
    expect(result.current).toMatchObject({
      ok: true,
      port: 4242,
      workspace: "/work",
      extensionConnected: true,
      uptimeMs: 1234,
    });
  });

  it("accepts text/plain content-type as well as application/json", async () => {
    // The hook deliberately allows text/plain for older bridges that
    // serve JSON-encoded text. Pin that — narrowing it later would be
    // a deliberate, test-noticed change.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ port: 1 }), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const { result } = renderHook(() => useBridgeStatus());
    await waitFor(() => expect(result.current.ok).toBe(true));
    expect(result.current.port).toBe(1);
  });
});

describe("useBridgeStatus — degraded fallback", () => {
  it("/status 500 + /approvals ok+json → { ok: false, degraded: true }", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/bridge/status"))
        return Promise.resolve(plainResponse("nope", 500));
      if (url.includes("/api/bridge/approvals"))
        return Promise.resolve(jsonResponse({ pending: [] }));
      throw new Error(`unexpected url: ${url}`);
    });

    const { result } = renderHook(() => useBridgeStatus());

    await waitFor(() => {
      expect(result.current.degraded).toBe(true);
    });
    expect(result.current.ok).toBe(false);
  });

  it("/status throws + /approvals ok+json → { ok: false, degraded: true }", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/bridge/status"))
        return Promise.reject(new TypeError("network down"));
      if (url.includes("/api/bridge/approvals"))
        return Promise.resolve(jsonResponse({ pending: [] }));
      throw new Error(`unexpected url: ${url}`);
    });

    const { result } = renderHook(() => useBridgeStatus());

    await waitFor(() => {
      expect(result.current.degraded).toBe(true);
    });
    expect(result.current.ok).toBe(false);
  });

  it("/status returns 200 but wrong content-type → falls through to fallback", async () => {
    // Production bug class: a misconfigured proxy could return HTML
    // for /status. The hook treats that as a /status failure and
    // checks /approvals as a heartbeat instead.
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/bridge/status"))
        return Promise.resolve(plainResponse("<html>oops</html>"));
      if (url.includes("/api/bridge/approvals"))
        return Promise.resolve(jsonResponse({ pending: [] }));
      throw new Error(`unexpected url: ${url}`);
    });

    const { result } = renderHook(() => useBridgeStatus());

    await waitFor(() => {
      expect(result.current.degraded).toBe(true);
    });
    expect(result.current.ok).toBe(false);
  });
});

describe("useBridgeStatus — both endpoints down", () => {
  it("/status fails + /approvals fails → { ok: false, degraded: false }", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/bridge/status"))
        return Promise.resolve(plainResponse("nope", 500));
      if (url.includes("/api/bridge/approvals"))
        return Promise.reject(new TypeError("network down"));
      throw new Error(`unexpected url: ${url}`);
    });

    const { result } = renderHook(() => useBridgeStatus());

    await waitFor(() => {
      // initial state is also { ok: false }, so wait until degraded is
      // explicitly set to false (by the second-tier failure handler).
      expect(result.current.degraded).toBe(false);
    });
    expect(result.current.ok).toBe(false);
  });

  it("/status fails + /approvals returns plain text → { ok: false, degraded: false }", async () => {
    // Reachable but not the JSON-shaped response we expect — count as
    // not-degraded (heartbeat doesn't confirm reachability of bridge JSON).
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/bridge/status"))
        return Promise.resolve(plainResponse("nope", 500));
      if (url.includes("/api/bridge/approvals"))
        return Promise.resolve(plainResponse("<html>oops</html>"));
      throw new Error(`unexpected url: ${url}`);
    });

    const { result } = renderHook(() => useBridgeStatus());

    await waitFor(() => {
      expect(result.current.degraded).toBe(false);
    });
    expect(result.current.ok).toBe(false);
  });
});

describe("useBridgeStatus — initial state", () => {
  it("starts as { ok: false } before the first tick resolves", () => {
    // fetchMock returns a never-resolving promise so we observe the
    // pre-fetch render output.
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useBridgeStatus());
    expect(result.current).toEqual({ ok: false });
  });
});
