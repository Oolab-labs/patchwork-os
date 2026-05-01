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

import { POST } from "@/app/api/push/subscribe/route";
import { addSubscription } from "@/lib/pushStore";

beforeEach(() => {
  vi.mocked(addSubscription).mockReset();
});

function makeReq(secFetchSite: string | null, body: unknown): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (secFetchSite !== null) headers.set("sec-fetch-site", secFetchSite);
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

  it("accepts same-origin requests", async () => {
    const res = await POST(makeReq("same-origin", validSub));
    expect(res.status).toBe(200);
    expect(addSubscription).toHaveBeenCalledOnce();
  });
});
