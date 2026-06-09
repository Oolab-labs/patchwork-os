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
const { GET: connectorAuthGet } = await import("../[connector]/auth/route");
const { POST: connectorConnectPost } = await import("../[connector]/connect/route");
const { POST: connectorTestPost } = await import("../[connector]/test/route");
const { DELETE: connectorDelete } = await import("../[connector]/route");
const { GET: inboxGet } = await import("../../inbox/route");
const { GET: inboxItemGet } = await import("../../inbox/[filename]/route");

const SENSITIVE_ERR = "ECONNREFUSED 127.0.0.1:54321 secret-detail";
const SENSITIVE_UPSTREAM = "upstream-bridge-stacktrace-leak";

let origAllowUnauthenticated: string | undefined;

beforeEach(() => {
  bridgeFetchMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Bypass the session guard (LOW #39 fix) so proxy-behaviour tests
  // don't need real signed session cookies.
  origAllowUnauthenticated = process.env.DASHBOARD_ALLOW_UNAUTHENTICATED;
  process.env.DASHBOARD_ALLOW_UNAUTHENTICATED = "1";
});
afterEach(() => {
  if (origAllowUnauthenticated === undefined) {
    delete process.env.DASHBOARD_ALLOW_UNAUTHENTICATED;
  } else {
    process.env.DASHBOARD_ALLOW_UNAUTHENTICATED = origAllowUnauthenticated;
  }
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
  // NOTE: OAuth callbacks INTENTIONALLY forward non-2xx HTML bodies. The
  // bridge connector handlers (e.g. handleSlackCallback) render user-facing
  // "<h2>Slack connect failed</h2><pre>invalid state</pre>" HTML pages so
  // the popup window can show the user what went wrong. These bodies are
  // hand-authored + HTML-escaped — not stack traces. Hardening would
  // replace useful UX with opaque JSON. Catch-block (network/bridge crash)
  // is still hardened above.
});

describe("issue #600 — connector proxy routes hide upstream body", () => {
  const params = Promise.resolve({ connector: "slack" });
  function ctx() { return { params }; }

  it("[connector]/auth GET — non-2xx returns generic without upstream body", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(SENSITIVE_UPSTREAM, { status: 500 }),
    );
    const res = await connectorAuthGet(
      new Request("https://dashboard.local/x"),
      ctx(),
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain(SENSITIVE_UPSTREAM);
    expect(JSON.parse(body)).toEqual({ error: "Bridge returned 500" });
  });

  it("[connector]/connect POST — non-2xx returns generic without upstream body", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(SENSITIVE_UPSTREAM, { status: 502 }),
    );
    const req = new Request("https://dashboard.local/x", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ token: "x" }),
    });
    // notion is in the connect ALLOWED set (token-paste connector)
    const res = await connectorConnectPost(req, {
      params: Promise.resolve({ connector: "notion" }),
    });
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(SENSITIVE_UPSTREAM);
    expect(JSON.parse(body)).toEqual({ error: "Bridge returned 502" });
  });

  it("[connector]/test POST — non-2xx returns generic without upstream body", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(SENSITIVE_UPSTREAM, { status: 503 }),
    );
    const req = new Request("https://dashboard.local/x", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    const res = await connectorTestPost(req, ctx());
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).not.toContain(SENSITIVE_UPSTREAM);
    expect(JSON.parse(body)).toEqual({ error: "Bridge returned 503" });
  });

  it("[connector] DELETE — non-2xx returns generic without upstream body", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(SENSITIVE_UPSTREAM, { status: 500 }),
    );
    const req = new Request("https://dashboard.local/x", {
      method: "DELETE",
      headers: { "sec-fetch-site": "same-origin" },
    });
    const res = await connectorDelete(req, ctx());
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain(SENSITIVE_UPSTREAM);
    expect(JSON.parse(body)).toEqual({ error: "Bridge returned 500" });
  });
});

describe("issue #600 — inbox routes hide upstream body", () => {
  it("/api/inbox — non-2xx returns generic without upstream body", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(SENSITIVE_UPSTREAM, { status: 500 }),
    );
    const res = await inboxGet();
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain(SENSITIVE_UPSTREAM);
    expect(JSON.parse(body)).toEqual({ error: "Bridge returned 500" });
  });
  it("/api/inbox/:filename — non-2xx returns generic without upstream body", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(SENSITIVE_UPSTREAM, { status: 404 }),
    );
    const res = await inboxItemGet(
      new Request("https://dashboard.local/x"),
      { params: Promise.resolve({ filename: "msg.json" }) },
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain(SENSITIVE_UPSTREAM);
    expect(JSON.parse(body)).toEqual({ error: "Bridge returned 404" });
  });
  it("/api/inbox — network failure returns generic 'Bridge unreachable'", async () => {
    bridgeFetchMock.mockRejectedValueOnce(new Error(SENSITIVE_ERR));
    const res = await inboxGet();
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(SENSITIVE_ERR);
    expect(JSON.parse(body)).toEqual({ error: "Bridge unreachable" });
  });
});
