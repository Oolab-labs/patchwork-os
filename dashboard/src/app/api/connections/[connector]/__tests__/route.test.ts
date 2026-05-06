/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock bridgeFetch — every route under [connector] proxies through it.
const bridgeFetchMock = vi.fn();
vi.mock("@/lib/bridge", () => ({
  bridgeFetch: (...args: unknown[]) => bridgeFetchMock(...args),
}));

import { DELETE as deleteConnection } from "../route";
import { POST as postTest } from "../test/route";
import { GET as getAuth } from "../auth/route";
import { POST as postConnect } from "../connect/route";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function reqWithHeaders(headers: Record<string, string> = {}): Request {
  return new Request("https://dashboard.local/api/connections/x", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  bridgeFetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DELETE /api/connections/[connector]", () => {
  it("returns 404 for an unknown connector and never hits the bridge", async () => {
    const res = await deleteConnection(
      reqWithHeaders({ "sec-fetch-site": "same-origin" }),
      { params: { connector: "not-a-thing" } },
    );
    expect(res.status).toBe(404);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("returns 403 when CSRF guard rejects cross-site", async () => {
    const res = await deleteConnection(
      reqWithHeaders({ "sec-fetch-site": "cross-site" }),
      { params: { connector: "gmail" } },
    );
    expect(res.status).toBe(403);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("proxies to /connections/<id> with method=DELETE and passes status + content-type through", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await deleteConnection(
      reqWithHeaders({ "sec-fetch-site": "same-origin" }),
      { params: { connector: "gmail" } },
    );
    expect(bridgeFetchMock).toHaveBeenCalledWith("/connections/gmail", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 502 with the error message when the bridge call throws", async () => {
    bridgeFetchMock.mockRejectedValueOnce(new TypeError("ECONNREFUSED"));
    const res = await deleteConnection(
      reqWithHeaders({ "sec-fetch-site": "same-origin" }),
      { params: { connector: "gmail" } },
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "ECONNREFUSED" });
  });
});

describe("POST /api/connections/[connector]/test", () => {
  it("returns 404 for unknown connector", async () => {
    const res = await postTest(reqWithHeaders(), {
      params: { connector: "nope" },
    });
    expect(res.status).toBe(404);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("proxies to /connections/<id>/test with method=POST", async () => {
    bridgeFetchMock.mockResolvedValueOnce(jsonResponse({ healthy: true }));
    const res = await postTest(reqWithHeaders(), {
      params: { connector: "linear" },
    });
    expect(bridgeFetchMock).toHaveBeenCalledWith(
      "/connections/linear/test",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ healthy: true });
  });

  it("502s on bridge throw and surfaces 'fetch failed' for non-Error rejection values", async () => {
    bridgeFetchMock.mockRejectedValueOnce("plain-string-not-an-error");
    const res = await postTest(reqWithHeaders(), {
      params: { connector: "linear" },
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "fetch failed" });
  });
});

describe("GET /api/connections/[connector]/auth", () => {
  function getReq(): Request {
    return new Request("https://dashboard.local/api/connections/gmail/auth");
  }

  it("returns 404 for unknown connector", async () => {
    const res = await getAuth(getReq(), { params: { connector: "nope" } });
    expect(res.status).toBe(404);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("forwards a 302 with Location to a Response.redirect", async () => {
    const target = "https://accounts.google.com/oauth/authorize?client_id=x";
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: target } }),
    );
    const res = await getAuth(getReq(), { params: { connector: "gmail" } });
    expect(bridgeFetchMock).toHaveBeenCalledWith(
      "/connections/gmail/auth",
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(target);
  });

  it("502s when the bridge returns a redirect without a Location header", async () => {
    // Defensive case: malformed proxy or older bridge missing the Location.
    // Pinned because the alternative (silently passing through) would loop
    // the browser back to /api/connections/<id>/auth.
    bridgeFetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));
    const res = await getAuth(getReq(), { params: { connector: "gmail" } });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Location/);
  });

  it("passes a non-redirect response through with body + status + content-type", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "client_id missing" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await getAuth(getReq(), { params: { connector: "gmail" } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "client_id missing" });
  });

  it("502s on bridge throw", async () => {
    bridgeFetchMock.mockRejectedValueOnce(new Error("dns timeout"));
    const res = await getAuth(getReq(), { params: { connector: "gmail" } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "dns timeout" });
  });
});

describe("POST /api/connections/[connector]/connect (token-paste)", () => {
  function postWithBody(
    body: string,
    site = "same-origin",
  ): Request {
    return new Request("https://dashboard.local/api/connections/notion/connect", {
      method: "POST",
      headers: {
        "sec-fetch-site": site,
        "content-type": "application/json",
      },
      body,
    });
  }

  it("returns 403 on cross-site request", async () => {
    const res = await postConnect(
      postWithBody(JSON.stringify({ token: "x" }), "cross-site"),
      { params: { connector: "notion" } },
    );
    expect(res.status).toBe(403);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects OAuth-only connectors with 404 (gmail/github/etc. don't have a /connect handler)", async () => {
    // Pinned: this allowlist is INTENTIONALLY narrower than the parent
    // route's list. OAuth providers must go through /auth, not /connect.
    const res = await postConnect(postWithBody(JSON.stringify({ token: "x" })), {
      params: { connector: "gmail" },
    });
    expect(res.status).toBe(404);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("proxies the raw body to /connections/<id>/connect", async () => {
    bridgeFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const body = JSON.stringify({ token: "secret-123" });
    const res = await postConnect(postWithBody(body), {
      params: { connector: "notion" },
    });
    expect(bridgeFetchMock).toHaveBeenCalledWith(
      "/connections/notion/connect",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
    );
    expect(res.status).toBe(200);
  });

  it("502s on bridge throw with the error message", async () => {
    bridgeFetchMock.mockRejectedValueOnce(new Error("upstream down"));
    const res = await postConnect(postWithBody(JSON.stringify({ token: "x" })), {
      params: { connector: "notion" },
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream down" });
  });
});
