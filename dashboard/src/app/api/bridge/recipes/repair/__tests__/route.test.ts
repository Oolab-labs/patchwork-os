/** @vitest-environment node */
/**
 * Tests for the /api/bridge/recipes/repair proxy (Phase 2A.2).
 *
 * Covers: body cap (413), passthrough of bridge response shape
 * (feature_disabled 503, rate-limited 429, ok 200), and
 * Retry-After header passthrough.
 */
import { describe, expect, it, vi } from "vitest";

import { POST } from "../route";

let bridgeFetchMock = vi.fn(
  async () =>
    new Response(JSON.stringify({ ok: true, yaml: "name: fixed\n" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);

vi.mock("@/lib/bridge", () => ({
  bridgeFetch: (path: string, init: RequestInit) =>
    bridgeFetchMock(path as never, init as never),
}));

function makeReq(body: string, contentLength?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  };
  if (contentLength !== undefined) headers["content-length"] = contentLength;
  return new Request("https://dashboard.local/api/bridge/recipes/repair", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/bridge/recipes/repair", () => {
  it("forwards a small body and returns the bridge's 200 result", async () => {
    bridgeFetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, yaml: "name: fixed\n" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const body = JSON.stringify({
      currentYaml: "name: broken\n",
      lintIssues: [{ level: "error", message: "Missing trigger" }],
    });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.ok).toBe(true);
    expect(parsed.yaml).toBe("name: fixed\n");
  });

  it("passes through the bridge's 503 feature_disabled without rewriting", async () => {
    bridgeFetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            code: "feature_disabled",
            error: "off",
            unavailable: true,
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    );
    const res = await POST(
      makeReq(JSON.stringify({ currentYaml: "name: x\n", lintIssues: [] })),
    );
    expect(res.status).toBe(503);
    const parsed = await res.json();
    expect(parsed.code).toBe("feature_disabled");
  });

  it("passes through 429 with Retry-After header preserved", async () => {
    bridgeFetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: false, retryAfterSeconds: 30 }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "30",
            },
          },
        ),
    );
    const res = await POST(
      makeReq(JSON.stringify({ currentYaml: "name: x\n", lintIssues: [] })),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("rejects oversized request via Content-Length with 413", async () => {
    const res = await POST(makeReq("x", "9999999999"));
    expect(res.status).toBe(413);
  });

  it("returns 502 when bridge is unreachable", async () => {
    bridgeFetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await POST(
      makeReq(JSON.stringify({ currentYaml: "name: x\n", lintIssues: [] })),
    );
    expect(res.status).toBe(502);
    const parsed = await res.json();
    expect(parsed.error).toMatch(/unreachable/i);
  });
});
