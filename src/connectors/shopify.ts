/**
 * Shopify connector — read-only access to Shopify Admin data via the Admin REST API 2024-07.
 *
 * Auth: header `X-Shopify-Access-Token: <token>` where tokens are per-shop Admin API
 *       access tokens generated via Shopify's "Custom App" feature (start with `shpat_`).
 *   - Env vars: SHOPIFY_ACCESS_TOKEN + SHOPIFY_SHOP_DOMAIN
 *   - Stored: getSecretJsonSync("shopify") → ShopifyTokens
 *
 * Tools: getShop, listProducts, getProduct, listOrders, getOrder,
 *        listCustomers, getCustomer, listInventoryLevels
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 */

import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
} from "./baseConnector.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

export interface ShopifyTokens {
  accessToken: string; // shpat_...
  shopDomain: string; // <shop>.myshopify.com
  shopName?: string;
  planName?: string;
  connected_at: string;
}

export interface ShopifyShop {
  id: number;
  name: string;
  email: string;
  domain: string;
  myshopify_domain: string;
  plan_name?: string;
  country_code?: string;
  currency?: string;
  timezone?: string;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string | null;
  vendor: string;
  product_type: string;
  status: string;
  created_at: string;
  updated_at: string;
  tags: string;
  variants?: unknown[];
}

export interface ShopifyOrder {
  id: number;
  order_number: number;
  name: string;
  email: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  total_price: string;
  subtotal_price: string;
  currency: string;
  created_at: string;
  updated_at: string;
  customer?: ShopifyCustomer | null;
}

export interface ShopifyCustomer {
  id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  orders_count?: number;
  total_spent?: string;
  state?: string;
  created_at: string;
  updated_at: string;
}

export interface ShopifyInventoryLevel {
  inventory_item_id: number;
  location_id: number;
  available: number | null;
  updated_at: string;
}

export interface ShopifyListResult<T> {
  data: T[];
}

const API_VERSION = "2024-07";
const SHOPIFY_HARD_LIMIT = 250;

function buildBaseUrl(shopDomain: string): string {
  return `https://${shopDomain}/admin/api/${API_VERSION}`;
}

/**
 * Best-effort validation of a Shopify shop domain. We accept anything that ends in
 * `.myshopify.com` and looks vaguely like a domain (lowercase letters, digits, hyphens,
 * at least one non-empty subdomain). This is a defense-in-depth check; the real
 * authority is the connect handler that validates against Shopify itself.
 */
export function isValidShopDomain(domain: string): boolean {
  if (typeof domain !== "string") return false;
  if (!domain.endsWith(".myshopify.com")) return false;
  const sub = domain.slice(0, -".myshopify.com".length);
  if (!sub) return false;
  return /^[a-z0-9][a-z0-9-]*$/.test(sub);
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || limit === null) return fallback;
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), SHOPIFY_HARD_LIMIT);
}

export class ShopifyConnector extends BaseConnector {
  readonly providerName = "shopify";
  private tokens: ShopifyTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Shopify not connected. Run: patchwork-os connect shopify or set SHOPIFY_ACCESS_TOKEN + SHOPIFY_SHOP_DOMAIN",
      );
    }
    this.tokens = tokens;
    return {
      token: tokens.accessToken,
      scopes: ["read"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async () => {
        const base = this.requireBaseUrl();
        const res = await fetch(`${base}/shop.json`, {
          headers: this.buildHeaders(),
        });
        if (!res.ok) throw res;
        return res.json();
      });
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    if (error instanceof Response) {
      const s = error.status;
      if (s === 401)
        return {
          code: "auth_expired",
          message: "Shopify authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect shopify",
        };
      if (s === 402)
        return {
          code: "provider_error",
          message:
            "Shopify shop is frozen — billing issue on the merchant account",
          retryable: false,
          suggestedAction:
            "Merchant must resolve billing in the Shopify admin dashboard",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Shopify permissions for this resource",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Shopify resource not found",
          retryable: false,
        };
      if (s === 423)
        return {
          code: "provider_error",
          message: "Shopify shop is locked",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Shopify API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Shopify API error: HTTP ${s}`,
        retryable: s >= 500,
      };
    }
    if (error instanceof Error) {
      if (
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ECONNREFUSED")
      ) {
        return {
          code: "network_error",
          message: `Cannot connect to Shopify: ${error.message}`,
          retryable: true,
        };
      }
    }
    return {
      code: "provider_error",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }

  getStatus(): ConnectorStatus {
    const tokens = loadTokens();
    return {
      id: "shopify",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.shopName
        ? `${tokens.shopName} (${tokens.shopDomain})`
        : tokens?.shopDomain,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async getShop(): Promise<ShopifyShop> {
    const result = await this.apiCall(async () => {
      const base = this.requireBaseUrl();
      const res = await fetch(`${base}/shop.json`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ shop: ShopifyShop }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return (result.data as { shop: ShopifyShop }).shop;
  }

  async listProducts(
    params: {
      limit?: number;
      status?: string;
      vendor?: string;
      productType?: string;
    } = {},
  ): Promise<ShopifyListResult<ShopifyProduct>> {
    const result = await this.apiCall(async () => {
      const base = this.requireBaseUrl();
      const qs = new URLSearchParams();
      qs.set("limit", String(clampLimit(params.limit, 50)));
      if (params.status) qs.set("status", params.status);
      if (params.vendor) qs.set("vendor", params.vendor);
      if (params.productType) qs.set("product_type", params.productType);
      const res = await fetch(`${base}/products.json?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ products: ShopifyProduct[] }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return { data: (result.data as { products: ShopifyProduct[] }).products };
  }

  async getProduct(productId: string | number): Promise<ShopifyProduct> {
    const result = await this.apiCall(async () => {
      const base = this.requireBaseUrl();
      const res = await fetch(`${base}/products/${productId}.json`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ product: ShopifyProduct }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return (result.data as { product: ShopifyProduct }).product;
  }

  async listOrders(
    params: {
      limit?: number;
      status?: string;
      financialStatus?: string;
      fulfillmentStatus?: string;
    } = {},
  ): Promise<ShopifyListResult<ShopifyOrder>> {
    const result = await this.apiCall(async () => {
      const base = this.requireBaseUrl();
      const qs = new URLSearchParams();
      qs.set("limit", String(clampLimit(params.limit, 50)));
      qs.set("status", params.status ?? "any");
      if (params.financialStatus)
        qs.set("financial_status", params.financialStatus);
      if (params.fulfillmentStatus)
        qs.set("fulfillment_status", params.fulfillmentStatus);
      const res = await fetch(`${base}/orders.json?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ orders: ShopifyOrder[] }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return { data: (result.data as { orders: ShopifyOrder[] }).orders };
  }

  async getOrder(orderId: string | number): Promise<ShopifyOrder> {
    const result = await this.apiCall(async () => {
      const base = this.requireBaseUrl();
      const res = await fetch(`${base}/orders/${orderId}.json`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ order: ShopifyOrder }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return (result.data as { order: ShopifyOrder }).order;
  }

  async listCustomers(
    params: { limit?: number; query?: string } = {},
  ): Promise<ShopifyListResult<ShopifyCustomer>> {
    const result = await this.apiCall(async () => {
      const base = this.requireBaseUrl();
      const qs = new URLSearchParams();
      qs.set("limit", String(clampLimit(params.limit, 50)));
      const path = params.query
        ? `/customers/search.json?${(() => {
            qs.set("query", params.query);
            return qs.toString();
          })()}`
        : `/customers.json?${qs}`;
      const res = await fetch(`${base}${path}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ customers: ShopifyCustomer[] }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return {
      data: (result.data as { customers: ShopifyCustomer[] }).customers,
    };
  }

  async getCustomer(customerId: string | number): Promise<ShopifyCustomer> {
    const result = await this.apiCall(async () => {
      const base = this.requireBaseUrl();
      const res = await fetch(`${base}/customers/${customerId}.json`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ customer: ShopifyCustomer }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return (result.data as { customer: ShopifyCustomer }).customer;
  }

  async listInventoryLevels(
    locationId: string | number,
    params: { limit?: number } = {},
  ): Promise<ShopifyListResult<ShopifyInventoryLevel>> {
    const result = await this.apiCall(async () => {
      const base = this.requireBaseUrl();
      const qs = new URLSearchParams();
      qs.set("location_ids", String(locationId));
      qs.set("limit", String(clampLimit(params.limit, 50)));
      const res = await fetch(`${base}/inventory_levels.json?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{
        inventory_levels: ShopifyInventoryLevel[];
      }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return {
      data: (result.data as { inventory_levels: ShopifyInventoryLevel[] })
        .inventory_levels,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const token = this.tokens?.accessToken ?? "";
    return {
      "X-Shopify-Access-Token": token,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private requireBaseUrl(): string {
    const domain = this.tokens?.shopDomain;
    if (!domain) {
      throw new Error(
        "Shopify shopDomain missing — call authenticate() before making API requests",
      );
    }
    return buildBaseUrl(domain);
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): ShopifyTokens | null {
  const envToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const envDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  if (envToken && envDomain) {
    return {
      accessToken: envToken,
      shopDomain: envDomain,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<ShopifyTokens>("shopify");
}

export function saveTokens(tokens: ShopifyTokens): void {
  storeSecretJsonSync("shopify", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("shopify");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: ShopifyConnector | null = null;

function resetShopifyConnector(): void {
  _instance = null;
}

export function getShopifyConnector(): ShopifyConnector {
  if (!_instance) {
    _instance = new ShopifyConnector();
  }
  return _instance;
}

export { getShopifyConnector as shopify };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/shopify/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/shopify/connect  { accessToken, shopDomain }
 */
export async function handleShopifyConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let accessToken: string;
  let shopDomain: string;

  try {
    const parsed = JSON.parse(body) as {
      accessToken?: unknown;
      shopDomain?: unknown;
    };
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "accessToken is required" }),
      };
    }
    if (typeof parsed.shopDomain !== "string" || !parsed.shopDomain) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "shopDomain is required" }),
      };
    }
    accessToken = parsed.accessToken;
    shopDomain = parsed.shopDomain.trim().toLowerCase();
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  if (!isValidShopDomain(shopDomain)) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error:
          "shopDomain must be a valid Shopify permanent domain (e.g. acme-store.myshopify.com)",
      }),
    };
  }

  try {
    const res = await fetch(`${buildBaseUrl(shopDomain)}/shop.json`, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Shopify (HTTP ${res.status}) — check accessToken + shopDomain`,
        }),
      };
    }
    const payload = (await res.json()) as { shop?: Partial<ShopifyShop> };
    const shop = payload.shop ?? {};

    if (
      typeof shop.myshopify_domain === "string" &&
      shop.myshopify_domain.toLowerCase() !== shopDomain
    ) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `shopDomain mismatch: token belongs to ${shop.myshopify_domain}, not ${shopDomain}`,
        }),
      };
    }

    const shopName = typeof shop.name === "string" ? shop.name : undefined;
    const planName =
      typeof shop.plan_name === "string" ? shop.plan_name : undefined;

    const tokens: ShopifyTokens = {
      accessToken,
      shopDomain,
      shopName,
      planName,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetShopifyConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        shopDomain,
        shopName,
        planName,
        connectedAt: tokens.connected_at,
      }),
    };
  } catch (err) {
    return {
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

/**
 * POST /connections/shopify/test
 */
export async function handleShopifyTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Shopify not connected" }),
    };
  }
  try {
    const connector = getShopifyConnector();
    const check = await connector.healthCheck();
    return {
      status: check.ok ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(
        check.ok ? { ok: true } : { ok: false, error: check.error?.message },
      ),
    };
  } catch (err) {
    return {
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

/**
 * DELETE /connections/shopify
 */
export function handleShopifyDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetShopifyConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
