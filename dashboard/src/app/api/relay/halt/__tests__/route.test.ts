/**
 * Tests for the bridge → dashboard halt-event relay
 * (`POST /api/relay/halt`). Sibling of /api/relay/push; same auth and
 * fan-out shape, different payload + the consumer set is filtered by
 * `pushStore.getSubscriptionsFor("halts")`.
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
  getSubscriptionsFor: vi.fn(() => []),
  removeSubscription: vi.fn(),
}));

import webpush from "web-push";
import { POST } from "@/app/api/relay/halt/route";
import { getSubscriptionsFor, removeSubscription } from "@/lib/pushStore";

const TOKEN = "relay-test-token-1234567890abcdef";

const validSub = {
  endpoint: "https://example.com/push/abc",
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
};

const validBody = {
  recipeName: "morning-brief",
  runSeq: 42,
  status: "halted" as const,
  haltReason: "Agent step 'summarize' returned only narration",
  haltCategory: "agent_narration_only",
  stepId: "summarize",
};

function req(headers: Record<string, string>, body: unknown): NextRequest {
  return new NextRequest("http://localhost:3200/api/relay/halt", {
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
  originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.PATCHWORK_PUSH_TOKEN = TOKEN;
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "test-vapid-public";
  process.env.VAPID_PRIVATE_KEY = "test-vapid-private";
  process.env.VAPID_SUBJECT = "mailto:test@example.com";
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

describe("POST /api/relay/halt", () => {
  it("401 without Bearer token", async () => {
    const r = await POST(req({}, validBody));
    expect(r.status).toBe(401);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("401 with wrong Bearer token", async () => {
    const r = await POST(req({ authorization: "Bearer wrong" }, validBody));
    expect(r.status).toBe(401);
  });

  // auth-bypass regression — audit 2026-06-08 HIGH (dash-api-1). See the push
  // relay test for the full description of the all-zeros-collision bug.
  it("401 when a wrong >256-byte token of equal length is presented", async () => {
    process.env.PATCHWORK_PUSH_TOKEN = "A".repeat(300);
    const r = await POST(
      req({ authorization: `Bearer ${"B".repeat(300)}` }, validBody),
    );
    expect(r.status).toBe(401);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("503 when VAPID keys are unset", async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(r.status).toBe(503);
  });

  it("400 on missing recipeName / runSeq / status", async () => {
    const r = await POST(
      req({ authorization: `Bearer ${TOKEN}` }, {
        ...validBody,
        recipeName: undefined,
      }),
    );
    expect(r.status).toBe(400);
  });

  it("400 on invalid status value", async () => {
    const r = await POST(
      req({ authorization: `Bearer ${TOKEN}` }, {
        ...validBody,
        status: "running",
      }),
    );
    expect(r.status).toBe(400);
  });

  it("404 when no halt-opted-in subscriptions exist", async () => {
    vi.mocked(getSubscriptionsFor).mockReturnValueOnce([]);
    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(r.status).toBe(404);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("fans out to halt-opted-in subscriptions and returns count", async () => {
    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; sent: number; total: number };
    expect(body).toEqual({ ok: true, sent: 1, total: 1, evicted: 0 });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    // Payload shape: kind="halt" + run + step
    const payload = JSON.parse(
      vi.mocked(webpush.sendNotification).mock.calls[0]![1] as string,
    );
    expect(payload).toMatchObject({
      kind: "halt",
      recipeName: "morning-brief",
      runSeq: 42,
      status: "halted",
      stepId: "summarize",
    });
  });

  it("evicts subscriptions that respond 404 / 410", async () => {
    const dead410 = { ...validSub, endpoint: "https://dead.example/410" };
    vi.mocked(getSubscriptionsFor).mockReturnValueOnce([validSub, dead410]);
    // Cast to the web-push impl signature loosely — the real lib returns
    // a SendResult shape, but we only care about success vs the
    // 404/410-shaped thrown error eviction path.
    vi.mocked(webpush.sendNotification).mockImplementation((async (
      sub: { endpoint: string },
    ) => {
      if (sub.endpoint.endsWith("/410")) {
        throw { statusCode: 410 };
      }
      return { statusCode: 201 };
    }) as unknown as typeof webpush.sendNotification);
    const r = await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    const body = (await r.json()) as { sent: number; evicted: number };
    expect(body.sent).toBe(1);
    expect(body.evicted).toBe(1);
    expect(removeSubscription).toHaveBeenCalledWith(dead410.endpoint);
  });

  it("only consults halt-opted-in subscriptions (separate from approval set)", async () => {
    await POST(req({ authorization: `Bearer ${TOKEN}` }, validBody));
    expect(getSubscriptionsFor).toHaveBeenCalledWith("halts");
  });
});
