/** @vitest-environment node */
/**
 * Regression tests for issue #600 — proxy routes must not leak internal
 * error details (err.message, upstream bridge body) to clients.
 *
 * Covers one representative route per category:
 *   - proxy GET     → /api/connections (forwards bridge GET /connections)
 *   - proxy POST    → /api/bridge/telemetry-prefs (forwards bridge POST)
 *   - OAuth callback → /api/connections/discord/callback
 *
 * Each test asserts the response body contains only the generic message
 * ("Bridge unreachable" or "Bridge returned <status>") and that
 * sensitive markers (err.message text, upstream body text) do NOT appear.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeFetchMock = vi.fn();
vi.mock("@/lib/bridge", () => ({
  bridgeFetch: (...args: unknown[]) => bridgeFetchMock(...args),
}));
vi.mock("@/lib/csrf", () => ({
  requireSameOrigin: () => null,
}));

const { GET: connectionsGet } = await import("../route");
const { POST: telemetryPost } = await import("../../bridge/telemetry-prefs/route");
const { GET: discordCallback } = await import("../discord/callback/route");

const SENSITIVE_ERR = "ECONNREFUSED 127.0.0.1:54321 secret-detail";
const SENSITIVE_UPSTREAM = "upstream-bridge-stacktrace-leak";

beforeEach(() => {
  bridgeFetchMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("issue #600 — proxy GET hides internal errors", () => {
  it("network failure returns generic 'Bridge unreachable' without err.message", async () => {
    bridgeFetchMock.mockRejectedValueOnce(new Error(SENSITIVE_ERR));
    const res = await connectionsGet();
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(SENSITIVE_ERR);
    expect(JSON.parse(body)).toEqual({ error: "Bridge unreachable" });
  });

  it("non-2xx upstream returns generic message without upstream body", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(SENSITIVE_UPSTREAM, { status: 500 }),
    );
    const res = await connectionsGet();
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain(SENSITIVE_UPSTREAM);
    expect(JSON.parse(body)).toEqual({ error: "Bridge returned 500" });
  });
});

describe("issue #600 — proxy POST hides internal errors", () => {
  function postReq(): Request {
    return new Request("https://dashboard.local/api/bridge/telemetry-prefs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ analyticsOptIn: true }),
    });
  }

  it("network failure returns generic 'Bridge unreachable' without err.message", async () => {
    bridgeFetchMock.mockRejectedValueOnce(new Error(SENSITIVE_ERR));
    const res = await telemetryPost(postReq());
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(SENSITIVE_ERR);
    expect(JSON.parse(body)).toEqual({ error: "Bridge unreachable" });
  });

  it("non-2xx upstream returns generic message without upstream body", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(SENSITIVE_UPSTREAM, { status: 502 }),
    );
    const res = await telemetryPost(postReq());
    const body = await res.text();
    expect(body).not.toContain(SENSITIVE_UPSTREAM);
    expect(JSON.parse(body)).toEqual({ error: "Bridge returned 502" });
  });

  it("rejects oversized request body with 413 before reaching the bridge", async () => {
    const big = "x".repeat(8192);
    const req = new Request("https://dashboard.local/api/bridge/telemetry-prefs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(big.length),
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ blob: big }),
    });
    const res = await telemetryPost(req);
    expect(res.status).toBe(413);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });
});

describe("issue #600 — OAuth callback hides internal errors", () => {
  it("network failure returns generic 'Bridge unreachable' without err.message", async () => {
    bridgeFetchMock.mockRejectedValueOnce(new Error(SENSITIVE_ERR));
    const res = await discordCallback(
      new Request("https://dashboard.local/cb?code=abc&state=s"),
    );
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(SENSITIVE_ERR);
    expect(JSON.parse(body)).toEqual({ error: "Bridge unreachable" });
  });
});
