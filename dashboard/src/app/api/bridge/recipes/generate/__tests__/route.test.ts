/** @vitest-environment node */
/**
 * Tests for the /api/bridge/recipes/generate proxy.
 *
 * Security review (2026-05-07) found the proxy buffered the entire
 * request body via `await req.text()` with no upstream cap before
 * forwarding to the bridge (which has a 4 KB cap). An authenticated
 * caller could allocate dashboard heap by streaming a multi-GB body.
 * This test asserts the proxy rejects oversized payloads with 413
 * before buffering.
 */
import { describe, expect, it, vi } from "vitest";

import { POST } from "../route";

vi.mock("@/lib/bridge", () => ({
  bridgeFetch: vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ),
}));

function makeReq(body: string, contentLength?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  };
  if (contentLength !== undefined) headers["content-length"] = contentLength;
  return new Request(
    "https://dashboard.local/api/bridge/recipes/generate",
    { method: "POST", headers, body },
  );
}

describe("POST /api/bridge/recipes/generate — body size cap", () => {
  it("rejects oversized request via Content-Length with 413 (security audit, 2026-05-07)", async () => {
    // Bridge caps body at 4 KB. Dashboard should reject before
    // buffering anything close to that.
    const res = await POST(makeReq("x", "9999999"));
    expect(res.status).toBe(413);
  });

  it("rejects oversized body even when Content-Length is missing", async () => {
    // Streamed/chunked uploads have no Content-Length. The proxy must
    // also abort once the buffered total exceeds the cap.
    const huge = "a".repeat(16 * 1024); // 16 KB > 8 KB cap
    const res = await POST(makeReq(huge));
    expect(res.status).toBe(413);
  });

  it("forwards a normal-sized request body", async () => {
    const body = JSON.stringify({ prompt: "build me a recipe" });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(200);
  });
});
