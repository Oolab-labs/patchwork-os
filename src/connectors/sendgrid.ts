/**
 * SendGrid connector — outbound transactional email via SendGrid v3 REST API.
 *
 * Auth: Bearer API key (`SG.*`).
 *   - Env var: SENDGRID_API_KEY (+ optional SENDGRID_FROM_EMAIL)
 *   - Stored: getSecretJsonSync("sendgrid") → SendGridTokens
 *
 * Tools: send, listTemplates, getTemplate, listSenders, getStats
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

export interface SendGridTokens {
  apiKey: string; // SG.xxxx
  fromEmail?: string;
  accountName?: string;
  connected_at: string;
}

export interface SendGridTemplate {
  id: string;
  name: string;
  generation: "legacy" | "dynamic";
  updated_at?: string;
}

export interface SendGridTemplateListResult {
  result: SendGridTemplate[];
}

export interface SendGridVerifiedSender {
  id: number;
  from_email: string;
  from_name?: string;
  verified: boolean;
}

export interface SendGridSenderListResult {
  results: SendGridVerifiedSender[];
}

export interface SendGridStatsBucket {
  date: string;
  stats: Array<{
    metrics: Record<string, number>;
    name?: string;
    type?: string;
  }>;
}

export interface SendGridSendResult {
  messageId: string;
}

const BASE_URL = "https://api.sendgrid.com";

// Loose RFC 5322-ish email check — good enough to reject obvious garbage.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(s: unknown): s is string {
  return typeof s === "string" && EMAIL_RE.test(s);
}

export class SendGridConnector extends BaseConnector {
  readonly providerName = "sendgrid";
  private tokens: SendGridTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "SendGrid not connected. Run: patchwork-os connect sendgrid or set SENDGRID_API_KEY",
      );
    }
    this.tokens = tokens;
    return {
      token: tokens.apiKey,
      scopes: ["mail.send"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async () => {
        const res = await fetch(`${BASE_URL}/v3/scopes`, {
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
          message: "SendGrid authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect sendgrid",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient SendGrid permissions",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "SendGrid resource not found",
          retryable: false,
        };
      if (s === 413)
        return {
          code: "provider_error",
          message: "SendGrid payload too large",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "SendGrid API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      if (s >= 500)
        return {
          code: "provider_error",
          message: `SendGrid API error: HTTP ${s}`,
          retryable: true,
        };
      return {
        code: "provider_error",
        message: `SendGrid API error: HTTP ${s}`,
        retryable: false,
      };
    }
    if (error instanceof Error) {
      if (
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ECONNREFUSED")
      ) {
        return {
          code: "network_error",
          message: `Cannot connect to SendGrid: ${error.message}`,
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
      id: "sendgrid",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.accountName
        ? `SendGrid (${tokens.accountName})`
        : tokens?.fromEmail
          ? `SendGrid <${tokens.fromEmail}>`
          : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async send(params: {
    to: string;
    subject: string;
    text?: string;
    html?: string;
    from?: string;
  }): Promise<SendGridSendResult> {
    if (!isValidEmail(params.to)) {
      throw new Error("send: `to` must be a valid email address");
    }
    if (typeof params.subject !== "string" || !params.subject.trim()) {
      throw new Error("send: `subject` is required");
    }
    if (!params.text && !params.html) {
      throw new Error("send: one of `text` or `html` is required");
    }
    const tokens = this.tokens ?? loadTokens();
    const from = params.from ?? tokens?.fromEmail;
    if (!from) {
      throw new Error(
        "send: no `from` provided and no fromEmail stored — pass `from` or reconnect with a verified sender",
      );
    }
    if (!isValidEmail(from)) {
      throw new Error("send: `from` must be a valid email address");
    }

    const content: Array<{ type: string; value: string }> = [];
    if (params.text) content.push({ type: "text/plain", value: params.text });
    if (params.html) content.push({ type: "text/html", value: params.html });

    const body = {
      personalizations: [{ to: [{ email: params.to }] }],
      from: { email: from },
      subject: params.subject,
      content,
    };

    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/v3/mail/send`, {
        method: "POST",
        headers: {
          ...this.buildHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw res;
      // SendGrid returns 202 + X-Message-Id header on success, empty body.
      const messageId = res.headers.get("x-message-id") ?? "";
      return { messageId };
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async listTemplates(
    params: { limit?: number; generations?: "legacy" | "dynamic" } = {},
  ): Promise<SendGridTemplateListResult> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (params.limit) qs.set("page_size", String(params.limit));
      if (params.generations) qs.set("generations", params.generations);
      const url = `${BASE_URL}/v3/templates${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      return res.json() as Promise<SendGridTemplateListResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async getTemplate(templateId: string): Promise<SendGridTemplate> {
    if (!templateId || typeof templateId !== "string") {
      throw new Error("getTemplate: templateId is required");
    }
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/v3/templates/${encodeURIComponent(templateId)}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<SendGridTemplate>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async listSenders(
    params: { limit?: number } = {},
  ): Promise<SendGridSenderListResult> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (params.limit) qs.set("limit", String(params.limit));
      const url = `${BASE_URL}/v3/verified_senders${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      return res.json() as Promise<SendGridSenderListResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async getStats(params: {
    startDate: string;
    endDate?: string;
    aggregatedBy?: "day" | "week" | "month";
  }): Promise<SendGridStatsBucket[]> {
    if (!params.startDate) {
      throw new Error("getStats: startDate is required (YYYY-MM-DD)");
    }
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      qs.set("start_date", params.startDate);
      if (params.endDate) qs.set("end_date", params.endDate);
      if (params.aggregatedBy) qs.set("aggregated_by", params.aggregatedBy);
      const res = await fetch(`${BASE_URL}/v3/stats?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<SendGridStatsBucket[]>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const key = this.tokens?.apiKey ?? loadTokens()?.apiKey ?? "";
    return {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): SendGridTokens | null {
  const envKey = process.env.SENDGRID_API_KEY;
  if (envKey) {
    return {
      apiKey: envKey,
      fromEmail: process.env.SENDGRID_FROM_EMAIL,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<SendGridTokens>("sendgrid");
}

export function saveTokens(tokens: SendGridTokens): void {
  storeSecretJsonSync("sendgrid", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("sendgrid");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: SendGridConnector | null = null;

function resetSendGridConnector(): void {
  _instance = null;
}

export function getSendGridConnector(): SendGridConnector {
  if (!_instance) {
    _instance = new SendGridConnector();
  }
  return _instance;
}

export { getSendGridConnector as sendgrid };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/connectorRoutes.ts under /connections/sendgrid/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/sendgrid/connect  { apiKey, fromEmail? }
 */
export async function handleSendGridConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let apiKey: string;
  let fromEmail: string | undefined;

  try {
    const parsed = JSON.parse(body) as {
      apiKey?: unknown;
      fromEmail?: unknown;
    };
    if (typeof parsed.apiKey !== "string" || !parsed.apiKey) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "apiKey is required" }),
      };
    }
    apiKey = parsed.apiKey;
    if (parsed.fromEmail !== undefined) {
      if (
        typeof parsed.fromEmail !== "string" ||
        !isValidEmail(parsed.fromEmail)
      ) {
        return {
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: "fromEmail must be a valid email address",
          }),
        };
      }
      fromEmail = parsed.fromEmail;
    }
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const res = await fetch(`${BASE_URL}/v3/user/profile`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by SendGrid (HTTP ${res.status}) — check apiKey`,
        }),
      };
    }
    const profile = (await res.json()) as {
      username?: string;
      email?: string;
    };

    const accountName = profile.username ?? undefined;

    const tokens: SendGridTokens = {
      apiKey,
      fromEmail,
      accountName,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetSendGridConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        accountName,
        fromEmail,
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
 * POST /connections/sendgrid/test
 */
export async function handleSendGridTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "SendGrid not connected" }),
    };
  }
  try {
    const connector = getSendGridConnector();
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
 * DELETE /connections/sendgrid
 */
export function handleSendGridDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetSendGridConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
