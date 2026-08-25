/** @vitest-environment node */
/**
 * The proxy forwards the dashboard session cookie to the bridge as
 * `x-patchwork-session`, scoped to POST/PUT on `approve/<id>` and
 * `reject/<id>`. That header is the ONLY way a bridge can attribute an
 * approval to a named member — ADR-0020 Phase A. Without it the decision is
 * recorded UNATTRIBUTED, which is a legitimate state and therefore looks
 * exactly like normal operation.
 *
 * WHY THIS FILE EXISTS. Measured 2026-08-25: deleting the forwarding block
 * outright left the dashboard suite at 126 files / 1299 tests, all green. A
 * silent, total loss of approval attribution passed every check we had — the
 * failure mode being verified against here is not a wrong value but an absent
 * one, and absence is what this whole subsystem is careful about elsewhere.
 *
 * The scoping is asserted in BOTH directions on purpose. The block's own
 * comment justifies the narrow scope: "a session credential forwarded to every
 * bridge endpoint is a credential in far more logs and handlers than the one
 * place that needs it". A test that only checked the happy path would pass just
 * as well if the scope were widened to every request, which is the opposite
 * defect and a credential-leak rather than an attribution loss.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeFetchMock = vi.fn();
vi.mock("@/lib/bridge", () => ({
  bridgeFetch: (...args: unknown[]) => bridgeFetchMock(...args),
  findBridge: () => ({ port: 3101, authToken: "t", workspace: "/w" }),
  resolveBridgeUrl: () => "http://127.0.0.1:3101",
}));
vi.mock("@/lib/csrf", () => ({ requireSameOrigin: () => null }));

const route = await import("../[...path]/route");

const COOKIE = "patchwork_session";
const SESSION = "v2.alice.9999999999999.deadbeef";

/** Headers the proxy actually handed to `bridgeFetch` on the last call. */
function forwardedHeaders(): Record<string, string> {
  const init = bridgeFetchMock.mock.calls.at(-1)?.[1] as
    | { headers?: Record<string, string> }
    | undefined;
  return init?.headers ?? {};
}

function req(method: string, withCookie: boolean): NextRequest {
  // A real NextRequest: the proxy reads `nextUrl.search` and `cookies`, neither
  // of which a plain Request has.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (withCookie) headers.cookie = `${COOKIE}=${SESSION}`;
  return new NextRequest("http://localhost/api/bridge/x", {
    method,
    headers,
    ...(method === "POST" || method === "PUT" ? { body: "{}" } : {}),
  });
}

/** Drive the proxy the way Next does: dynamic params arrive as a Promise. */
async function call(method: "POST" | "PUT" | "GET", path: string[], withCookie = true) {
  const handler = route[method] as (
    r: NextRequest,
    c: { params: Promise<{ path: string[] }> },
  ) => Promise<Response>;
  await handler(req(method, withCookie), { params: Promise.resolve({ path }) });
}

let origAllow: string | undefined;

beforeEach(() => {
  bridgeFetchMock.mockReset();
  bridgeFetchMock.mockResolvedValue(
    new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  origAllow = process.env.DASHBOARD_ALLOW_UNAUTHENTICATED;
  process.env.DASHBOARD_ALLOW_UNAUTHENTICATED = "1";
});

afterEach(() => {
  if (origAllow === undefined) delete process.env.DASHBOARD_ALLOW_UNAUTHENTICATED;
  else process.env.DASHBOARD_ALLOW_UNAUTHENTICATED = origAllow;
  vi.restoreAllMocks();
});

describe("approval proxy forwards the session so a decision can be attributed", () => {
  it.each([
    ["POST", "approve"],
    ["POST", "reject"],
    ["PUT", "approve"],
    ["PUT", "reject"],
  ] as const)("%s %s/<id> carries x-patchwork-session", async (method, verb) => {
    await call(method, [verb, "call-1"]);
    expect(forwardedHeaders()["x-patchwork-session"]).toBe(SESSION);
  });

  it("omits the header when there is no session cookie", async () => {
    // Unattributed must stay reachable: an operator with no session still
    // approves, the decision simply names nobody.
    await call("POST", ["approve", "call-1"], false);
    expect(forwardedHeaders()).not.toHaveProperty("x-patchwork-session");
  });
});

describe("the session is NOT forwarded anywhere else", () => {
  it("does not forward on GET of the same path", async () => {
    await call("GET", ["approve", "call-1"]);
    expect(forwardedHeaders()).not.toHaveProperty("x-patchwork-session");
  });

  it.each([
    [["runs", "42"]],
    [["recipes", "list"]],
    [["kill-switch", "engage"]],
  ])("does not forward on POST %j", async (path) => {
    await call("POST", path as string[]);
    expect(forwardedHeaders()).not.toHaveProperty("x-patchwork-session");
  });

  it("does not forward when the path is approve with the wrong arity", async () => {
    // segments.length === 2 is the guard; a deeper path is a different endpoint.
    await call("POST", ["approve", "call-1", "extra"]);
    expect(forwardedHeaders()).not.toHaveProperty("x-patchwork-session");
  });
});
