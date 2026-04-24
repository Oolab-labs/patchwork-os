/**
 * Stripe connector — read-only access to Stripe data via the Stripe REST API v1.
 *
 * Auth: Basic auth where username=secret_key, password="".
 *   - Env var: STRIPE_SECRET_KEY
 *   - Stored: getSecretJsonSync("stripe") → StripeTokens
 *
 * Tools: listCharges, getCharge, listCustomers, getCustomer, listSubscriptions, listInvoices
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

export interface StripeTokens {
  secretKey: string; // sk_live_... or sk_test_...
  accountId?: string;
  accountName?: string;
  connected_at: string;
}

export interface StripeCharge {
  id: string;
  amount: number;
  currency: string;
  status: string;
  customer: string | null;
  description: string | null;
  created: number;
  paid: boolean;
  refunded: boolean;
}

export interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  created: number;
  currency: string | null;
  balance: number;
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_start: number;
  current_period_end: number;
  created: number;
  cancel_at_period_end: boolean;
}

export interface StripeInvoice {
  id: string;
  customer: string;
  status: string | null;
  amount_due: number;
  amount_paid: number;
  currency: string;
  created: number;
  due_date: number | null;
}

export interface StripeListResult<T> {
  data: T[];
  has_more: boolean;
}

const BASE_URL = "https://api.stripe.com";

export class StripeConnector extends BaseConnector {
  readonly providerName = "stripe";
  private tokens: StripeTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Stripe not connected. Run: patchwork-os connect stripe or set STRIPE_SECRET_KEY",
      );
    }
    this.tokens = tokens;
    return {
      token: tokens.secretKey,
      scopes: ["read"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async () => {
        const res = await fetch(`${BASE_URL}/v1/balance`, {
          headers: this.buildHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
          message: "Stripe authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect stripe",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Stripe permissions",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Stripe resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Stripe API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Stripe API error: HTTP ${s}`,
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
          message: `Cannot connect to Stripe: ${error.message}`,
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
      id: "stripe",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.accountId
        ? `Stripe account ${tokens.accountId}`
        : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async listCharges(
    params: { limit?: number; customerId?: string; status?: string } = {},
  ): Promise<StripeListResult<StripeCharge>> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.customerId) qs.set("customer", params.customerId);
      if (params.status) qs.set("status", params.status);
      const res = await fetch(`${BASE_URL}/v1/charges?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<StripeListResult<StripeCharge>>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as StripeListResult<StripeCharge>;
  }

  async getCharge(chargeId: string): Promise<StripeCharge> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/v1/charges/${chargeId}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<StripeCharge>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as StripeCharge;
  }

  async listCustomers(
    params: { limit?: number; email?: string } = {},
  ): Promise<StripeListResult<StripeCustomer>> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.email) qs.set("email", params.email);
      const res = await fetch(`${BASE_URL}/v1/customers?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<StripeListResult<StripeCustomer>>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as StripeListResult<StripeCustomer>;
  }

  async getCustomer(customerId: string): Promise<StripeCustomer> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/v1/customers/${customerId}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<StripeCustomer>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as StripeCustomer;
  }

  async listSubscriptions(
    params: { limit?: number; customerId?: string; status?: string } = {},
  ): Promise<StripeListResult<StripeSubscription>> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.customerId) qs.set("customer", params.customerId);
      if (params.status) qs.set("status", params.status);
      const res = await fetch(`${BASE_URL}/v1/subscriptions?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<StripeListResult<StripeSubscription>>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as StripeListResult<StripeSubscription>;
  }

  async listInvoices(
    params: { limit?: number; customerId?: string; status?: string } = {},
  ): Promise<StripeListResult<StripeInvoice>> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.customerId) qs.set("customer", params.customerId);
      if (params.status) qs.set("status", params.status);
      const res = await fetch(`${BASE_URL}/v1/invoices?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<StripeListResult<StripeInvoice>>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as StripeListResult<StripeInvoice>;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const key = this.tokens?.secretKey ?? "";
    const basic = Buffer.from(`${key}:`).toString("base64");
    return {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): StripeTokens | null {
  const envKey = process.env.STRIPE_SECRET_KEY;
  if (envKey) {
    return {
      secretKey: envKey,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<StripeTokens>("stripe");
}

export function saveTokens(tokens: StripeTokens): void {
  storeSecretJsonSync("stripe", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("stripe");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: StripeConnector | null = null;

function resetStripeConnector(): void {
  _instance = null;
}

export function getStripeConnector(): StripeConnector {
  if (!_instance) {
    _instance = new StripeConnector();
  }
  return _instance;
}

export { getStripeConnector as stripe };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/stripe/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/stripe/connect  { secretKey }
 */
export async function handleStripeConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let secretKey: string;

  try {
    const parsed = JSON.parse(body) as { secretKey?: unknown };
    if (typeof parsed.secretKey !== "string" || !parsed.secretKey) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "secretKey is required" }),
      };
    }
    secretKey = parsed.secretKey;
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const basic = Buffer.from(`${secretKey}:`).toString("base64");
    const res = await fetch(`${BASE_URL}/v1/account`, {
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Stripe (HTTP ${res.status}) — check secretKey`,
        }),
      };
    }
    const account = (await res.json()) as {
      id?: string;
      display_name?: string;
      business_profile?: { name?: string };
    };

    const accountId = account.id ?? undefined;
    const accountName =
      account.display_name ?? account.business_profile?.name ?? undefined;

    const tokens: StripeTokens = {
      secretKey,
      accountId,
      accountName,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetStripeConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        accountId,
        accountName,
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
 * POST /connections/stripe/test
 */
export async function handleStripeTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Stripe not connected" }),
    };
  }
  try {
    const connector = getStripeConnector();
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
 * DELETE /connections/stripe
 */
export function handleStripeDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetStripeConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
