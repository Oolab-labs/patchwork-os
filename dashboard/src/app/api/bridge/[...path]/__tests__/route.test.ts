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

vi.mock("@/lib/bridge", () => ({
  bridgeFetch: vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ),
  findBridge: () => null,
  resolveBridgeUrl: () => "",
}));

// Importing after mocks are registered.
const { POST } = await import("../route");

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
