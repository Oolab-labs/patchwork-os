/** @vitest-environment node */
/**
 * Smoke tests for the explain-batch fan-out route.
 *
 * Pre-fix the route had two gaps:
 *   1. No CSRF check — every other dashboard mutation route uses
 *      `requireSameOrigin`, this one was missed.
 *   2. Unbounded `await req.json()` — same body-buffer class as the
 *      other routes fixed in PR #285.
 */

import type { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/bridge", () => ({
  bridgeFetch: vi.fn(async () =>
    new Response(JSON.stringify({ explanation: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ),
}));

const { POST } = await import("../route");

function makeReq(
  body: string,
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
  contentLength?: string,
): NextRequest {
  const finalHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...headers,
  };
  if (contentLength !== undefined) finalHeaders["content-length"] = contentLength;
  return new Request("https://dashboard.local/api/bridge/approval-insights/explain-batch", {
    method: "POST",
    headers: finalHeaders,
    body,
  }) as unknown as NextRequest;
}

describe("POST /api/bridge/approval-insights/explain-batch — CSRF guard", () => {
  it("rejects sec-fetch-site=cross-site with 403 (security audit, 2026-05-07)", async () => {
    const res = await POST(
      makeReq(JSON.stringify({ tools: ["foo"] }), {
        "sec-fetch-site": "cross-site",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("allows sec-fetch-site=same-origin", async () => {
    const res = await POST(makeReq(JSON.stringify({ tools: ["foo"] })));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/bridge/approval-insights/explain-batch — body cap", () => {
  it("rejects oversized Content-Length with 413", async () => {
    const res = await POST(
      makeReq(JSON.stringify({ tools: [] }), { "sec-fetch-site": "same-origin" }, "9999999"),
    );
    expect(res.status).toBe(413);
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await POST(makeReq("{not json"));
    expect(res.status).toBe(400);
  });

  it("returns empty explanations on empty tool list", async () => {
    const res = await POST(makeReq(JSON.stringify({ tools: [] })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { explanations: Record<string, unknown> };
    expect(body.explanations).toEqual({});
  });
});
