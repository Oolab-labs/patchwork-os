/**
 * Resend connector — transactional email + audience management via the Resend API.
 *
 * Auth: API key (Bearer token).
 *   - Env var: RESEND_API_KEY overrides stored token for CI/headless use.
 *   - Stored: getSecretJsonSync("resend") → ResendTokens
 *
 * Tools: sendEmail, getEmail, listEmails, cancelEmail, createAudience,
 *        listAudiences, addContact
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 *
 * Webhook verification: verifyResendWebhook() — Resend uses Svix HMAC-SHA256.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
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

const BASE_URL = "https://api.resend.com";

export interface ResendTokens {
  apiKey: string;
  name?: string; // from API key info if available
  connected_at: string;
}

// ── API types ─────────────────────────────────────────────────────────────────

export interface ResendEmail {
  object: "email";
  id: string;
  to: string | string[];
  from: string;
  subject: string;
  html?: string | null;
  text?: string | null;
  reply_to?: string | string[] | null;
  created_at: string;
  last_event?: string;
}

export interface ResendSendResult {
  id: string;
}

export interface ResendEmailListResult {
  object: "list";
  data: ResendEmail[];
}

export interface ResendAudience {
  object: "audience";
  id: string;
  name: string;
  created_at: string;
}

export interface ResendAudienceListResult {
  object: "list";
  data: ResendAudience[];
}

export interface ResendContact {
  object: "contact";
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  unsubscribed: boolean;
  created_at: string;
}

// ── Token helpers ─────────────────────────────────────────────────────────────

export function loadTokens(): ResendTokens | null {
  const envKey = process.env.RESEND_API_KEY;
  if (envKey) {
    return {
      apiKey: envKey,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<ResendTokens>("resend");
}

export function saveTokens(tokens: ResendTokens): void {
  storeSecretJsonSync("resend", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("resend");
  } catch {
    // ignore
  }
}

// ── Connector ─────────────────────────────────────────────────────────────────

export class ResendConnector extends BaseConnector {
  readonly providerName = "resend";
  private tokens: ResendTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Resend not connected. Run: patchwork connect resend  or set RESEND_API_KEY",
      );
    }
    this.tokens = tokens;
    return { token: tokens.apiKey };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const tokens = this.tokens ?? loadTokens();
      if (!tokens) {
        return {
          ok: false,
          error: {
            code: "auth_expired",
            message: "Resend not connected",
            retryable: false,
          },
        };
      }
      this.tokens = tokens;
      const result = await this.apiCall(async () => {
        const res = await fetch(`${BASE_URL}/api-keys`, {
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
          message: "Resend API key invalid or expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork connect resend",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Resend API key permissions",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Resend resource not found",
          retryable: false,
        };
      if (s === 422)
        return {
          code: "validation_error",
          message: `Resend API validation error: HTTP ${s}`,
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Resend API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Resend API error: HTTP ${s}`,
        retryable: s >= 500,
      };
    }
    if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      "message" in error
    ) {
      // Resend JSON error shape: { statusCode, message, name }
      const e = error as {
        statusCode: unknown;
        message: string;
        name?: string;
      };
      const s = typeof e.statusCode === "number" ? e.statusCode : 0;
      if (s === 401)
        return {
          code: "auth_expired",
          message: `Resend auth failed: ${e.message}`,
          retryable: false,
          suggestedAction: "patchwork connect resend",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: `Resend: ${e.message}`,
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: `Resend: ${e.message}`,
          retryable: false,
        };
      if (s >= 400 && s < 500)
        return {
          code: "validation_error",
          message: `Resend: ${e.message}`,
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: `Resend: ${e.message}`,
          retryable: true,
        };
      return {
        code: "provider_error",
        message: `Resend: ${e.message}`,
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
          message: `Cannot connect to Resend: ${error.message}`,
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
      id: "resend",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.name ? `Resend: ${tokens.name}` : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async sendEmail(params: {
    from: string;
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string | string[];
  }): Promise<ResendSendResult> {
    if (!params.from) throw new Error("sendEmail: 'from' is required");
    if (!params.to || (Array.isArray(params.to) && params.to.length === 0))
      throw new Error("sendEmail: 'to' is required");
    if (!params.subject) throw new Error("sendEmail: 'subject' is required");
    if (!params.html && !params.text)
      throw new Error("sendEmail: either 'html' or 'text' is required");

    this.tokens = this.tokens ?? loadTokens();
    if (!this.tokens) throw new Error("Resend not connected");

    const body: Record<string, unknown> = {
      from: params.from,
      to: params.to,
      subject: params.subject,
    };
    if (params.html) body.html = params.html;
    if (params.text) body.text = params.text;
    if (params.replyTo) body.reply_to = params.replyTo;

    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/emails`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<ResendSendResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as ResendSendResult;
  }

  async getEmail(id: string): Promise<ResendEmail> {
    this.tokens = this.tokens ?? loadTokens();
    if (!this.tokens) throw new Error("Resend not connected");

    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/emails/${encodeURIComponent(id)}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<ResendEmail>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as ResendEmail;
  }

  async listEmails(
    params: { limit?: number; page?: number } = {},
  ): Promise<ResendEmailListResult> {
    this.tokens = this.tokens ?? loadTokens();
    if (!this.tokens) throw new Error("Resend not connected");

    const qs = new URLSearchParams();
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.page != null) qs.set("page", String(params.page));
    const query = qs.toString() ? `?${qs}` : "";

    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/emails${query}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<ResendEmailListResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as ResendEmailListResult;
  }

  async cancelEmail(id: string): Promise<{ object: string; id: string }> {
    this.tokens = this.tokens ?? loadTokens();
    if (!this.tokens) throw new Error("Resend not connected");

    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/emails/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ object: string; id: string }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as { object: string; id: string };
  }

  async createAudience(name: string): Promise<ResendAudience> {
    if (!name) throw new Error("createAudience: 'name' is required");
    this.tokens = this.tokens ?? loadTokens();
    if (!this.tokens) throw new Error("Resend not connected");

    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/audiences`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<ResendAudience>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as ResendAudience;
  }

  async listAudiences(): Promise<ResendAudienceListResult> {
    this.tokens = this.tokens ?? loadTokens();
    if (!this.tokens) throw new Error("Resend not connected");

    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/audiences`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<ResendAudienceListResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as ResendAudienceListResult;
  }

  async addContact(params: {
    audienceId: string;
    email: string;
    firstName?: string;
    lastName?: string;
    unsubscribed?: boolean;
  }): Promise<ResendContact> {
    if (!params.audienceId)
      throw new Error("addContact: 'audienceId' is required");
    if (!params.email) throw new Error("addContact: 'email' is required");
    this.tokens = this.tokens ?? loadTokens();
    if (!this.tokens) throw new Error("Resend not connected");

    const body: Record<string, unknown> = { email: params.email };
    if (params.firstName) body.first_name = params.firstName;
    if (params.lastName) body.last_name = params.lastName;
    if (params.unsubscribed != null) body.unsubscribed = params.unsubscribed;

    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/audiences/${encodeURIComponent(params.audienceId)}/contacts`,
        {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<ResendContact>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as ResendContact;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const key = this.tokens?.apiKey ?? "";
    return {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
  }
}

// ── Webhook verification ──────────────────────────────────────────────────────

/**
 * Verify a Resend webhook request signed via Svix.
 *
 * Resend signs webhooks using Svix HMAC-SHA256. The signed payload is:
 *   "{svix-id}.{svix-timestamp}.{rawBody}"
 *
 * The signature header may contain multiple space-separated "v1,<base64>" values.
 *
 * Returns true if any of the provided signatures match.
 */
export function verifyResendWebhook(
  rawBody: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  webhookSecret: string,
): boolean {
  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;

  // Svix secrets are base64-encoded with a "whsec_" prefix
  const secretBytes = webhookSecret.startsWith("whsec_")
    ? Buffer.from(webhookSecret.slice(6), "base64")
    : Buffer.from(webhookSecret, "base64");

  const expected = createHmac("sha256", secretBytes)
    .update(signedPayload)
    .digest("base64");

  // svixSignature is space-separated; each part is "v1,<base64>"
  const signatures = svixSignature.split(" ");
  for (const sig of signatures) {
    const parts = sig.split(",");
    if (parts.length < 2) continue;
    const candidate = parts.slice(1).join(",");
    try {
      const expectedBuf = Buffer.from(expected, "base64");
      const candidateBuf = Buffer.from(candidate, "base64");
      if (
        expectedBuf.length === candidateBuf.length &&
        timingSafeEqual(expectedBuf, candidateBuf)
      ) {
        return true;
      }
    } catch {
      // Buffer.from might throw on malformed base64 — just continue
    }
  }
  return false;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: ResendConnector | null = null;

export function resetResendConnector(): void {
  _instance = null;
}

export function getResendConnector(): ResendConnector {
  if (!_instance) _instance = new ResendConnector();
  return _instance;
}

export { getResendConnector as resend };

// ── HTTP Handlers ─────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/resend/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/resend/connect  { apiKey: "re_..." }
 */
export async function handleResendConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let apiKey: string;
  try {
    const parsed = JSON.parse(body) as { apiKey?: unknown };
    if (typeof parsed.apiKey !== "string" || !parsed.apiKey) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "apiKey is required" }),
      };
    }
    apiKey = parsed.apiKey;
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const res = await fetch(`${BASE_URL}/api-keys`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `API key rejected by Resend (HTTP ${res.status}) — check the key is valid`,
        }),
      };
    }
    const data = (await res.json()) as { data?: Array<{ name?: string }> };
    const name = data.data?.[0]?.name ?? undefined;

    const tokens: ResendTokens = {
      apiKey,
      name,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetResendConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        name,
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
 * POST /connections/resend/test
 */
export async function handleResendTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Resend not connected" }),
    };
  }
  try {
    const connector = getResendConnector();
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
 * DELETE /connections/resend
 */
export function handleResendDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetResendConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
