/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All 7 OAuth callback routes proxy through bridgeFetch with an
// allowlisted query string. Mock once and parameterize over the routes.
const bridgeFetchMock = vi.fn();
vi.mock("@/lib/bridge", () => ({
  bridgeFetch: (...args: unknown[]) => bridgeFetchMock(...args),
}));

import { GET as connectorCallback } from "../[connector]/callback/route";
import { oauthConnectorIds } from "../../../../../../src/connectors/connectorRegistry";

type Handler = (req: Request) => Promise<Response>;

/** Bind the one dynamic route to a slug, so each case still calls `GET(req)`. */
const bind =
  (connector: string): Handler =>
  (req) =>
    connectorCallback(req, { params: Promise.resolve({ connector }) });

// DERIVED, not hand-listed. The table here named 10 routes while the registry
// has 13 OAuth connectors — github, linear and sentry were never exercised.
// The same drift this file was written to catch (audit 2026-06-08
// unsurfaced-1: "offered + auth-capable but had no dashboard callback route")
// had simply recurred in the test's own list.
const ROUTES: { name: string; bridgePath: string; handler: Handler }[] =
  oauthConnectorIds().map((name) => ({
    name,
    bridgePath: `/connections/${name}/callback`,
    handler: bind(name),
  }));

it("covers every OAuth connector (anchor)", () => {
  // An empty registry would make every parameterised case below vacuous.
  expect(ROUTES.length).toBeGreaterThanOrEqual(13);
});

let origAllowUnauthenticated: string | undefined;

beforeEach(() => {
  bridgeFetchMock.mockReset();
  // Bypass the session guard (LOW #39 fix) so these proxy-behaviour tests
  // don't need a real signed session cookie.
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

function reqWithQuery(query: string): Request {
  return new Request(`https://dashboard.local/cb?${query}`);
}

describe.each(ROUTES)("$name OAuth callback", ({ bridgePath, handler }) => {
  it(`forwards code+state to ${bridgePath} and passes status + body through`, async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await handler(reqWithQuery("code=abc123&state=nonce"));
    expect(bridgeFetchMock).toHaveBeenCalledOnce();
    const [calledPath] = bridgeFetchMock.mock.calls[0]!;
    expect(calledPath).toContain(bridgePath);
    expect(calledPath).toContain("code=abc123");
    expect(calledPath).toContain("state=nonce");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("forwards an error param when the provider denied the request", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await handler(reqWithQuery("error=access_denied&state=x"));
    const [calledPath] = bridgeFetchMock.mock.calls[0]!;
    expect(calledPath).toContain("error=access_denied");
    expect(calledPath).toContain("state=x");
    expect(res.status).toBe(400);
  });

  it("strips unallowed query params (only code/state/error reach the bridge)", async () => {
    // Allowlist matters — without it, an attacker could inject arbitrary
    // query params (e.g. ?bridge_secret=...) into the upstream call.
    bridgeFetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    await handler(
      reqWithQuery("code=ok&utm_source=phish&bridge_secret=oops&state=s"),
    );
    const [calledPath] = bridgeFetchMock.mock.calls[0]!;
    expect(calledPath).toContain("code=ok");
    expect(calledPath).toContain("state=s");
    expect(calledPath).not.toContain("utm_source");
    expect(calledPath).not.toContain("bridge_secret");
  });

  it("502s with a generic error when bridgeFetch throws (issue #600 — no err.message leak)", async () => {
    bridgeFetchMock.mockRejectedValueOnce(new Error("connection reset"));
    const res = await handler(reqWithQuery("code=x"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Bridge unreachable" });
  });

  it("passes a 5xx response from the bridge through with body + status", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "exchange failed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await handler(reqWithQuery("code=x&state=y"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "exchange failed" });
  });
});
