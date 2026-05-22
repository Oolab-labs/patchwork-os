import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("shopify token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-shopify-${Date.now()}`);
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
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.SHOPIFY_ACCESS_TOKEN;
    delete process.env.SHOPIFY_SHOP_DOMAIN;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns env vars when both set, without reading storage", async () => {
    process.env.SHOPIFY_ACCESS_TOKEN = "shpat_envtoken";
    process.env.SHOPIFY_SHOP_DOMAIN = "envshop.myshopify.com";
    const { loadTokens } = await import("../shopify.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.accessToken).toBe("shpat_envtoken");
    expect(tokens!.shopDomain).toBe("envshop.myshopify.com");
  });

  it("loadTokens ignores env if only one of token/domain set", async () => {
    process.env.SHOPIFY_ACCESS_TOKEN = "shpat_only";
    const { loadTokens } = await import("../shopify.js");
    expect(loadTokens()).toBeNull();
  });

  it("loadTokens returns null when no env and no stored token", async () => {
    const { loadTokens } = await import("../shopify.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../shopify.js");
    const tokens = {
      accessToken: "shpat_roundtrip",
      shopDomain: "acme.myshopify.com",
      shopName: "Acme",
      planName: "shopify_plus",
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      accessToken: "shpat_roundtrip",
      shopDomain: "acme.myshopify.com",
      shopName: "Acme",
      planName: "shopify_plus",
    });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../shopify.js");
    expect(() => clearTokens()).not.toThrow();
  });
});

describe("isValidShopDomain", () => {
  it("accepts canonical *.myshopify.com domains", async () => {
    const { isValidShopDomain } = await import("../shopify.js");
    expect(isValidShopDomain("acme-store.myshopify.com")).toBe(true);
    expect(isValidShopDomain("shop123.myshopify.com")).toBe(true);
  });

  it("rejects obviously malformed inputs", async () => {
    const { isValidShopDomain } = await import("../shopify.js");
    expect(isValidShopDomain("example.com")).toBe(false);
    expect(isValidShopDomain(".myshopify.com")).toBe(false);
    expect(isValidShopDomain("shop.shopify.com")).toBe(false);
    expect(isValidShopDomain("UPPER.myshopify.com")).toBe(false);
    expect(isValidShopDomain("")).toBe(false);
    expect(isValidShopDomain("-bad.myshopify.com")).toBe(false);
  });
});

describe("ShopifyConnector.normalizeError", () => {
  it("maps HTTP statuses to ConnectorError codes", async () => {
    vi.resetModules();
    const { ShopifyConnector } = await import("../shopify.js");
    const conn = new ShopifyConnector();
    const mk = (status: number) => new Response("", { status });

    expect(conn.normalizeError(mk(401)).code).toBe("auth_expired");
    const e402 = conn.normalizeError(mk(402));
    expect(e402.code).toBe("provider_error");
    expect(e402.message.toLowerCase()).toContain("frozen");
    expect(conn.normalizeError(mk(403)).code).toBe("permission_denied");
    expect(conn.normalizeError(mk(404)).code).toBe("not_found");
    const e423 = conn.normalizeError(mk(423));
    expect(e423.code).toBe("provider_error");
    expect(e423.message.toLowerCase()).toContain("locked");
    const e429 = conn.normalizeError(mk(429));
    expect(e429.code).toBe("rate_limited");
    expect(e429.retryable).toBe(true);
    const e500 = conn.normalizeError(mk(500));
    expect(e500.code).toBe("provider_error");
    expect(e500.retryable).toBe(true);
  });

  it("maps network errors to network_error", async () => {
    vi.resetModules();
    const { ShopifyConnector } = await import("../shopify.js");
    const conn = new ShopifyConnector();
    const err = new Error("ENOTFOUND acme.myshopify.com");
    const out = conn.normalizeError(err);
    expect(out.code).toBe("network_error");
    expect(out.retryable).toBe(true);
  });
});

describe("ShopifyConnector.healthCheck", () => {
  it("returns ok:true when API responds 200", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ shop: { id: 1, name: "Acme" } }),
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { ShopifyConnector } = await import("../shopify.js");
    const conn = new ShopifyConnector();
    (conn as unknown as { tokens: object }).tokens = {
      accessToken: "shpat_ok",
      shopDomain: "acme.myshopify.com",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "shpat_ok", scopes: [] });

    const result = await conn.healthCheck();
    expect(result.ok).toBe(true);
  });

  it("returns ok:false when API responds 401", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { ShopifyConnector } = await import("../shopify.js");
    const conn = new ShopifyConnector();
    (conn as unknown as { tokens: object }).tokens = {
      accessToken: "shpat_bad",
      shopDomain: "acme.myshopify.com",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "shpat_bad", scopes: [] });

    const result = await conn.healthCheck();
    expect(result.ok).toBe(false);
  });
});

describe("ShopifyConnector list/get methods", () => {
  function makeConn() {
    return import("../shopify.js").then(({ ShopifyConnector }) => {
      const conn = new ShopifyConnector();
      (conn as unknown as { tokens: object }).tokens = {
        accessToken: "shpat_x",
        shopDomain: "acme.myshopify.com",
        connected_at: new Date().toISOString(),
      };
      vi.spyOn(
        conn as unknown as {
          authenticate: () => Promise<{ token: string; scopes: string[] }>;
        },
        "authenticate",
      ).mockResolvedValue({ token: "shpat_x", scopes: [] });
      return conn;
    });
  }

  beforeEach(() => {
    vi.resetModules();
  });

  it("listProducts caps limit at 250 (Shopify hard limit)", async () => {
    const mock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ products: [] }),
      headers: { get: () => null },
    });
    global.fetch = mock as unknown as typeof fetch;

    const conn = await makeConn();
    await conn.listProducts({ limit: 9999 });

    const call = mock.mock.calls[0] as unknown as [string, RequestInit];
    const url = call[0];
    expect(url).toContain("limit=250");
    expect(url).not.toContain("limit=9999");
  });

  it("listProducts passes vendor + status + product_type", async () => {
    const mock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ products: [] }),
      headers: { get: () => null },
    });
    global.fetch = mock as unknown as typeof fetch;

    const conn = await makeConn();
    await conn.listProducts({
      limit: 25,
      status: "active",
      vendor: "Acme",
      productType: "Widget",
    });

    const call = mock.mock.calls[0] as unknown as [string, RequestInit];
    const url = call[0];
    expect(url).toContain("limit=25");
    expect(url).toContain("status=active");
    expect(url).toContain("vendor=Acme");
    expect(url).toContain("product_type=Widget");
  });

  it("listOrders defaults status=any and caps limit", async () => {
    const mock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ orders: [] }),
      headers: { get: () => null },
    });
    global.fetch = mock as unknown as typeof fetch;

    const conn = await makeConn();
    await conn.listOrders({ limit: 1000 });

    const call = mock.mock.calls[0] as unknown as [string, RequestInit];
    const url = call[0];
    expect(url).toContain("status=any");
    expect(url).toContain("limit=250");
  });

  it("listOrders allows overriding status + financial/fulfillment", async () => {
    const mock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ orders: [] }),
      headers: { get: () => null },
    });
    global.fetch = mock as unknown as typeof fetch;

    const conn = await makeConn();
    await conn.listOrders({
      status: "open",
      financialStatus: "paid",
      fulfillmentStatus: "shipped",
    });

    const call = mock.mock.calls[0] as unknown as [string, RequestInit];
    const url = call[0];
    expect(url).toContain("status=open");
    expect(url).toContain("financial_status=paid");
    expect(url).toContain("fulfillment_status=shipped");
  });

  it("listCustomers without query hits /customers.json", async () => {
    const mock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ customers: [] }),
      headers: { get: () => null },
    });
    global.fetch = mock as unknown as typeof fetch;

    const conn = await makeConn();
    await conn.listCustomers({});

    const call = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("/customers.json");
    expect(call[0]).not.toContain("/customers/search.json");
  });

  it("listCustomers with query hits /customers/search.json", async () => {
    const mock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ customers: [] }),
      headers: { get: () => null },
    });
    global.fetch = mock as unknown as typeof fetch;

    const conn = await makeConn();
    await conn.listCustomers({ query: "email:foo@bar.com" });

    const call = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("/customers/search.json");
    expect(call[0]).toContain("query=email");
  });

  it("listInventoryLevels uses location_ids + caps limit", async () => {
    const mock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ inventory_levels: [] }),
      headers: { get: () => null },
    });
    global.fetch = mock as unknown as typeof fetch;

    const conn = await makeConn();
    await conn.listInventoryLevels(12345, { limit: 500 });

    const call = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("location_ids=12345");
    expect(call[0]).toContain("limit=250");
  });

  it("buildHeaders sends X-Shopify-Access-Token", async () => {
    const mock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ shop: { id: 1, name: "A" } }),
      headers: { get: () => null },
    });
    global.fetch = mock as unknown as typeof fetch;

    const conn = await makeConn();
    await conn.getShop();

    const call = mock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = (call[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["X-Shopify-Access-Token"]).toBe("shpat_x");
  });
});

describe("handleShopifyConnect", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns 400 when accessToken missing", async () => {
    const { handleShopifyConnect } = await import("../shopify.js");
    const result = await handleShopifyConnect(
      JSON.stringify({ shopDomain: "acme.myshopify.com" }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 when shopDomain missing", async () => {
    const { handleShopifyConnect } = await import("../shopify.js");
    const result = await handleShopifyConnect(
      JSON.stringify({ accessToken: "shpat_x" }),
    );
    expect(result.status).toBe(400);
  });

  it("returns 400 on malformed shopDomain", async () => {
    const { handleShopifyConnect } = await import("../shopify.js");
    const result = await handleShopifyConnect(
      JSON.stringify({
        accessToken: "shpat_x",
        shopDomain: "not-a-shopify-domain.com",
      }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toContain("shopDomain");
  });

  it("returns 400 on invalid JSON", async () => {
    const { handleShopifyConnect } = await import("../shopify.js");
    const result = await handleShopifyConnect("not-json");
    expect(result.status).toBe(400);
  });

  it("returns 401 when Shopify rejects credentials", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    const { handleShopifyConnect } = await import("../shopify.js");
    const result = await handleShopifyConnect(
      JSON.stringify({
        accessToken: "shpat_bad",
        shopDomain: "acme.myshopify.com",
      }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 when myshopify_domain mismatch", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        shop: {
          id: 1,
          name: "Other",
          myshopify_domain: "other.myshopify.com",
        },
      }),
    }) as unknown as typeof fetch;

    const { handleShopifyConnect } = await import("../shopify.js");
    const result = await handleShopifyConnect(
      JSON.stringify({
        accessToken: "shpat_x",
        shopDomain: "acme.myshopify.com",
      }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toContain("mismatch");
  });

  it("returns 200 and stores shopName + planName on success", async () => {
    const tmpDir2 = join(
      os.tmpdir(),
      `patchwork-shopify-connect-${Date.now()}`,
    );
    const pHome = join(tmpDir2, ".patchwork");
    mkdirSync(join(pHome, "tokens"), { recursive: true });
    process.env.PATCHWORK_HOME = pHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        shop: {
          id: 42,
          name: "Acme Co",
          plan_name: "shopify_plus",
          myshopify_domain: "acme.myshopify.com",
        },
      }),
    }) as unknown as typeof fetch;

    const { handleShopifyConnect, loadTokens } = await import("../shopify.js");
    const result = await handleShopifyConnect(
      JSON.stringify({
        accessToken: "shpat_good",
        shopDomain: "acme.myshopify.com",
      }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.shopName).toBe("Acme Co");
    expect(body.planName).toBe("shopify_plus");
    expect(body.shopDomain).toBe("acme.myshopify.com");

    const stored = loadTokens();
    expect(stored?.accessToken).toBe("shpat_good");
    expect(stored?.shopName).toBe("Acme Co");
    expect(stored?.planName).toBe("shopify_plus");

    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("handleShopifyTest", () => {
  it("returns 400 when not connected", async () => {
    vi.resetModules();
    const { handleShopifyTest } = await import("../shopify.js");
    const result = await handleShopifyTest();
    expect(result.status).toBe(400);
  });
});

describe("handleShopifyDisconnect", () => {
  it("returns 200 always", async () => {
    vi.resetModules();
    const { handleShopifyDisconnect } = await import("../shopify.js");
    const result = handleShopifyDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
