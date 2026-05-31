/**
 * WooCommerce connector — access to WooCommerce store data via the WooCommerce REST API v3.
 *
 * Auth: HTTP Basic auth with consumer key/secret.
 *   - Env vars: WOOCOMMERCE_CONSUMER_KEY, WOOCOMMERCE_CONSUMER_SECRET, WOOCOMMERCE_STORE_URL
 *   - Stored: getSecretJsonSync("woocommerce") → WooCommerceTokens
 *
 * Tools: getOrders, getOrder, updateOrder, getProducts, getProduct, updateProduct,
 *        getProductVariations, getCustomers, getCustomer, listWebhooks, createWebhook,
 *        deleteWebhook, getReportsSales
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 */

import { createHmac } from "node:crypto";
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

// ── Token types ───────────────────────────────────────────────────────────────

export interface WooCommerceTokens {
  consumerKey: string;
  consumerSecret: string;
  storeUrl: string; // e.g. https://mystore.com
  connected_at: string;
}

// ── API types ─────────────────────────────────────────────────────────────────

export interface WooLineItem {
  id: number;
  name: string;
  product_id: number;
  variation_id: number;
  quantity: number;
  subtotal: string;
  total: string;
  sku: string;
  price: number;
}

export interface WooAddress {
  first_name: string;
  last_name: string;
  company: string;
  address_1: string;
  address_2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  email?: string;
  phone?: string;
}

export interface WooOrder {
  id: number;
  status: string;
  currency: string;
  date_created: string;
  total: string;
  customer_id: number;
  billing: WooAddress;
  shipping: WooAddress;
  line_items: WooLineItem[];
  payment_method: string;
  payment_method_title: string;
  transaction_id: string;
  customer_note: string;
}

export interface WooProductCategory {
  id: number;
  name: string;
  slug: string;
}

export interface WooProductImage {
  id: number;
  src: string;
  name: string;
  alt: string;
}

export interface WooProduct {
  id: number;
  name: string;
  status: string;
  price: string;
  regular_price: string;
  sale_price: string;
  stock_quantity: number | null;
  stock_status: string;
  categories: WooProductCategory[];
  images: WooProductImage[];
  sku: string;
  description: string;
  short_description: string;
  type: string;
}

export interface WooProductVariation {
  id: number;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  stock_quantity: number | null;
  stock_status: string;
  attributes: Array<{ id: number; name: string; option: string }>;
}

export interface WooCustomer {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  billing: WooAddress;
  orders_count: number;
  total_spent: string;
  date_created: string;
}

export interface WooWebhook {
  id: number;
  name: string;
  status: string;
  topic: string;
  delivery_url: string;
  date_created: string;
}

export interface WooSalesReportTotal {
  sales: string;
  orders: number;
  items: number;
  tax: string;
  shipping: string;
  refunds: number;
  customers: number;
}

export interface WooSalesReport {
  total_sales: string;
  net_revenue: string;
  average_sales: string;
  total_orders: number;
  total_items: number;
  total_tax: string;
  total_shipping: string;
  total_refunds: number;
  total_customers: number;
  totals: Record<string, WooSalesReportTotal>;
}

// ── Token persistence ─────────────────────────────────────────────────────────

export function loadTokens(): WooCommerceTokens | null {
  const key = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const secret = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  const storeUrl = process.env.WOOCOMMERCE_STORE_URL;
  if (key && secret && storeUrl) {
    return {
      consumerKey: key,
      consumerSecret: secret,
      storeUrl: storeUrl.replace(/\/$/, ""),
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<WooCommerceTokens>("woocommerce");
}

export function saveTokens(tokens: WooCommerceTokens): void {
  storeSecretJsonSync("woocommerce", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("woocommerce");
  } catch {
    // ignore
  }
}

// ── Webhook verification ──────────────────────────────────────────────────────

/**
 * Verify an incoming WooCommerce webhook.
 * WooCommerce signs with HMAC-SHA256 over the raw body using the webhook secret,
 * then base64-encodes the digest. Delivered in X-WC-Webhook-Signature header.
 */
export function verifyWooCommerceWebhook(
  rawBody: string | Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const computed = createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  if (computed.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

// ── Connector class ───────────────────────────────────────────────────────────

export class WooCommerceConnector extends BaseConnector {
  readonly providerName = "woocommerce";
  private tokens: WooCommerceTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "WooCommerce not connected. Run: patchwork connect woocommerce or set WOOCOMMERCE_CONSUMER_KEY, WOOCOMMERCE_CONSUMER_SECRET, WOOCOMMERCE_STORE_URL",
      );
    }
    this.tokens = tokens;
    return {
      token: Buffer.from(
        `${tokens.consumerKey}:${tokens.consumerSecret}`,
      ).toString("base64"),
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async () => {
        const res = await fetch(this.baseUrl("/system_status"), {
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
    // WooCommerce REST errors: { code, message, data: { status } }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      "message" in error &&
      !(error instanceof Response)
    ) {
      const wooErr = error as {
        code: string;
        message: string;
        data?: { status?: number };
      };
      const status = wooErr.data?.status ?? 0;
      if (
        status === 401 ||
        wooErr.code === "woocommerce_rest_authentication_error"
      ) {
        return {
          code: "auth_expired",
          message:
            "WooCommerce authentication failed — check consumer key/secret",
          retryable: false,
          suggestedAction: "patchwork connect woocommerce",
        };
      }
      if (status === 429) {
        return {
          code: "rate_limited",
          message: "WooCommerce API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      }
      if (status === 404) {
        return { code: "not_found", message: wooErr.message, retryable: false };
      }
      if (status === 400) {
        return {
          code: "validation_error",
          message: wooErr.message,
          retryable: false,
        };
      }
      return {
        code: "provider_error",
        message: wooErr.message,
        retryable: status >= 500,
      };
    }
    if (
      error instanceof Response ||
      (error && typeof error === "object" && "status" in error)
    ) {
      const s = (error as { status: number }).status;
      if (s === 401)
        return {
          code: "auth_expired",
          message: "WooCommerce authentication expired",
          retryable: false,
          suggestedAction: "patchwork connect woocommerce",
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "WooCommerce API rate limit exceeded",
          retryable: true,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "WooCommerce resource not found",
          retryable: false,
        };
      if (s === 400)
        return {
          code: "validation_error",
          message: `WooCommerce validation error: HTTP ${s}`,
          retryable: false,
        };
      return {
        code: "provider_error",
        message: `WooCommerce API error: HTTP ${s}`,
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
          message: `Cannot connect to WooCommerce store: ${error.message}`,
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
      id: "woocommerce",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.storeUrl,
    };
  }

  // ── API helpers ────────────────────────────────────────────────────────────

  private baseUrl(path: string): string {
    const storeUrl = this.tokens?.storeUrl ?? "";
    return `${storeUrl}/wp-json/wc/v3${path}`;
  }

  private buildHeaders(): Record<string, string> {
    const creds = this.tokens
      ? Buffer.from(
          `${this.tokens.consumerKey}:${this.tokens.consumerSecret}`,
        ).toString("base64")
      : "";
    return {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const result = await this.apiCall(async () => {
      const res = await fetch(this.baseUrl(path), {
        method,
        headers: this.buildHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          code?: string;
          message?: string;
          data?: { status?: number };
        };
        throw Object.assign(
          new Error(errBody.message ?? `HTTP ${res.status}`),
          {
            code: errBody.code ?? "provider_error",
            data: errBody.data ?? { status: res.status },
          },
        );
      }
      return res.json() as Promise<T>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as T;
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  async getOrders(
    params: {
      status?: string;
      perPage?: number;
      page?: number;
      after?: string;
      before?: string;
    } = {},
  ): Promise<WooOrder[]> {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.perPage) qs.set("per_page", String(params.perPage));
    if (params.page) qs.set("page", String(params.page));
    if (params.after) qs.set("after", params.after);
    if (params.before) qs.set("before", params.before);
    return this.request<WooOrder[]>("GET", `/orders?${qs}`);
  }

  async getOrder(id: number): Promise<WooOrder> {
    return this.request<WooOrder>("GET", `/orders/${id}`);
  }

  async updateOrder(
    id: number,
    fields: { status?: string; customer_note?: string },
  ): Promise<WooOrder> {
    return this.request<WooOrder>("PUT", `/orders/${id}`, fields);
  }

  // ── Products ──────────────────────────────────────────────────────────────

  async getProducts(
    params: {
      status?: string;
      perPage?: number;
      page?: number;
      category?: string;
    } = {},
  ): Promise<WooProduct[]> {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.perPage) qs.set("per_page", String(params.perPage));
    if (params.page) qs.set("page", String(params.page));
    if (params.category) qs.set("category", params.category);
    return this.request<WooProduct[]>("GET", `/products?${qs}`);
  }

  async getProduct(id: number): Promise<WooProduct> {
    return this.request<WooProduct>("GET", `/products/${id}`);
  }

  async updateProduct(
    id: number,
    fields: Partial<
      Pick<
        WooProduct,
        | "status"
        | "price"
        | "regular_price"
        | "sale_price"
        | "stock_quantity"
        | "stock_status"
      >
    > &
      Record<string, unknown>,
  ): Promise<WooProduct> {
    return this.request<WooProduct>("PUT", `/products/${id}`, fields);
  }

  async getProductVariations(
    productId: number,
  ): Promise<WooProductVariation[]> {
    return this.request<WooProductVariation[]>(
      "GET",
      `/products/${productId}/variations`,
    );
  }

  // ── Customers ─────────────────────────────────────────────────────────────

  async getCustomers(
    params: { search?: string; perPage?: number; page?: number } = {},
  ): Promise<WooCustomer[]> {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    if (params.perPage) qs.set("per_page", String(params.perPage));
    if (params.page) qs.set("page", String(params.page));
    return this.request<WooCustomer[]>("GET", `/customers?${qs}`);
  }

  async getCustomer(id: number): Promise<WooCustomer> {
    return this.request<WooCustomer>("GET", `/customers/${id}`);
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  async listWebhooks(): Promise<WooWebhook[]> {
    return this.request<WooWebhook[]>("GET", "/webhooks");
  }

  async createWebhook(
    name: string,
    topic: string,
    deliveryUrl: string,
    secret?: string,
  ): Promise<WooWebhook> {
    const body: Record<string, string> = {
      name,
      topic,
      delivery_url: deliveryUrl,
    };
    if (secret) body.secret = secret;
    return this.request<WooWebhook>("POST", "/webhooks", body);
  }

  async deleteWebhook(id: number): Promise<{ id: number; message: string }> {
    return this.request<{ id: number; message: string }>(
      "DELETE",
      `/webhooks/${id}?force=true`,
    );
  }

  // ── Reports ───────────────────────────────────────────────────────────────

  async getReportsSales(
    params: {
      period?: "week" | "month" | "last_month" | "year";
      dateMin?: string;
      dateMax?: string;
    } = {},
  ): Promise<WooSalesReport[]> {
    const qs = new URLSearchParams();
    if (params.period) qs.set("period", params.period);
    if (params.dateMin) qs.set("date_min", params.dateMin);
    if (params.dateMax) qs.set("date_max", params.dateMax);
    return this.request<WooSalesReport[]>("GET", `/reports/sales?${qs}`);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: WooCommerceConnector | null = null;

function resetWooCommerceConnector(): void {
  _instance = null;
}

export function getWooCommerceConnector(): WooCommerceConnector {
  if (!_instance) {
    _instance = new WooCommerceConnector();
  }
  return _instance;
}

export { getWooCommerceConnector as woocommerce };

// ── HTTP Handlers ─────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/woocommerce/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/woocommerce/connect  { consumerKey, consumerSecret, storeUrl }
 */
export async function handleWooCommerceConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let consumerKey: string;
  let consumerSecret: string;
  let storeUrl: string;

  try {
    const parsed = JSON.parse(body) as {
      consumerKey?: unknown;
      consumerSecret?: unknown;
      storeUrl?: unknown;
    };
    if (typeof parsed.consumerKey !== "string" || !parsed.consumerKey) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "consumerKey is required" }),
      };
    }
    if (typeof parsed.consumerSecret !== "string" || !parsed.consumerSecret) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "consumerSecret is required",
        }),
      };
    }
    if (typeof parsed.storeUrl !== "string" || !parsed.storeUrl) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "storeUrl is required" }),
      };
    }
    consumerKey = parsed.consumerKey;
    consumerSecret = parsed.consumerSecret;
    storeUrl = parsed.storeUrl.replace(/\/$/, "");
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const basic = Buffer.from(`${consumerKey}:${consumerSecret}`).toString(
      "base64",
    );
    const res = await fetch(`${storeUrl}/wp-json/wc/v3/system_status`, {
      headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by WooCommerce store (HTTP ${res.status}) — check consumerKey and consumerSecret`,
        }),
      };
    }

    const tokens: WooCommerceTokens = {
      consumerKey,
      consumerSecret,
      storeUrl,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetWooCommerceConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        storeUrl,
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
 * POST /connections/woocommerce/test
 */
export async function handleWooCommerceTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "WooCommerce not connected" }),
    };
  }
  try {
    const connector = getWooCommerceConnector();
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
 * DELETE /connections/woocommerce
 */
export function handleWooCommerceDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetWooCommerceConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
