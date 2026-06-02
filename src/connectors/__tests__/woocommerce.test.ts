import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("woocommerce token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-woo-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.WOOCOMMERCE_CONSUMER_KEY;
    delete process.env.WOOCOMMERCE_CONSUMER_SECRET;
    delete process.env.WOOCOMMERCE_STORE_URL;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns env vars without reading storage", async () => {
    process.env.WOOCOMMERCE_CONSUMER_KEY = "ck_test123";
    process.env.WOOCOMMERCE_CONSUMER_SECRET = "cs_secret456";
    process.env.WOOCOMMERCE_STORE_URL = "https://mystore.example.com";
    const { loadTokens } = await import("../woocommerce.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.consumerKey).toBe("ck_test123");
    expect(tokens!.consumerSecret).toBe("cs_secret456");
    expect(tokens!.storeUrl).toBe("https://mystore.example.com");
  });

  it("loadTokens strips trailing slash from WOOCOMMERCE_STORE_URL", async () => {
    process.env.WOOCOMMERCE_CONSUMER_KEY = "ck_test";
    process.env.WOOCOMMERCE_CONSUMER_SECRET = "cs_test";
    process.env.WOOCOMMERCE_STORE_URL = "https://mystore.example.com/";
    const { loadTokens } = await import("../woocommerce.js");
    const tokens = loadTokens();
    expect(tokens!.storeUrl).toBe("https://mystore.example.com");
  });

  it("loadTokens returns null when no env vars and no stored token", async () => {
    const { loadTokens } = await import("../woocommerce.js");
    expect(loadTokens()).toBeNull();
  });

  it("loadTokens returns null when only some env vars are set", async () => {
    process.env.WOOCOMMERCE_CONSUMER_KEY = "ck_test";
    // missing secret + storeUrl
    const { loadTokens } = await import("../woocommerce.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../woocommerce.js");
    const tokens = {
      consumerKey: "ck_roundtrip",
      consumerSecret: "cs_roundtrip",
      storeUrl: "https://shop.example.com",
      connected_at: "2026-05-31T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      consumerKey: "ck_roundtrip",
      consumerSecret: "cs_roundtrip",
      storeUrl: "https://shop.example.com",
    });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../woocommerce.js");
    expect(() => clearTokens()).not.toThrow();
  });
});

describe("verifyWooCommerceWebhook", () => {
  it("returns true for a valid signature", async () => {
    const { verifyWooCommerceWebhook } = await import("../woocommerce.js");
    const { createHmac } = await import("node:crypto");
    const secret = "my_webhook_secret";
    const body = JSON.stringify({ id: 42, status: "processing" });
    const sig = createHmac("sha256", secret).update(body).digest("base64");
    expect(verifyWooCommerceWebhook(body, sig, secret)).toBe(true);
  });

  it("returns false for a tampered body", async () => {
    const { verifyWooCommerceWebhook } = await import("../woocommerce.js");
    const { createHmac } = await import("node:crypto");
    const secret = "my_webhook_secret";
    const originalBody = JSON.stringify({ id: 42, status: "processing" });
    const tamperedBody = JSON.stringify({ id: 42, status: "completed" });
    const sig = createHmac("sha256", secret)
      .update(originalBody)
      .digest("base64");
    expect(verifyWooCommerceWebhook(tamperedBody, sig, secret)).toBe(false);
  });

  it("returns false for wrong secret", async () => {
    const { verifyWooCommerceWebhook } = await import("../woocommerce.js");
    const { createHmac } = await import("node:crypto");
    const body = JSON.stringify({ id: 1 });
    const sig = createHmac("sha256", "correct_secret")
      .update(body)
      .digest("base64");
    expect(verifyWooCommerceWebhook(body, sig, "wrong_secret")).toBe(false);
  });

  it("returns false for empty signature", async () => {
    const { verifyWooCommerceWebhook } = await import("../woocommerce.js");
    expect(verifyWooCommerceWebhook('{"id":1}', "", "secret")).toBe(false);
  });

  it("accepts Buffer as rawBody", async () => {
    const { verifyWooCommerceWebhook } = await import("../woocommerce.js");
    const { createHmac } = await import("node:crypto");
    const secret = "buf_secret";
    const body = Buffer.from('{"id":99}');
    const sig = createHmac("sha256", secret).update(body).digest("base64");
    expect(verifyWooCommerceWebhook(body, sig, secret)).toBe(true);
  });
});

describe("WooCommerceConnector.getOrders", () => {
  it("calls GET /orders and returns array", async () => {
    const fakeOrders = [
      {
        id: 1,
        status: "processing",
        currency: "USD",
        date_created: "2026-05-01T00:00:00",
        total: "99.00",
        customer_id: 5,
        billing: {},
        shipping: {},
        line_items: [],
        payment_method: "stripe",
        payment_method_title: "Credit Card",
        transaction_id: "txn_1",
        customer_note: "",
      },
    ];

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => fakeOrders,
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { WooCommerceConnector } = await import("../woocommerce.js");
    const conn = new WooCommerceConnector();
    (conn as unknown as { tokens: object }).tokens = {
      consumerKey: "ck_test",
      consumerSecret: "cs_test",
      storeUrl: "https://shop.example.com",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "ck_test:cs_test" });

    const orders = await conn.getOrders({ status: "processing" });
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("processing");

    const url = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(url).toContain("/orders");
    expect(url).toContain("status=processing");
  });
});

describe("WooCommerceConnector.createWebhook", () => {
  it("POSTs to /webhooks with correct body", async () => {
    const fakeWebhook = {
      id: 10,
      name: "Order Created",
      status: "active",
      topic: "order.created",
      delivery_url: "https://receiver.example.com/hook",
      date_created: "2026-05-31T00:00:00",
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => fakeWebhook,
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { WooCommerceConnector } = await import("../woocommerce.js");
    const conn = new WooCommerceConnector();
    (conn as unknown as { tokens: object }).tokens = {
      consumerKey: "ck_test",
      consumerSecret: "cs_test",
      storeUrl: "https://shop.example.com",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "ck_test:cs_test" });

    const webhook = await conn.createWebhook(
      "Order Created",
      "order.created",
      "https://receiver.example.com/hook",
      "webhook_secret",
    );
    expect(webhook.id).toBe(10);
    expect(webhook.topic).toBe("order.created");

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toContain("/webhooks");
    expect(init.method).toBe("POST");
    const sentBody = JSON.parse(init.body as string) as Record<string, string>;
    expect(sentBody.name).toBe("Order Created");
    expect(sentBody.topic).toBe("order.created");
    expect(sentBody.delivery_url).toBe("https://receiver.example.com/hook");
    expect(sentBody.secret).toBe("webhook_secret");
  });
});

describe("handleWooCommerceConnect", () => {
  it("returns 400 when consumerKey is missing", async () => {
    vi.resetModules();
    const { handleWooCommerceConnect } = await import("../woocommerce.js");
    const result = await handleWooCommerceConnect(
      JSON.stringify({
        consumerSecret: "cs_test",
        storeUrl: "https://shop.example.com",
      }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 when consumerSecret is missing", async () => {
    vi.resetModules();
    const { handleWooCommerceConnect } = await import("../woocommerce.js");
    const result = await handleWooCommerceConnect(
      JSON.stringify({
        consumerKey: "ck_test",
        storeUrl: "https://shop.example.com",
      }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toContain("consumerSecret");
  });

  it("returns 400 when storeUrl is missing", async () => {
    vi.resetModules();
    const { handleWooCommerceConnect } = await import("../woocommerce.js");
    const result = await handleWooCommerceConnect(
      JSON.stringify({ consumerKey: "ck_test", consumerSecret: "cs_test" }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toContain("storeUrl");
  });

  it("returns 400 on invalid JSON", async () => {
    vi.resetModules();
    const { handleWooCommerceConnect } = await import("../woocommerce.js");
    const result = await handleWooCommerceConnect("not-json");
    expect(result.status).toBe(400);
  });

  it("returns 401 when store rejects credentials", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleWooCommerceConnect } = await import("../woocommerce.js");
    const result = await handleWooCommerceConnect(
      JSON.stringify({
        consumerKey: "ck_bad",
        consumerSecret: "cs_bad",
        storeUrl: "https://shop.example.com",
      }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 and stores tokens on success", async () => {
    const tmpDir2 = join(os.tmpdir(), `patchwork-woo-conn-${Date.now()}`);
    const homeDir2 = join(tmpDir2, "home");
    const patchworkHome2 = join(homeDir2, ".patchwork");
    const tokensDir2 = join(patchworkHome2, "tokens");
    mkdirSync(tokensDir2, { recursive: true });
    process.env.HOME = homeDir2;
    process.env.PATCHWORK_HOME = patchworkHome2;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ environment: { wc_version: "8.0.0" } }),
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleWooCommerceConnect } = await import("../woocommerce.js");
    const result = await handleWooCommerceConnect(
      JSON.stringify({
        consumerKey: "ck_live_abc",
        consumerSecret: "cs_live_xyz",
        storeUrl: "https://shop.example.com",
      }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as {
      ok: boolean;
      storeUrl: string;
      connectedAt: string;
    };
    expect(body.ok).toBe(true);
    expect(body.storeUrl).toBe("https://shop.example.com");
    expect(body.connectedAt).toBeTruthy();

    // Clean up
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("WooCommerceConnector.normalizeError", () => {
  it("maps 401 HTTP status to auth_expired", async () => {
    vi.resetModules();
    const { WooCommerceConnector } = await import("../woocommerce.js");
    const conn = new WooCommerceConnector();
    const err = conn.normalizeError({ status: 401, ok: false });
    expect(err.code).toBe("auth_expired");
    expect(err.retryable).toBe(false);
  });

  it("maps 429 to rate_limited", async () => {
    vi.resetModules();
    const { WooCommerceConnector } = await import("../woocommerce.js");
    const conn = new WooCommerceConnector();
    const err = conn.normalizeError({ status: 429, ok: false });
    expect(err.code).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });

  it("maps WooCommerce auth error code to auth_expired", async () => {
    vi.resetModules();
    const { WooCommerceConnector } = await import("../woocommerce.js");
    const conn = new WooCommerceConnector();
    const err = conn.normalizeError({
      code: "woocommerce_rest_authentication_error",
      message: "Consumer key is invalid",
      data: { status: 401 },
    });
    expect(err.code).toBe("auth_expired");
  });

  it("maps 404 to not_found", async () => {
    vi.resetModules();
    const { WooCommerceConnector } = await import("../woocommerce.js");
    const conn = new WooCommerceConnector();
    const err = conn.normalizeError({ status: 404, ok: false });
    expect(err.code).toBe("not_found");
  });

  it("maps ENOTFOUND to network_error", async () => {
    vi.resetModules();
    const { WooCommerceConnector } = await import("../woocommerce.js");
    const conn = new WooCommerceConnector();
    const networkErr = new Error("getaddrinfo ENOTFOUND shop.example.com");
    const err = conn.normalizeError(networkErr);
    expect(err.code).toBe("network_error");
    expect(err.retryable).toBe(true);
  });
});
