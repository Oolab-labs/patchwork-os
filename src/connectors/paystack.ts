/**
 * Paystack connector — payment gateway dominant in Nigeria, Ghana, Kenya,
 * South Africa, and Côte d'Ivoire.
 *
 * Auth: Bearer token using secret key.
 *   - Env var: PAYSTACK_SECRET_KEY
 *   - Stored: getSecretJsonSync("paystack") → PaystackTokens
 *
 * Tools: initializeTransaction, verifyTransaction, listTransactions,
 *        getTransaction, chargeAuthorization, createCustomer, getCustomer,
 *        listCustomers, createTransferRecipient, initiateTransfer, listBanks
 *
 * Webhook: verifyPaystackWebhook — HMAC-SHA512 over raw body with secret key.
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 */

import crypto from "node:crypto";
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

export interface PaystackTokens {
  secretKey: string;
  businessName?: string;
  connected_at: string;
}

export interface PaystackTransaction {
  id: number;
  domain: string;
  status: string;
  reference: string;
  amount: number;
  currency: string;
  paid_at: string | null;
  customer: {
    email: string;
  };
  authorization: {
    authorization_code: string;
    card_type: string;
    bank: string;
    last4: string;
    exp_month: string;
    exp_year: string;
  };
}

export interface PaystackCustomer {
  id: number;
  email: string;
  customer_code: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  createdAt: string;
}

export interface PaystackTransfer {
  id: number;
  amount: number;
  currency: string;
  recipient: string;
  status: string;
  transfer_code: string;
  reason: string | null;
}

export interface PaystackInitResult {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface PaystackListResult<T> {
  data: T[];
  meta?: { total?: number; skipped?: number; perPage?: number; page?: number };
}

const BASE_URL = "https://api.paystack.co";

export class PaystackConnector extends BaseConnector {
  readonly providerName = "paystack";
  private tokens: PaystackTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Paystack not connected. Run: patchwork-os connect paystack or set PAYSTACK_SECRET_KEY",
      );
    }
    this.tokens = tokens;
    return {
      token: tokens.secretKey,
      scopes: ["read", "write"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async () => {
        const res = await fetch(`${BASE_URL}/bank`, {
          headers: this.buildHeaders(),
        });
        if (!res.ok) {
          await this.throwFromPaystackResponse(res);
        }
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
          message: "Paystack authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect paystack",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Paystack permissions",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Paystack resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Paystack API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Paystack API error: HTTP ${s}`,
        retryable: s >= 500,
      };
    }
    if (error instanceof PaystackApiError) {
      if (error.statusCode === 401)
        return {
          code: "auth_expired",
          message: `Paystack authentication expired: ${error.message}`,
          retryable: false,
          suggestedAction: "patchwork-os connect paystack",
        };
      if (error.statusCode === 429)
        return {
          code: "rate_limited",
          message: `Paystack rate limit: ${error.message}`,
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: error.message,
        retryable: error.statusCode >= 500,
      };
    }
    if (error instanceof Error) {
      if (
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ECONNREFUSED")
      ) {
        return {
          code: "network_error",
          message: `Cannot connect to Paystack: ${error.message}`,
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
      id: "paystack",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.businessName
        ? `Paystack: ${tokens.businessName}`
        : undefined,
    };
  }

  // ── Transaction Methods ────────────────────────────────────────────────────

  async initializeTransaction(
    email: string,
    amountKobo: number,
    params: {
      currency?: string;
      reference?: string;
      callbackUrl?: string;
      metadata?: unknown;
    } = {},
  ): Promise<PaystackInitResult> {
    const result = await this.apiCall(async () => {
      const body: Record<string, unknown> = { email, amount: amountKobo };
      if (params.currency) body.currency = params.currency;
      if (params.reference) body.reference = params.reference;
      if (params.callbackUrl) body.callback_url = params.callbackUrl;
      if (params.metadata) body.metadata = params.metadata;
      const res = await fetch(`${BASE_URL}/transaction/initialize`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) await this.throwFromPaystackResponse(res);
      const json = (await res.json()) as {
        status: boolean;
        data: PaystackInitResult;
        message?: string;
      };
      if (!json.status) throw new Error(json.message ?? "Paystack error");
      return json.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PaystackInitResult;
  }

  async verifyTransaction(reference: string): Promise<PaystackTransaction> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) await this.throwFromPaystackResponse(res);
      const json = (await res.json()) as {
        status: boolean;
        data: PaystackTransaction;
        message?: string;
      };
      if (!json.status) throw new Error(json.message ?? "Paystack error");
      return json.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PaystackTransaction;
  }

  async listTransactions(
    params: {
      perPage?: number;
      page?: number;
      from?: string;
      to?: string;
      status?: string;
    } = {},
  ): Promise<PaystackListResult<PaystackTransaction>> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (params.perPage) qs.set("perPage", String(params.perPage));
      if (params.page) qs.set("page", String(params.page));
      if (params.from) qs.set("from", params.from);
      if (params.to) qs.set("to", params.to);
      if (params.status) qs.set("status", params.status);
      const res = await fetch(`${BASE_URL}/transaction?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) await this.throwFromPaystackResponse(res);
      const json = (await res.json()) as {
        status: boolean;
        data: PaystackTransaction[];
        meta?: PaystackListResult<PaystackTransaction>["meta"];
        message?: string;
      };
      if (!json.status) throw new Error(json.message ?? "Paystack error");
      return { data: json.data, meta: json.meta };
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PaystackListResult<PaystackTransaction>;
  }

  async getTransaction(id: number): Promise<PaystackTransaction> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/transaction/${id}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) await this.throwFromPaystackResponse(res);
      const json = (await res.json()) as {
        status: boolean;
        data: PaystackTransaction;
        message?: string;
      };
      if (!json.status) throw new Error(json.message ?? "Paystack error");
      return json.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PaystackTransaction;
  }

  async chargeAuthorization(
    authorizationCode: string,
    email: string,
    amountKobo: number,
    params: { currency?: string; reference?: string } = {},
  ): Promise<PaystackTransaction> {
    const result = await this.apiCall(async () => {
      const body: Record<string, unknown> = {
        authorization_code: authorizationCode,
        email,
        amount: amountKobo,
      };
      if (params.currency) body.currency = params.currency;
      if (params.reference) body.reference = params.reference;
      const res = await fetch(`${BASE_URL}/transaction/charge_authorization`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) await this.throwFromPaystackResponse(res);
      const json = (await res.json()) as {
        status: boolean;
        data: PaystackTransaction;
        message?: string;
      };
      if (!json.status) throw new Error(json.message ?? "Paystack error");
      return json.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PaystackTransaction;
  }

  // ── Customer Methods ───────────────────────────────────────────────────────

  async createCustomer(
    email: string,
    params: { firstName?: string; lastName?: string; phone?: string } = {},
  ): Promise<PaystackCustomer> {
    const result = await this.apiCall(async () => {
      const body: Record<string, unknown> = { email };
      if (params.firstName) body.first_name = params.firstName;
      if (params.lastName) body.last_name = params.lastName;
      if (params.phone) body.phone = params.phone;
      const res = await fetch(`${BASE_URL}/customer`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) await this.throwFromPaystackResponse(res);
      const json = (await res.json()) as {
        status: boolean;
        data: PaystackCustomer;
        message?: string;
      };
      if (!json.status) throw new Error(json.message ?? "Paystack error");
      return json.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PaystackCustomer;
  }

  async getCustomer(emailOrCode: string): Promise<PaystackCustomer> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/customer/${encodeURIComponent(emailOrCode)}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) await this.throwFromPaystackResponse(res);
      const json = (await res.json()) as {
        status: boolean;
        data: PaystackCustomer;
        message?: string;
      };
      if (!json.status) throw new Error(json.message ?? "Paystack error");
      return json.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PaystackCustomer;
  }

  async listCustomers(
    params: { perPage?: number; page?: number } = {},
  ): Promise<PaystackListResult<PaystackCustomer>> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (params.perPage) qs.set("perPage", String(params.perPage));
      if (params.page) qs.set("page", String(params.page));
      const res = await fetch(`${BASE_URL}/customer?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) await this.throwFromPaystackResponse(res);
      const json = (await res.json()) as {
        status: boolean;
        data: PaystackCustomer[];
        message?: string;
      };
      if (!json.status) throw new Error(json.message ?? "Paystack error");
      return { data: json.data };
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PaystackListResult<PaystackCustomer>;
  }

  // ── Transfer Methods ───────────────────────────────────────────────────────

  async createTransferRecipient(
    type: string,
    name: string,
    accountNumber: string,
    bankCode: string,
    currency = "NGN",
  ): Promise<{ recipient_code: string; id: number }> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/transferrecipient`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          type,
          name,
          account_number: accountNumber,
          bank_code: bankCode,
          currency,
        }),
      });
      if (!res.ok) await this.throwFromPaystackResponse(res);
      const json = (await res.json()) as {
        status: boolean;
        data: { recipient_code: string; id: number };
        message?: string;
      };
      if (!json.status) throw new Error(json.message ?? "Paystack error");
      return json.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as { recipient_code: string; id: number };
  }

  async initiateTransfer(
    source: string,
    amountKobo: number,
    recipient: string,
    reason?: string,
  ): Promise<PaystackTransfer> {
    const result = await this.apiCall(async () => {
      const body: Record<string, unknown> = {
        source,
        amount: amountKobo,
        recipient,
      };
      if (reason) body.reason = reason;
      const res = await fetch(`${BASE_URL}/transfer`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) await this.throwFromPaystackResponse(res);
      const json = (await res.json()) as {
        status: boolean;
        data: PaystackTransfer;
        message?: string;
      };
      if (!json.status) throw new Error(json.message ?? "Paystack error");
      return json.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PaystackTransfer;
  }

  // ── Bank Methods ───────────────────────────────────────────────────────────

  async listBanks(
    country?: string,
  ): Promise<{ id: number; name: string; code: string; country: string }[]> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (country) qs.set("country", country);
      const res = await fetch(`${BASE_URL}/bank?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) await this.throwFromPaystackResponse(res);
      const json = (await res.json()) as {
        status: boolean;
        data: { id: number; name: string; code: string; country: string }[];
        message?: string;
      };
      if (!json.status) throw new Error(json.message ?? "Paystack error");
      return json.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as {
      id: number;
      name: string;
      code: string;
      country: string;
    }[];
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const key = this.tokens?.secretKey ?? "";
    return {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async throwFromPaystackResponse(res: Response): Promise<never> {
    let message = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { message?: string };
      if (json.message) message = json.message;
    } catch {
      // ignore parse failure
    }
    throw new PaystackApiError(message, res.status);
  }
}

// ── Internal error type ──────────────────────────────────────────────────────

class PaystackApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "PaystackApiError";
  }
}

// ── Webhook verification ─────────────────────────────────────────────────────

/**
 * Verify a Paystack webhook event.
 *
 * @param rawBody    Raw request body bytes (Buffer or string)
 * @param signature  Value of the `x-paystack-signature` header
 * @param secretKey  Paystack secret key used to sign events
 * @returns true if the signature matches, false otherwise
 */
export function verifyPaystackWebhook(
  rawBody: Buffer | string,
  signature: string,
  secretKey: string,
): boolean {
  if (!signature || !secretKey) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  const expected = crypto
    .createHmac("sha512", secretKey)
    .update(body)
    .digest("hex");
  // Use timingSafeEqual to prevent timing attacks
  try {
    const expectedBuf = Buffer.from(expected, "hex");
    const signatureBuf = Buffer.from(signature, "hex");
    if (expectedBuf.length !== signatureBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
  } catch {
    return false;
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): PaystackTokens | null {
  const envKey = process.env.PAYSTACK_SECRET_KEY;
  if (envKey) {
    return {
      secretKey: envKey,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<PaystackTokens>("paystack");
}

export function saveTokens(tokens: PaystackTokens): void {
  storeSecretJsonSync("paystack", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("paystack");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: PaystackConnector | null = null;

function resetPaystackConnector(): void {
  _instance = null;
}

export function getPaystackConnector(): PaystackConnector {
  if (!_instance) {
    _instance = new PaystackConnector();
  }
  return _instance;
}

export { getPaystackConnector as paystack };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/paystack/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/paystack/connect  { secretKey }
 */
export async function handlePaystackConnect(
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
    // Probe: list banks endpoint validates key authentication
    const probeRes = await fetch(`${BASE_URL}/bank`, {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        Accept: "application/json",
      },
    });
    if (!probeRes.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Paystack (HTTP ${probeRes.status}) — check secretKey`,
        }),
      };
    }

    // Fetch business name from integration info
    let businessName: string | undefined;
    try {
      const infoRes = await fetch(
        `${BASE_URL}/integration/payment_information`,
        {
          headers: {
            Authorization: `Bearer ${secretKey}`,
            Accept: "application/json",
          },
        },
      );
      if (infoRes.ok) {
        const info = (await infoRes.json()) as {
          data?: { business_name?: string };
        };
        businessName = info.data?.business_name ?? undefined;
      }
    } catch {
      // Non-fatal — proceed without business name
    }

    const tokens: PaystackTokens = {
      secretKey,
      businessName,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetPaystackConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        businessName,
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
 * POST /connections/paystack/test
 */
export async function handlePaystackTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Paystack not connected" }),
    };
  }
  try {
    const connector = getPaystackConnector();
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
 * DELETE /connections/paystack
 */
export function handlePaystackDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetPaystackConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
