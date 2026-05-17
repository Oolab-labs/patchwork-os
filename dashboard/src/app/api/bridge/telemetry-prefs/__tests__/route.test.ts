/** @vitest-environment node */
/**
 * CSRF regression tests for telemetry-prefs.
 *
 * Pre-fix POST had no `requireSameOrigin` guard — any cross-origin page
 * could flip a user's telemetry opt-in/out via cookie auth. Audit
 * 2026-05-17.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/bridge", () => ({
  bridgeFetch: vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ),
}));

const { POST } = await import("../route");

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request("https://dashboard.local/api/bridge/telemetry-prefs", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ analyticsOptIn: true }),
  });
}

describe("POST /api/bridge/telemetry-prefs — CSRF guard", () => {
  it("rejects sec-fetch-site=cross-site with 403", async () => {
    const res = await POST(makeReq({ "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
  });

  it("rejects sec-fetch-site=cross-origin with 403", async () => {
    const res = await POST(makeReq({ "sec-fetch-site": "cross-origin" }));
    expect(res.status).toBe(403);
  });

  it("allows sec-fetch-site=same-origin", async () => {
    const res = await POST(makeReq({ "sec-fetch-site": "same-origin" }));
    expect(res.status).toBe(200);
  });

  it("allows sec-fetch-site=none (direct address-bar nav)", async () => {
    const res = await POST(makeReq({ "sec-fetch-site": "none" }));
    expect(res.status).toBe(200);
  });
});
