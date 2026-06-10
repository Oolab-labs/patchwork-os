/** @vitest-environment node */
/**
 * Tests for the push test-notification route (`POST /api/push/test`).
 *
 * Regressions:
 *  - dashboard-api-2: the test payload is shaped like an approval
 *    notification, so it must honour the per-subscription `approvals` opt-out
 *    via getSubscriptionsFor('approvals') — NOT the unfiltered
 *    getSubscriptions().
 *  - dashboard-api-3: VAPID keys must be read at request time (not at module
 *    load), so rotated keys take effect without a server restart.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async () => ({ statusCode: 201 })),
  },
}));

vi.mock("@/lib/pushStore", () => ({
  getSubscriptions: vi.fn(() => []),
  getSubscriptionsFor: vi.fn(() => []),
}));

import webpush from "web-push";
import { POST } from "@/app/api/push/test/route";
import { getSubscriptions, getSubscriptionsFor } from "@/lib/pushStore";

const validSub = {
  endpoint: "https://example.com/push/abc",
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
};

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3200/api/push/test", {
    method: "POST",
    // sec-fetch-site: same-origin passes the CSRF guard.
    headers: { "sec-fetch-site": "same-origin", ...headers },
  });
}

const ENV_KEYS = [
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
] as const;

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "test-vapid-public";
  process.env.VAPID_PRIVATE_KEY = "test-vapid-private";
  process.env.VAPID_SUBJECT = "mailto:test@example.com";
  vi.mocked(getSubscriptions).mockReturnValue([validSub]);
  vi.mocked(getSubscriptionsFor).mockReturnValue([validSub]);
  vi.mocked(webpush.sendNotification).mockClear();
  vi.mocked(webpush.setVapidDetails).mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

describe("POST /api/push/test — approvals opt-out (dashboard-api-2)", () => {
  it("fans out via getSubscriptionsFor('approvals'), not the unfiltered getSubscriptions()", async () => {
    await POST(req());
    expect(getSubscriptionsFor).toHaveBeenCalledWith("approvals");
    expect(getSubscriptions).not.toHaveBeenCalled();
  });

  it("excludes a subscription that opted out of approvals", async () => {
    const optedIn = validSub;
    const optedOut = {
      endpoint: "https://opted-out.example.com/p",
      keys: { p256dh: "k1", auth: "k2" },
    };
    vi.mocked(getSubscriptionsFor).mockImplementation((kind) =>
      kind === "approvals" ? [optedIn] : [optedIn, optedOut],
    );

    const r = await POST(req());
    expect(r.status).toBe(200);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    const sentEndpoints = vi
      .mocked(webpush.sendNotification)
      .mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint);
    expect(sentEndpoints).toEqual([optedIn.endpoint]);
    expect(sentEndpoints).not.toContain(optedOut.endpoint);
  });

  it("404 when no subscription opted in to approvals", async () => {
    vi.mocked(getSubscriptionsFor).mockReturnValue([]);
    const r = await POST(req());
    expect(r.status).toBe(404);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});

describe("POST /api/push/test — VAPID read at request time (dashboard-api-3)", () => {
  it("uses VAPID keys set AFTER module load (rotation without restart)", async () => {
    // Rotate the keys in the running process. A module-load capture would miss
    // this; the request-time read must pick them up.
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "rotated-public";
    process.env.VAPID_PRIVATE_KEY = "rotated-private";
    process.env.VAPID_SUBJECT = "mailto:rotated@example.com";

    const r = await POST(req());
    expect(r.status).toBe(200);
    expect(webpush.setVapidDetails).toHaveBeenCalledWith(
      "mailto:rotated@example.com",
      "rotated-public",
      "rotated-private",
    );
  });

  it("503 when VAPID keys are cleared at request time", async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    const r = await POST(req());
    expect(r.status).toBe(503);
  });
});
