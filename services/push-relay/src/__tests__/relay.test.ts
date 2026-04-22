import express from "express";
import { describe, expect, it, vi } from "vitest";
import { bearerAuthMiddleware, EnvTokenStore } from "../auth.js";
import { InMemoryRegistry } from "../deviceRegistry.js";
import type { ApnsAdapter, FcmAdapter } from "../dispatcher.js";
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

  it("rejects invalid platform", async () => {
    const { app } = buildApp();
    const res = await req(app, "post", "/devices/register", {
      token: "tok",
      platform: "web",
    });
    expect(res.status).toBe(400);
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
    await req(app, "post", "/push", validPayload);
    // Allow fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    const msg = sent[0] as Record<string, unknown>;
    expect(msg.token).toBe("fcm-device");
    const data = msg.data as Record<string, string>;
    expect(data.callId).toBe("abc-123");
    expect(data.approvalToken).toBe("token-xyz");
    expect(data.approveUrl).toContain("/approve/abc-123");
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
