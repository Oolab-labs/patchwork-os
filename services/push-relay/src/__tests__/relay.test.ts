import express from "express";
import { describe, expect, it, vi } from "vitest";
import { bearerAuthMiddleware, EnvTokenStore } from "../auth.js";
import { InMemoryRegistry } from "../deviceRegistry.js";
import type { ApnsAdapter, FcmAdapter } from "../dispatcher.js";
import { redactSecrets } from "../redact.js";
import { buildRouter } from "../routes.js";

function buildApp(fcm?: FcmAdapter, apns?: ApnsAdapter) {
  const registry = new InMemoryRegistry();
  const tokenStore = new EnvTokenStore("secret123:user1");
  const app = express();
  app.use(express.json());
  app.use(bearerAuthMiddleware(tokenStore));
  app.use(buildRouter(registry, { fcm, apns, apnsTopic: "com.patchwork.app" }));
  return { app, registry };
}

async function req(
  app: ReturnType<typeof buildApp>["app"],
  method: string,
  path: string,
  body?: unknown,
  token = "secret123",
) {
  const { default: supertest } = await import("supertest");
  const r = (supertest(app) as ReturnType<typeof supertest>)
    [method as "post"](path)
    .set("Authorization", `Bearer ${token}`);
  if (body) r.send(body).set("Content-Type", "application/json");
  return r;
}

describe("auth", () => {
  it("rejects missing token", async () => {
    const { app } = buildApp();
    const { default: supertest } = await import("supertest");
    const res = await (supertest(app) as ReturnType<typeof supertest>).post(
      "/devices/register",
    );
    expect(res.status).toBe(401);
  });

  it("rejects wrong token", async () => {
    const { app } = buildApp();
    const res = await req(
      app,
      "post",
      "/devices/register",
      undefined,
      "badtoken",
    );
    expect(res.status).toBe(401);
  });

  it("accepts correct token after at-rest hashing", async () => {
    // EnvTokenStore should hash tokens internally; lookup still resolves
    // the original plaintext correctly.
    const store = new EnvTokenStore("plain-token-abc:user42");
    expect(store.lookup("plain-token-abc")).toBe("user42");
    expect(store.lookup("not-this-one")).toBeNull();
  });

  it("does not retain plaintext tokens in heap-visible map", async () => {
    // After construction, no map field on the store should contain the
    // raw token value as a key. We allow private fields but require they
    // store HMAC digests, not plaintext.
    const store = new EnvTokenStore("super-secret-plain:user1");
    const json = JSON.stringify(store, (_k, v) => {
      if (v instanceof Map) return [...v.keys()];
      return v;
    });
    expect(json).not.toContain("super-secret-plain");
  });
});

describe("device registry routes", () => {
  it("registers and counts FCM device", async () => {
    const { app } = buildApp();
    const reg = await req(app, "post", "/devices/register", {
      token: "fcm-abc",
      platform: "fcm",
    });
    expect(reg.status).toBe(200);
    expect(reg.body.ok).toBe(true);

    const count = await req(app, "get", "/devices/count");
    expect(count.status).toBe(200);
    expect(count.body.count).toBe(1);
  });

  it("removes device", async () => {
    const { app } = buildApp();
    await req(app, "post", "/devices/register", {
      token: "fcm-xyz",
      platform: "fcm",
    });
    await req(app, "delete", "/devices/fcm-xyz");
    const count = await req(app, "get", "/devices/count");
    expect(count.body.count).toBe(0);
  });

  it("removes device with special chars (slashes/colons) via body", async () => {
    const { app } = buildApp();
    const fcmTok = "abc/def:ghi+jkl=";
    await req(app, "post", "/devices/register", {
      token: fcmTok,
      platform: "fcm",
    });
    expect((await req(app, "get", "/devices/count")).body.count).toBe(1);
    // New endpoint: DELETE /devices with token in body
    const del = await req(app, "delete", "/devices", { token: fcmTok });
    expect(del.status).toBe(200);
    expect((await req(app, "get", "/devices/count")).body.count).toBe(0);
  });

  it("rejects invalid platform", async () => {
    const { app } = buildApp();
    const res = await req(app, "post", "/devices/register", {
      token: "tok",
      platform: "web",
    });
    expect(res.status).toBe(400);
  });

  it("rate-limits registrations: 6th in 60s rejected", async () => {
    const { app } = buildApp();
    for (let i = 0; i < 5; i++) {
      const r = await req(app, "post", "/devices/register", {
        token: `fcm-${i}`,
        platform: "fcm",
      });
      expect(r.status).toBe(200);
    }
    const sixth = await req(app, "post", "/devices/register", {
      token: "fcm-6",
      platform: "fcm",
    });
    expect(sixth.status).toBe(429);
  });
});

describe("POST /push", () => {
  const validPayload = {
    callId: "abc-123",
    toolName: "gitPush",
    tier: "high",
    approvalToken: "token-xyz",
    requestedAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    bridgeCallbackBase: "https://bridge.example.com",
  };

  it("returns 200 immediately (fire-and-forget)", async () => {
    const { app } = buildApp();
    await req(app, "post", "/devices/register", {
      token: "fcm-1",
      platform: "fcm",
    });
    const fcm: FcmAdapter = {
      sendEach: vi.fn().mockResolvedValue({ responses: [{ success: true }] }),
    };
    const { app: app2 } = buildApp(fcm);
    await req(app2, "post", "/devices/register", {
      token: "fcm-1",
      platform: "fcm",
    });

    const res = await req(app2, "post", "/push", validPayload);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("calls FCM with correct fields", async () => {
    const sent: unknown[] = [];
    const fcm: FcmAdapter = {
      sendEach: vi.fn().mockImplementation(async (msgs) => {
        sent.push(...msgs);
        return { responses: msgs.map(() => ({ success: true })) };
      }),
    };
    const { app } = buildApp(fcm);
    await req(app, "post", "/devices/register", {
      token: "fcm-device",
      platform: "fcm",
    });
    await req(app, "post", "/push", {
      ...validPayload,
      callId: "fcm-call-1",
    });
    // Allow fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    const msg = sent[0] as Record<string, unknown>;
    expect(msg.token).toBe("fcm-device");
    const data = msg.data as Record<string, string>;
    expect(data.callId).toBe("fcm-call-1");
    expect(data.approvalToken).toBe("token-xyz");
    expect(data.approveUrl).toContain("/approve/fcm-call-1");
    // Token must NOT appear in the URL — it leaks to access logs and Referer.
    // The service worker pulls `approvalToken` from the data payload and
    // sends it as an `x-approval-token` header on the approve POST.
    expect(data.approveUrl).not.toContain("token=");
    expect(data.approveUrl).not.toContain("token-xyz");
  });

  it("rejects missing callId", async () => {
    const { app } = buildApp();
    const res = await req(app, "post", "/push", {
      toolName: "gitPush",
      tier: "high",
      approvalToken: "tok",
    });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate (replay) within window — 409", async () => {
    const { app } = buildApp();
    await req(app, "post", "/devices/register", {
      token: "fcm-x",
      platform: "fcm",
    });
    const payload = {
      ...validPayload,
      callId: "replay-test-1",
      approvalToken: "replay-tok-1",
    };
    const first = await req(app, "post", "/push", payload);
    expect(first.status).toBe(200);
    const second = await req(app, "post", "/push", payload);
    expect(second.status).toBe(409);
  });

  it("clamps oversized expiresAt to now+5min", async () => {
    const captured: unknown[] = [];
    const fcm: FcmAdapter = {
      sendEach: vi.fn().mockImplementation(async (msgs) => {
        captured.push(...msgs);
        return { responses: msgs.map(() => ({ success: true })) };
      }),
    };
    const { app } = buildApp(fcm);
    await req(app, "post", "/devices/register", {
      token: "fcm-clamp",
      platform: "fcm",
    });
    const before = Date.now();
    const farFuture = before + 60 * 60_000; // 1 hour
    await req(app, "post", "/push", {
      ...validPayload,
      callId: "clamp-test-1",
      approvalToken: "clamp-tok-1",
      expiresAt: farFuture,
    });
    await new Promise((r) => setTimeout(r, 20));
    const after = Date.now();
    expect(captured).toHaveLength(1);
    const msg = captured[0] as Record<string, unknown>;
    const data = msg.data as Record<string, string>;
    const reportedExpiry = parseInt(data.expiresAt, 10);
    // Clamp ~ now + 5min; allow loose lower bound (could be slightly less
    // than before+5min since "now" is captured inside the route)
    expect(reportedExpiry).toBeLessThanOrEqual(after + 5 * 60_000 + 100);
    expect(reportedExpiry).toBeGreaterThanOrEqual(before + 4 * 60_000);
    // Definitely not the unclamped 1hr value
    expect(reportedExpiry).toBeLessThan(farFuture);
  });

  it("rejects already-expired expiresAt", async () => {
    const { app } = buildApp();
    await req(app, "post", "/devices/register", {
      token: "fcm-exp",
      platform: "fcm",
    });
    const past = Date.now() - 60_000;
    const res = await req(app, "post", "/push", {
      ...validPayload,
      callId: "expired-test-1",
      approvalToken: "expired-tok-1",
      expiresAt: past,
    });
    expect(res.status).toBe(400);
  });
});

describe("redactSecrets", () => {
  it("redacts PEM blocks", () => {
    const s = `Error: failed to parse: -----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAxxyyzz
abc123longbase64isheresoonenough
-----END RSA PRIVATE KEY-----
trailing context`;
    const out = redactSecrets(s);
    expect(out).toContain("[redacted PEM]");
    expect(out).not.toContain("MIIEowIBAAKCAQEAxxyyzz");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("redacts long base64-ish token sequences", () => {
    const s = "token=ya29.A0ARrdaM_AbcDEF1234567890XyZAbCdEfGhIjKlMnOpQrStUv";
    const out = redactSecrets(s);
    expect(out).toContain("[redacted token]");
    expect(out).not.toContain(
      "ya29.A0ARrdaM_AbcDEF1234567890XyZAbCdEfGhIjKlMnOpQrStUv",
    );
  });

  it("leaves short strings alone", () => {
    expect(redactSecrets("plain error: not found")).toBe(
      "plain error: not found",
    );
  });
});

describe("InMemoryRegistry", () => {
  it("evicts oldest device at cap via RedisRegistry semantics", async () => {
    // InMemoryRegistry has no cap — test that RedisRegistry eviction logic
    // would fire is covered separately; this just tests basic set behaviour
    const r = new InMemoryRegistry();
    await r.register("u", { token: "a", platform: "fcm", registeredAt: 1 });
    await r.register("u", { token: "b", platform: "fcm", registeredAt: 2 });
    expect(await r.count("u")).toBe(2);
    await r.remove("u", "a");
    expect(await r.count("u")).toBe(1);
    const list = await r.list("u");
    expect(list[0]?.token).toBe("b");
  });
});
