/**
 * Regression test: the push/subscribe POST handler must reject cross-site
 * requests via the same sec-fetch-site check the bridge proxy uses.
 *
 * Without the guard, any third-party page can register a push subscription
 * for a victim's bridge by submitting a hidden form / fetch from a different
 * origin. Browsers send the cookies, the route accepts the body, and the
 * attacker-controlled endpoint receives every approval push from then on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/pushStore", () => ({
  addSubscription: vi.fn(),
}));

// Audit 2026-05-17 (#600): subscribe now requires a valid session
// (defense-in-depth on top of CSRF) — see route.ts comment. Mock
// verifySession so existing CSRF tests still exercise the same-origin
// path with a valid session by default; the new session-required test
// makes verifySession return invalid.
vi.mock("@/lib/session", () => ({
  SESSION_COOKIE_NAME: "patchwork_session",
  verifySession: vi.fn(),
}));

import { POST } from "@/app/api/push/subscribe/route";
import { addSubscription } from "@/lib/pushStore";
import { verifySession } from "@/lib/session";

beforeEach(() => {
  vi.mocked(addSubscription).mockReset();
  // addSubscription now reports whether the store accepted the endpoint;
  // the default is "accepted" so the CSRF/session cases below still 200.
  vi.mocked(addSubscription).mockReturnValue(true);
  vi.mocked(verifySession).mockResolvedValue({ valid: true, expiresAt: Date.now() + 60_000 });
});

function makeReq(
  secFetchSite: string | null,
  body: unknown,
  cookie: string = "patchwork_session=valid",
): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (secFetchSite !== null) headers.set("sec-fetch-site", secFetchSite);
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest("http://localhost:3200/api/push/subscribe", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const validSub = {
  endpoint: "https://example.com/push/abc",
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
};

describe("POST /api/push/subscribe — CSRF guard", () => {
  it("rejects cross-site requests with 403", async () => {
    const res = await POST(makeReq("cross-site", validSub));
    expect(res.status).toBe(403);
    expect(addSubscription).not.toHaveBeenCalled();
  });

  it("rejects same-site (subdomain) requests with 403", async () => {
    const res = await POST(makeReq("same-site", validSub));
    expect(res.status).toBe(403);
    expect(addSubscription).not.toHaveBeenCalled();
  });

  it("accepts same-origin requests with valid session", async () => {
    const res = await POST(makeReq("same-origin", validSub));
    expect(res.status).toBe(200);
    expect(addSubscription).toHaveBeenCalledOnce();
  });

  it("rejects same-origin requests without a valid session (401)", async () => {
    vi.mocked(verifySession).mockResolvedValue({ valid: false });
    const res = await POST(makeReq("same-origin", validSub));
    expect(res.status).toBe(401);
    expect(addSubscription).not.toHaveBeenCalled();
  });
});

// Security sweep 2026-10-01 (L2): the endpoint is a URL this server POSTs to
// on every fan-out. A private-range or non-https endpoint must never reach
// the store; a full store must refuse a NEW endpoint rather than grow.
describe("POST /api/push/subscribe — endpoint validation and cap", () => {
  it.each([
    ["loopback", "https://127.0.0.1/push"],
    ["RFC1918", "https://10.0.0.5/push"],
    ["http", "http://push.example.test/push"],
    ["credentials", "https://u:p@push.example.test/push"],
  ])("rejects a %s endpoint with 400 and stores nothing", async (_l, endpoint) => {
    const res = await POST(makeReq("same-origin", { ...validSub, endpoint }));
    expect(res.status).toBe(400);
    expect(addSubscription).not.toHaveBeenCalled();
    // The reason must not echo the rejected URL back.
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain(endpoint);
  });

  it("returns 429 when the store refuses a new endpoint at the cap", async () => {
    vi.mocked(addSubscription).mockReturnValue(false);
    const res = await POST(
      makeReq("same-origin", { ...validSub, endpoint: "https://push.example.test/x" }),
    );
    expect(res.status).toBe(429);
  });
});
