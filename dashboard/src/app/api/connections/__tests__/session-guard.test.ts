/** @vitest-environment node */
/**
 * LOW #39 — OAuth callback routes must verify session before forwarding
 *
 * The OAuth callback routes are middleware-exempt. Without a session check,
 * any request that knows the callback URL can complete an OAuth flow on
 * behalf of a user (e.g. by sending a crafted ?code=…&state=… directly).
 *
 * Fix: each callback route must verify the session cookie before forwarding
 * to the bridge. Unauthenticated requests must get 401.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock bridgeFetch so these tests don't need a real bridge.
const bridgeFetchMock = vi.fn();
vi.mock("@/lib/bridge", () => ({
  bridgeFetch: (...args: unknown[]) => bridgeFetchMock(...args),
}));

import { GET as githubCallback } from "../github/callback/route";

type Handler = (req: Request) => Promise<Response>;

const ROUTES: { name: string; handler: Handler }[] = [
  { name: "github", handler: githubCallback },
];

const ENV_KEYS = ["DASHBOARD_PASSWORD", "DASHBOARD_SESSION_SECRET"] as const;
let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.DASHBOARD_PASSWORD = "s3cr3t";
  process.env.DASHBOARD_SESSION_SECRET = "0123456789abcdef0123456789abcdef";
  bridgeFetchMock.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  vi.restoreAllMocks();
});

function reqWithoutSession(query: string): Request {
  return new Request(`https://dashboard.local/api/connections/github/callback?${query}`);
}

describe.each(ROUTES)("$name OAuth callback — session guard (LOW #39)", ({ handler }) => {
  it("returns 401 when no session cookie is present", async () => {
    // An unauthenticated attacker must not be able to complete the OAuth flow.
    const res = await handler(reqWithoutSession("code=stolen&state=xyz"));
    expect(res.status).toBe(401);
    // bridgeFetch must NOT have been called
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 when session cookie is malformed / invalid", async () => {
    const req = new Request(
      "https://dashboard.local/api/connections/github/callback?code=abc&state=s",
      { headers: { cookie: "patchwork_session=invalid-garbage" } },
    );
    const res = await handler(req);
    expect(res.status).toBe(401);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });
});
