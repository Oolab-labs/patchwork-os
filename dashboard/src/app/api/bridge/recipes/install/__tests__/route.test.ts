/** @vitest-environment node */
/**
 * Server-side validation tests for /api/bridge/recipes/install.
 *
 * Audit (2026-05-16, post-PR #556) found the proxy forwarded any body to
 * the bridge with no shape check — browser-side assertValidInstallSource
 * was the only defense, easily bypassed by direct POST. The bridge does
 * validate, but the dashboard layer should reject obviously bad input
 * before opening the bridge socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetRateLimitForTests, _rateLimitConfig } from "@/lib/authRateLimit";
import { POST } from "../route";

const bridgeFetchMock = vi.fn(
  async (_path: string, _init: { body: string; method: string }) =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);
vi.mock("@/lib/bridge", () => ({
  bridgeFetch: (path: string, init: { body: string; method: string }) =>
    bridgeFetchMock(path, init),
}));

function makeReq(body: string, extraHeaders?: Record<string, string>): Request {
  return new Request("https://dashboard.local/api/bridge/recipes/install", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...extraHeaders,
    },
    body,
  });
}

// The install route applies a per-session/per-IP call-count limiter whose
// state is a module singleton. Reset it around every test so accumulated
// calls from earlier specs can't trip the limiter for unrelated cases.
beforeEach(() => {
  _resetRateLimitForTests();
});
afterEach(() => {
  _resetRateLimitForTests();
});

describe("POST /api/bridge/recipes/install — source validation", () => {
  it("rejects non-JSON bodies with 400 / bad_json", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(makeReq("not json"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("bad_json");
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects array bodies with 400 / bad_body_shape", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(makeReq("[1,2,3]"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("bad_body_shape");
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects bodies missing `source` with 400 / bad_source_type", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(makeReq(JSON.stringify({ foo: "bar" })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("bad_source_type");
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-string `source` (number) with 400 / bad_source_type", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(makeReq(JSON.stringify({ source: 42 })));
    expect(res.status).toBe(400);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects opaque non-github sources with 400 / bad_source_shape", async () => {
    bridgeFetchMock.mockClear();
    // Tampered-registry attack: indexes a recipe with an https://attacker.com source.
    const res = await POST(
      makeReq(JSON.stringify({ source: "https://attacker.com/payload.yaml" })),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("bad_source_shape");
    expect(body.error ?? "").toMatch(/github:owner\/repo/i);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects file:// sources with 400 / bad_source_shape", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(
      makeReq(JSON.stringify({ source: "file:///etc/passwd" })),
    );
    expect(res.status).toBe(400);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("forwards a well-formed github: source to the bridge", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(
      makeReq(
        JSON.stringify({
          source: "github:patchworkos/recipes/recipes/morning-brief",
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(bridgeFetchMock).toHaveBeenCalledTimes(1);
    const call = bridgeFetchMock.mock.calls[0];
    const [path, init] = call as unknown as [string, { body: string }];
    expect(path).toBe("/recipes/install");
    // Body forwarded VERBATIM — re-serialising would mutate ordering and
    // strip whitespace that the bridge's payload signature would care about
    // in a future signed-payload flow.
    expect(init.body).toBe(
      JSON.stringify({
        source: "github:patchworkos/recipes/recipes/morning-brief",
      }),
    );
  });

  it("forwards a github: source with an @ref tag", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(
      makeReq(
        JSON.stringify({
          source: "github:patchworkos/recipes/recipes/morning-brief@v1.2.0",
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(bridgeFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/bridge/recipes/install — content-type mirroring", () => {
  it("mirrors an upstream text/html content-type instead of forcing JSON", async () => {
    bridgeFetchMock.mockClear();
    // Remote mode: a reverse proxy in front of the bridge returns an HTML
    // error page. The proxy must NOT relabel it application/json — that
    // makes the client silently fail to parse the (HTML) body.
    bridgeFetchMock.mockResolvedValueOnce(
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const res = await POST(
      makeReq(
        JSON.stringify({
          source: "github:patchworkos/recipes/recipes/morning-brief",
        }),
      ),
    );
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("502 Bad Gateway");
  });

  it("still labels a JSON upstream body application/json", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(
      makeReq(
        JSON.stringify({
          source: "github:patchworkos/recipes/recipes/morning-brief",
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("POST /api/bridge/recipes/install — per-session rate limit", () => {
  const goodBody = JSON.stringify({
    source: "github:patchworkos/recipes/recipes/morning-brief",
  });

  it("returns 429 + Retry-After once a session exceeds the call limit", async () => {
    bridgeFetchMock.mockClear();
    // Same session cookie on every call → same bucket.
    const cookie = "patchwork_session=v1.9999999999999.sig-abc";
    const limit = _rateLimitConfig.MAX_CALLS;

    // Calls up to the limit pass through to the bridge (mocked 200).
    for (let i = 0; i < limit; i++) {
      const res = await POST(makeReq(goodBody, { cookie }));
      expect(res.status).toBe(200);
    }
    expect(bridgeFetchMock).toHaveBeenCalledTimes(limit);

    // The next call is rejected BEFORE forwarding to the bridge.
    const blocked = await POST(makeReq(goodBody, { cookie }));
    expect(blocked.status).toBe(429);
    const retryAfter = blocked.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number.parseInt(retryAfter ?? "0", 10)).toBeGreaterThan(0);
    const body = (await blocked.json()) as { error?: string; code?: string };
    expect(body.code).toBe("rate_limited");
    expect(typeof body.error).toBe("string");
    // Bridge must NOT have been called for the over-limit request.
    expect(bridgeFetchMock).toHaveBeenCalledTimes(limit);
  });

  it("isolates distinct sessions — one saturated cookie does not block another", async () => {
    bridgeFetchMock.mockClear();
    const limit = _rateLimitConfig.MAX_CALLS;
    const noisy = "patchwork_session=v1.9999999999999.noisy";
    const quiet = "patchwork_session=v1.9999999999999.quiet";

    for (let i = 0; i <= limit; i++) {
      await POST(makeReq(goodBody, { cookie: noisy }));
    }
    // Noisy session is now blocked.
    const noisyRes = await POST(makeReq(goodBody, { cookie: noisy }));
    expect(noisyRes.status).toBe(429);

    // A different session still gets through.
    const quietRes = await POST(makeReq(goodBody, { cookie: quiet }));
    expect(quietRes.status).toBe(200);
  });
});

describe("POST /api/bridge/recipes/install — CSRF gate", () => {
  it("rejects cross-site POST with 403", async () => {
    const req = new Request("https://dashboard.local/api/bridge/recipes/install", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({
        source: "github:patchworkos/recipes/recipes/morning-brief",
      }),
    });
    bridgeFetchMock.mockClear();
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });
});
