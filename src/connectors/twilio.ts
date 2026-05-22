/**
 * Twilio connector — SMS + account access via the Twilio REST API (2010-04-01).
 *
 * Auth: HTTP Basic where username=Account SID (AC...), password=Auth Token.
 *   - Env vars: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (+ optional TWILIO_DEFAULT_FROM)
 *   - Stored: getSecretJsonSync("twilio") → TwilioTokens
 *
 * Tools: sendSms, listMessages, getMessage, listPhoneNumbers, getAccountBalance
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

export interface TwilioTokens {
  accountSid: string; // AC...
  authToken: string;
  defaultFrom?: string;
  friendlyName?: string;
  connected_at: string;
}

export interface TwilioMessage {
  sid: string;
  account_sid: string;
  to: string;
  from: string;
  body: string;
  status: string;
  direction: string;
  date_sent: string | null;
  date_created: string;
  date_updated: string;
  price: string | null;
  price_unit: string | null;
  error_code: number | null;
  error_message: string | null;
  num_segments: string;
  num_media: string;
  uri: string;
}

export interface TwilioMessageListResult {
  messages: TwilioMessage[];
  page: number;
  page_size: number;
  next_page_uri: string | null;
}

export interface TwilioPhoneNumber {
  sid: string;
  account_sid: string;
  phone_number: string;
  friendly_name: string;
  capabilities: { voice?: boolean; sms?: boolean; mms?: boolean };
  date_created: string;
}

export interface TwilioPhoneNumberListResult {
  incoming_phone_numbers: TwilioPhoneNumber[];
  page: number;
  page_size: number;
  next_page_uri: string | null;
}

export interface TwilioBalance {
  account_sid: string;
  balance: string;
  currency: string;
}

const BASE_URL = "https://api.twilio.com";
const E164_RE = /^\+\d{8,15}$/;

export class TwilioConnector extends BaseConnector {
  readonly providerName = "twilio";
  private tokens: TwilioTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Twilio not connected. Run: patchwork-os connect twilio or set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN",
      );
    }
    this.tokens = tokens;
    return {
      token: tokens.authToken,
      scopes: ["read", "write"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const tokens = this.tokens ?? loadTokens();
      if (!tokens) {
        return {
          ok: false,
          error: {
            code: "auth_expired",
            message: "Twilio not connected",
            retryable: false,
          },
        };
      }
      this.tokens = tokens;
      const result = await this.apiCall(async () => {
        const res = await fetch(
          `${BASE_URL}/2010-04-01/Accounts/${tokens.accountSid}.json`,
          { headers: this.buildHeaders() },
        );
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
          message: "Twilio authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect twilio",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Twilio permissions",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Twilio resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Twilio API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Twilio API error: HTTP ${s}`,
        retryable: s >= 500,
      };
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      "message" in error &&
      typeof (error as { message: unknown }).message === "string"
    ) {
      // Twilio JSON error shape: { code, message, status, more_info }
      const e = error as { code: unknown; message: string; status?: number };
      const s = typeof e.status === "number" ? e.status : 0;
      if (s === 401)
        return {
          code: "auth_expired",
          message: `Twilio auth failed: ${e.message}`,
          retryable: false,
          suggestedAction: "patchwork-os connect twilio",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: `Twilio: ${e.message}`,
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: `Twilio: ${e.message}`,
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: `Twilio: ${e.message}`,
          retryable: true,
        };
      return {
        code: "provider_error",
        message: `Twilio [${e.code}]: ${e.message}`,
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
          message: `Cannot connect to Twilio: ${error.message}`,
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
      id: "twilio",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.friendlyName
        ? `Twilio: ${tokens.friendlyName}`
        : tokens?.accountSid
          ? `Twilio account ${tokens.accountSid}`
          : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async sendSms(params: {
    to: string;
    body: string;
    from?: string;
  }): Promise<TwilioMessage> {
    if (!params.to || !E164_RE.test(params.to)) {
      throw new Error(
        `Invalid 'to' phone number: must be E.164 format (e.g. +14155551234), got: ${params.to}`,
      );
    }
    if (!params.body) {
      throw new Error("sendSms: 'body' is required");
    }
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("Twilio not connected");
    this.tokens = tokens;
    const from = params.from ?? tokens.defaultFrom;
    if (!from) {
      throw new Error(
        "sendSms: no 'from' number provided and no defaultFrom configured",
      );
    }
    if (!E164_RE.test(from)) {
      throw new Error(
        `Invalid 'from' phone number: must be E.164 format, got: ${from}`,
      );
    }
    const formBody = new URLSearchParams();
    formBody.set("To", params.to);
    formBody.set("From", from);
    formBody.set("Body", params.body);

    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/2010-04-01/Accounts/${tokens.accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            ...this.buildHeaders(),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formBody.toString(),
        },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<TwilioMessage>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as TwilioMessage;
  }

  async listMessages(
    params: {
      to?: string;
      from?: string;
      dateSent?: string;
      limit?: number;
    } = {},
  ): Promise<TwilioMessageListResult> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("Twilio not connected");
    this.tokens = tokens;
    const qs = new URLSearchParams();
    qs.set("PageSize", String(params.limit ?? 20));
    if (params.to) qs.set("To", params.to);
    if (params.from) qs.set("From", params.from);
    if (params.dateSent) qs.set("DateSent", params.dateSent);

    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/2010-04-01/Accounts/${tokens.accountSid}/Messages.json?${qs}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<TwilioMessageListResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as TwilioMessageListResult;
  }

  async getMessage(messageSid: string): Promise<TwilioMessage> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("Twilio not connected");
    this.tokens = tokens;
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/2010-04-01/Accounts/${tokens.accountSid}/Messages/${messageSid}.json`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<TwilioMessage>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as TwilioMessage;
  }

  async listPhoneNumbers(
    params: { limit?: number } = {},
  ): Promise<TwilioPhoneNumberListResult> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("Twilio not connected");
    this.tokens = tokens;
    const qs = new URLSearchParams();
    qs.set("PageSize", String(params.limit ?? 20));
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/2010-04-01/Accounts/${tokens.accountSid}/IncomingPhoneNumbers.json?${qs}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<TwilioPhoneNumberListResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as TwilioPhoneNumberListResult;
  }

  async getAccountBalance(): Promise<TwilioBalance> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("Twilio not connected");
    this.tokens = tokens;
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/2010-04-01/Accounts/${tokens.accountSid}/Balance.json`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<TwilioBalance>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as TwilioBalance;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const sid = this.tokens?.accountSid ?? "";
    const tok = this.tokens?.authToken ?? "";
    const basic = Buffer.from(`${sid}:${tok}`).toString("base64");
    return {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): TwilioTokens | null {
  const envSid = process.env.TWILIO_ACCOUNT_SID;
  const envTok = process.env.TWILIO_AUTH_TOKEN;
  if (envSid && envTok) {
    return {
      accountSid: envSid,
      authToken: envTok,
      defaultFrom: process.env.TWILIO_DEFAULT_FROM,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<TwilioTokens>("twilio");
}

export function saveTokens(tokens: TwilioTokens): void {
  storeSecretJsonSync("twilio", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("twilio");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: TwilioConnector | null = null;

function resetTwilioConnector(): void {
  _instance = null;
}

export function getTwilioConnector(): TwilioConnector {
  if (!_instance) {
    _instance = new TwilioConnector();
  }
  return _instance;
}

export { getTwilioConnector as twilio };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/twilio/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/twilio/connect  { accountSid, authToken, defaultFrom? }
 */
export async function handleTwilioConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let accountSid: string;
  let authToken: string;
  let defaultFrom: string | undefined;

  try {
    const parsed = JSON.parse(body) as {
      accountSid?: unknown;
      authToken?: unknown;
      defaultFrom?: unknown;
    };
    if (typeof parsed.accountSid !== "string" || !parsed.accountSid) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "accountSid is required" }),
      };
    }
    if (typeof parsed.authToken !== "string" || !parsed.authToken) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "authToken is required" }),
      };
    }
    if (!parsed.accountSid.startsWith("AC")) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "accountSid must start with 'AC'",
        }),
      };
    }
    accountSid = parsed.accountSid;
    authToken = parsed.authToken;
    if (typeof parsed.defaultFrom === "string" && parsed.defaultFrom) {
      if (!E164_RE.test(parsed.defaultFrom)) {
        return {
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: "defaultFrom must be E.164 format (e.g. +14155551234)",
          }),
        };
      }
      defaultFrom = parsed.defaultFrom;
    }
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const res = await fetch(
      `${BASE_URL}/2010-04-01/Accounts/${accountSid}.json`,
      {
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Twilio (HTTP ${res.status}) — check accountSid + authToken`,
        }),
      };
    }
    const account = (await res.json()) as {
      sid?: string;
      friendly_name?: string;
    };

    const friendlyName = account.friendly_name ?? undefined;
    const sid = account.sid ?? accountSid;

    const tokens: TwilioTokens = {
      accountSid: sid,
      authToken,
      defaultFrom,
      friendlyName,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetTwilioConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        accountSid: sid,
        friendlyName,
        defaultFrom,
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
 * POST /connections/twilio/test
 */
export async function handleTwilioTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Twilio not connected" }),
    };
  }
  try {
    const connector = getTwilioConnector();
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
 * DELETE /connections/twilio
 */
export function handleTwilioDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetTwilioConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
