/**
 * Tests for the bridge → dashboard push relay (`POST /api/relay/push`).
 *
 * The dashboard acts as a drop-in for the standalone push-relay service:
 * the bridge POSTs an approval payload here, the dashboard fans out via
 * Web Push (VAPID) to every browser subscription. Auth is a Bearer
 * token compared timing-safe against `PATCHWORK_PUSH_TOKEN`.
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
  removeSubscription: vi.fn(),
}));

import webpush from "web-push";
import { POST } from "@/app/api/relay/push/route";
import {
  getSubscriptions,
  getSubscriptionsFor,
  removeSubscription,
} from "@/lib/pushStore";

const TOKEN = "relay-test-token-1234567890abcdef";

const validSub = {
  endpoint: "https://example.com/push/abc",
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
};

const validBody = {
  callId: "call-123",
  toolName: "Bash",
  tier: "high",
  approvalToken: "deadbeef".repeat(8),
  bridgeCallbackBase: "https://bridge.example.com",
  summary: "rm -rf /tmp/test",
  expiresAt: Date.now() + 5 * 60_000,
};

function req(headers: Record<string, string>, body: unknown): NextRequest {
  return new NextRequest("http://localhost:3200/api/relay/push", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const ENV_KEYS = [
  "PATCHWORK_PUSH_TOKEN",
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
] as const;

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalEnv = Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  );
  process.env.PATCHWORK_PUSH_TOKEN = TOKEN;
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "test-vapid-public";
  process.env.VAPID_PRIVATE_KEY = "test-vapid-private";
  process.env.VAPID_SUBJECT = "mailto:test@example.com";
  vi.mocked(getSubscriptions).mockReturnValue([validSub]);
  vi.mocked(getSubscriptionsFor).mockReturnValue([validSub]);
  vi.mocked(removeSubscription).mockClear();
  vi.mocked(webpush.sendNotification).mockClear();
  vi.mocked(webpush.setVapidDetails).mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

describe("POST /api/relay/push — auth", () => {
  it("401 when Authorization header is missing", async () => {
    const r = await POST(req({}, validBody));
    expect(r.status).toBe(401);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("401 when Bearer token does not match PATCHWORK_PUSH_TOKEN", async () => {
    const r = await POST(req({ authorization: "Bearer wrong-token" }, validBody));
    expect(r.status).toBe(401);
  });

  it("401 when PATCHWORK_PUSH_TOKEN env var is unset (fail-closed)", async () => {
    delete process.env.PATCHWORK_PUSH_TOKEN;
    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(r.status).toBe(401);
  });

  it("401 when scheme is not Bearer", async () => {
    const r = await POST(req({ authorization: `Basic ${TOKEN}` }, validBody));
    expect(r.status).toBe(401);
  });

  // ─── auth-bypass regression — audit 2026-06-08 HIGH (dash-api-1) ───────────
  // The old verifyBearer padded into a 256-byte buffer but SKIPPED the copy
  // when an input exceeded 256 bytes (`if (a.length <= PAD) a.copy(pa)`),
  // leaving the buffer all-zeros. Two >256-byte inputs of equal length both
  // compared as all-zeros → timingSafeEqual returned true and any same-length
  // payload authenticated. login/route.ts was fixed for this (HIGH #2); the
  // relays were never ported. Practical because PATCHWORK_PUSH_TOKEN can be a
  // long random/JWT-style secret.
  it("401 when a wrong >256-byte token of equal length is presented (no all-zeros collision)", async () => {
    process.env.PATCHWORK_PUSH_TOKEN = "A".repeat(300);
    const r = await POST(
      req({ authorization: `Bearer ${"B".repeat(300)}` }, validBody),
    );
    expect(r.status).toBe(401);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("200 when the correct >256-byte token is presented (over-cap secret still works up to CAP)", async () => {
    const longToken = `tok-${"x".repeat(300)}`;
    process.env.PATCHWORK_PUSH_TOKEN = longToken;
    const r = await POST(
      req({ authorization: `Bearer ${longToken}` }, validBody),
    );
    expect(r.status).toBe(200);
  });
});

describe("POST /api/relay/push — VAPID config", () => {
  it("503 when VAPID keys are not configured", async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(r.status).toBe(503);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/VAPID/i);
  });
});

describe("POST /api/relay/push — payload validation", () => {
  it("400 when callId is missing", async () => {
    const { callId: _, ...rest } = validBody;
    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, rest));
    expect(r.status).toBe(400);
  });

  it("400 when approvalToken is missing", async () => {
    const { approvalToken: _, ...rest } = validBody;
    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, rest));
    expect(r.status).toBe(400);
  });

  it("400 when bridgeCallbackBase is http:// (must be HTTPS)", async () => {
    const r = await POST(
      req(
        { authorization: `Bearer ${TOKEN}` },
        { ...validBody, bridgeCallbackBase: "http://attacker.tld" },
      ),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/HTTPS/i);
  });

  it("400 when expiresAt is in the past", async () => {
    const r = await POST(
      req(
        { authorization: `Bearer ${TOKEN}` },
        { ...validBody, expiresAt: Date.now() - 1000 },
      ),
    );
    expect(r.status).toBe(400);
  });

  it("400 when bridgeCallbackBase is 'https://' with no hostname (audit 2026-06-03 MEDIUM #19)", async () => {
    // 'https://' passes startsWith('https://') but new URL('/path', 'https://')
    // throws TypeError: Invalid URL — unhandled exception returning 500 instead of 400.
    const r = await POST(
      req(
        { authorization: `Bearer ${TOKEN}` },
        { ...validBody, bridgeCallbackBase: "https://" },
      ),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/url|HTTPS/i);
  });
});

describe("POST /api/relay/push — fan-out", () => {
  it("404 when no subscriptions registered (informational, not an error)", async () => {
    vi.mocked(getSubscriptionsFor).mockReturnValue([]);
    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(r.status).toBe(404);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("200 + per-subscription fan-out, sent count reflects fulfilled deliveries", async () => {
    const subs = [
      validSub,
      { endpoint: "https://e2.com/p", keys: { p256dh: "k1", auth: "k2" } },
      { endpoint: "https://e3.com/p", keys: { p256dh: "k3", auth: "k4" } },
    ];
    vi.mocked(getSubscriptionsFor).mockReturnValue(subs);
    // Make the 2nd subscription fail — sent should be 2/3.
    vi.mocked(webpush.sendNotification).mockImplementation(async (sub) => {
      if (sub.endpoint === subs[1].endpoint) throw new Error("410 gone");
      return { statusCode: 201, body: "", headers: {} };
    });

    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(r.status).toBe(200);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(3);
    const body = (await r.json()) as {
      ok: boolean;
      sent: number;
      total: number;
      evicted: number;
    };
    expect(body).toEqual({ ok: true, sent: 2, total: 3, evicted: 0 });
    // Plain Error has no statusCode → not evicted.
    expect(removeSubscription).not.toHaveBeenCalled();
  });

  // ─── 410 Gone eviction — audit 2026-05-17 ─────────────────────────────────
  it("evicts subscriptions that 410-Gone from the push service", async () => {
    const subs = [
      validSub,
      { endpoint: "https://e2.com/p", keys: { p256dh: "k1", auth: "k2" } },
      { endpoint: "https://e3.com/p", keys: { p256dh: "k3", auth: "k4" } },
    ];
    vi.mocked(getSubscriptionsFor).mockReturnValue(subs);
    vi.mocked(webpush.sendNotification).mockImplementation(async (sub) => {
      if (sub.endpoint === subs[1].endpoint) {
        // web-push throws WebPushError with statusCode 410 for expired
        // subscriptions. Reproduce shape without importing the class.
        const err = new Error("Gone") as Error & { statusCode: number };
        err.statusCode = 410;
        throw err;
      }
      return { statusCode: 201, body: "", headers: {} };
    });

    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { evicted: number };
    expect(body.evicted).toBe(1);
    expect(removeSubscription).toHaveBeenCalledTimes(1);
    expect(removeSubscription).toHaveBeenCalledWith(subs[1].endpoint);
  });

  it("evicts subscriptions that 404 from the push service", async () => {
    vi.mocked(getSubscriptionsFor).mockReturnValue([validSub]);
    vi.mocked(webpush.sendNotification).mockImplementation(async () => {
      const err = new Error("Not Found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    });
    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { evicted: number };
    expect(body.evicted).toBe(1);
    expect(removeSubscription).toHaveBeenCalledWith(validSub.endpoint);
  });

  it("does NOT evict on transient 5xx failures", async () => {
    vi.mocked(getSubscriptionsFor).mockReturnValue([validSub]);
    vi.mocked(webpush.sendNotification).mockImplementation(async () => {
      const err = new Error("Service Unavailable") as Error & {
        statusCode: number;
      };
      err.statusCode = 503;
      throw err;
    });
    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { evicted: number };
    expect(body.evicted).toBe(0);
    expect(removeSubscription).not.toHaveBeenCalled();
  });

  it("forwarded payload includes computed approveUrl/rejectUrl from bridgeCallbackBase", async () => {
    await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(webpush.sendNotification).toHaveBeenCalledOnce();
    const [, payloadStr] = vi.mocked(webpush.sendNotification).mock.calls[0]!;
    const payload = JSON.parse(payloadStr as string) as {
      approveUrl: string;
      rejectUrl: string;
      approvalToken: string;
      callId: string;
    };
    expect(payload.approveUrl).toBe("https://bridge.example.com/approve/call-123");
    expect(payload.rejectUrl).toBe("https://bridge.example.com/reject/call-123");
    expect(payload.approvalToken).toBe(validBody.approvalToken);
    expect(payload.callId).toBe(validBody.callId);
  });

  it("trailing slash on bridgeCallbackBase does not produce //approve/...", async () => {
    await POST(
      req(
        { authorization: `Bearer ${TOKEN}` },
        { ...validBody, bridgeCallbackBase: "https://bridge.example.com/" },
      ),
    );
    const [, payloadStr] = vi.mocked(webpush.sendNotification).mock.calls[0]!;
    const payload = JSON.parse(payloadStr as string) as { approveUrl: string };
    expect(payload.approveUrl).toBe("https://bridge.example.com/approve/call-123");
  });
});

// ─── per-subscription `approvals` opt-out — audit 2026-06-02 ────────────────
// Pre-fix the approval relay fanned out via the unfiltered getSubscriptions(),
// so a subscription that set approvals:false (persisted by /api/push/prefs)
// still received every approval push. The halt relay already filtered via
// getSubscriptionsFor("halts"); this asserts the approval relay does the same
// with the "approvals" event class.
describe("POST /api/relay/push — respects approvals opt-out", () => {
  it("filters via getSubscriptionsFor('approvals'), not the unfiltered getSubscriptions()", async () => {
    await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(getSubscriptionsFor).toHaveBeenCalledWith("approvals");
    expect(getSubscriptions).not.toHaveBeenCalled();
  });

  it("excludes a subscription with approvals:false from the recipient set", async () => {
    const optedIn = validSub;
    const optedOut = {
      endpoint: "https://opted-out.example.com/p",
      keys: { p256dh: "k1", auth: "k2" },
    };
    // getSubscriptionsFor('approvals') is the store-level filter: it only
    // returns the opted-in subscription. The opted-out one must never be
    // sent to.
    vi.mocked(getSubscriptionsFor).mockImplementation((kind) =>
      kind === "approvals" ? [optedIn] : [optedIn, optedOut],
    );

    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(r.status).toBe(200);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    const sentEndpoints = vi
      .mocked(webpush.sendNotification)
      .mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint);
    expect(sentEndpoints).toEqual([optedIn.endpoint]);
    expect(sentEndpoints).not.toContain(optedOut.endpoint);
  });

  it("404 'no approval subscribers' when no subscription opted in to approvals", async () => {
    vi.mocked(getSubscriptionsFor).mockReturnValue([]);
    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string; total: number };
    expect(body.error).toMatch(/approval subscribers/i);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});

describe("POST /api/relay/push — cancel (dismiss a stale approval card)", () => {
  it("fans out a { kind: 'cancel', callId } payload without requiring approve/reject fields", async () => {
    const r = await POST(
      req({ authorization: `Bearer ${TOKEN}` }, { kind: "cancel", callId: "call-123" }),
    );
    expect(r.status).toBe(200);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    const [, payloadStr] = vi.mocked(webpush.sendNotification).mock.calls[0]!;
    expect(JSON.parse(payloadStr as string)).toEqual({
      kind: "cancel",
      callId: "call-123",
    });
  });

  it("400s a cancel payload missing callId", async () => {
    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, { kind: "cancel" }));
    expect(r.status).toBe(400);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("404s a cancel payload when no subscriber is opted in to approvals", async () => {
    vi.mocked(getSubscriptionsFor).mockReturnValue([]);
    const r = await POST(
      req({ authorization: `Bearer ${TOKEN}` }, { kind: "cancel", callId: "call-123" }),
    );
    expect(r.status).toBe(404);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("still enforces Bearer auth for cancel payloads", async () => {
    const r = await POST(req({}, { kind: "cancel", callId: "call-123" }));
    expect(r.status).toBe(401);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});
