/** @vitest-environment node */
/**
 * Cap-enforcement smoke test for the catch-all bridge proxy.
 *
 * The catch-all handles any /api/bridge/* path the named routes don't
 * capture. Pre-cap, an authenticated caller could stream a multi-GB
 * body to ANY bridge endpoint via this route. Test asserts oversized
 * Content-Length is rejected with 413 before the body is buffered.
 */

import type { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const mockFindBridge = vi.fn<() => unknown>(() => null);

vi.mock("@/lib/bridge", () => ({
  bridgeFetch: vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ),
  findBridge: () => mockFindBridge(),
  resolveBridgeUrl: () => "http://127.0.0.1:9999/stream",
}));

// Importing after mocks are registered.
const { GET, POST } = await import("../route");

function makeReq(body: string, contentLength?: string): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  };
  if (contentLength !== undefined) headers["content-length"] = contentLength;
  // The catch-all reads `req.nextUrl.search`; provide via Request URL.
  const url = "https://dashboard.local/api/bridge/some/path?x=1";
  const req = new Request(url, { method: "POST", headers, body });
  // The route only uses `req.method`, `req.headers`, `req.body`, and
  // `req.nextUrl.search`. Patch in a minimal nextUrl shim instead of
  // pulling the whole NextRequest implementation in.
  Object.defineProperty(req, "nextUrl", {
    value: { search: "?x=1" },
    configurable: true,
  });
  return req as unknown as NextRequest;
}

describe("catch-all bridge proxy — body cap", () => {
  const ctx = { params: Promise.resolve({ path: ["some", "path"] }) };

  it("rejects Content-Length above 1 MB with 413 (security audit, 2026-05-07)", async () => {
    const res = await POST(makeReq("x", String(2 * 1024 * 1024)), ctx);
    expect(res.status).toBe(413);
  });

  it("rejects oversized streamed body without Content-Length", async () => {
    // 2 MB body, 1 MB cap. Test the streaming-cap path.
    const huge = "a".repeat(2 * 1024 * 1024);
    const url = "https://dashboard.local/api/bridge/some/path";
    const req = new Request(url, {
      method: "POST",
      headers: { "content-type": "text/plain", "sec-fetch-site": "same-origin" },
      body: huge,
    });
    Object.defineProperty(req, "nextUrl", {
      value: { search: "" },
      configurable: true,
    });
    const res = await POST(req as unknown as NextRequest, ctx);
    expect(res.status).toBe(413);
  });

  it("accepts a normal-sized body", async () => {
    const res = await POST(
      makeReq(JSON.stringify({ ok: true }), "16"),
      ctx,
    );
    expect(res.status).toBe(200);
  });
});

describe("catch-all bridge proxy — SSE /stream non-OK passthrough", () => {
  function makeStreamReq(): NextRequest {
    const req = new Request("https://dashboard.local/api/bridge/stream", {
      method: "GET",
      headers: { "sec-fetch-site": "same-origin" },
    });
    Object.defineProperty(req, "nextUrl", {
      value: { search: "" },
      configurable: true,
    });
    return req as unknown as NextRequest;
  }
  const ctx = { params: Promise.resolve({ path: ["stream"] }) };

  it("passes a 503 (subscriber cap) straight through — no fake event-stream wrapper", async () => {
    mockFindBridge.mockReturnValueOnce({ authToken: "t", port: 9999 });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "Too many SSE subscribers (max 20)" }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      );
    try {
      const res = await GET(makeStreamReq(), ctx);
      // Status preserved.
      expect(res.status).toBe(503);
      // Must NOT be wrapped as an event-stream — the old code prepended
      // a `: connected` heartbeat which falsely signalled a connection.
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).not.toContain("text/event-stream");
      const body = await res.text();
      expect(body).not.toContain(": connected");
      expect(JSON.parse(body)).toMatchObject({
        error: "Too many SSE subscribers (max 20)",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("still streams a 200 upstream as text/event-stream with a heartbeat", async () => {
    mockFindBridge.mockReturnValueOnce({ authToken: "t", port: 9999 });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ start: (c) => c.close() }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    try {
      const res = await GET(makeStreamReq(), ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("catch-all bridge proxy — error body does not leak internals", () => {
  const ctx = { params: Promise.resolve({ path: ["some", "path"] }) };

  it("returns generic 502 body when bridgeFetch throws (CodeQL #120)", async () => {
    const lib = await import("@/lib/bridge");
    const internal =
      "ECONNREFUSED 127.0.0.1:9876 at /Users/secret/path/internal.ts:42";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(lib.bridgeFetch).mockImplementationOnce(async () => {
        throw new Error(internal);
      });
      const res = await POST(
        makeReq(JSON.stringify({ ok: true }), "16"),
        ctx,
      );
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).not.toContain("ECONNREFUSED");
      expect(text).not.toContain("/Users/");
      expect(text).not.toContain("internal.ts");
      // The generic message that should be returned instead.
      expect(JSON.parse(text)).toEqual({ error: "Bridge unreachable" });
      // Detail still goes to server logs for ops visibility.
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
