/**
 * Airtable connector — record access via the Airtable REST API v0.
 *
 * Auth: Personal Access Token (PAT) or OAuth 2.0.
 *   PAT: `Authorization: Bearer <pat>`. PATs start with `pat...`.
 *     - Env var: AIRTABLE_ACCESS_TOKEN
 *     - Stored: getSecretJsonSync("airtable") → AirtableTokens
 *   OAuth 2.0:
 *     - Env vars: AIRTABLE_CLIENT_ID, AIRTABLE_CLIENT_SECRET
 *     - Token endpoint: https://airtable.com/oauth2/v1/token (HTTP Basic auth)
 *     - Stored: getSecretJsonSync("airtable") → AirtableOAuthTokens
 *
 * Tools: listBases, getBaseSchema, listRecords, getRecord, createRecord,
 *   updateRecord, listWebhooks, createWebhook, deleteWebhook,
 *   getWebhookPayloads, refreshWebhook.
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 */

import crypto from "node:crypto";
import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
  type OAuthConfig,
} from "./baseConnector.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

export interface AirtableTokens {
  accessToken: string; // pat...
  userId?: string;
  email?: string;
  connected_at: string;
}

/** OAuth 2.0 token set — stored when connector is authorized via OAuth flow. */
export interface AirtableOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO timestamp
  scopes: string[];
  connected_at: string;
  /** OAuth tokens are identified by this flag vs PAT tokens */
  _oauth: true;
}

// ── Webhook interfaces ───────────────────────────────────────────────────────

export interface AirtableWebhook {
  id: string;
  type?: string;
  isHookEnabled: boolean;
  notificationUrl?: string | null;
  cursorForNextPayload?: number;
  areNotificationsEnabled?: boolean;
  expirationTime?: string | null;
  specification?: {
    options?: {
      filters?: {
        fromSources?: string[];
        dataTypes?: string[];
        changeTypes?: string[];
      };
    };
  };
}

export interface AirtableWebhookCreateResult {
  id: string;
  macSecretBase64: string;
  expirationTime?: string | null;
}

export interface AirtableWebhookPayload {
  timestamp: string;
  baseTransactionNumber: number;
  actionMetadata?: {
    source: string;
    sourceMetadata?: Record<string, unknown>;
  };
  createdTablesById?: Record<string, unknown>;
  destroyedTableIds?: string[];
  changedTablesById?: Record<string, unknown>;
}

export interface AirtableWebhookPayloadsResult {
  payloads: AirtableWebhookPayload[];
  cursor: number;
  mightHaveMore: boolean;
}

export interface AirtableBase {
  id: string;
  name: string;
  permissionLevel?: string;
}

export interface AirtableField {
  id: string;
  name: string;
  type: string;
  description?: string;
  options?: Record<string, unknown>;
}

export interface AirtableTable {
  id: string;
  name: string;
  primaryFieldId?: string;
  description?: string;
  fields: AirtableField[];
}

export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface AirtableListBasesResult {
  bases: AirtableBase[];
  offset?: string;
}

export interface AirtableSchemaResult {
  tables: AirtableTable[];
}

export interface AirtableListRecordsResult {
  records: AirtableRecord[];
  offset?: string;
}

export interface AirtableListRecordsParams {
  filterByFormula?: string;
  sort?: Array<{ field: string; direction?: "asc" | "desc" }>;
  view?: string;
  fields?: string[];
  maxRecords?: number;
  pageSize?: number;
}

const BASE_URL = "https://api.airtable.com";
const OAUTH_TOKEN_ENDPOINT = "https://airtable.com/oauth2/v1/token";
const OAUTH_SCOPES = [
  "data.records:read",
  "data.records:write",
  "schema.bases:read",
  "webhook:manage",
];
const MAX_RECORDS_HARD_CAP = 1000;

export class AirtableConnector extends BaseConnector {
  readonly providerName = "airtable";
  private tokens: AirtableTokens | null = null;

  protected getOAuthConfig(): OAuthConfig | null {
    const clientId = process.env.AIRTABLE_CLIENT_ID;
    if (!clientId) return null;
    return {
      clientId,
      clientSecret: process.env.AIRTABLE_CLIENT_SECRET,
      tokenEndpoint: OAUTH_TOKEN_ENDPOINT,
      scopes: OAUTH_SCOPES,
    };
  }

  async authenticate(): Promise<AuthContext> {
    const raw = loadRawTokens();
    if (!raw) {
      throw new Error(
        "Airtable not connected. Run: patchwork-os connect airtable or set AIRTABLE_ACCESS_TOKEN",
      );
    }

    if (isOAuthTokens(raw)) {
      // OAuth path — may auto-refresh if expired
      const expiresAt = new Date(raw.expiresAt);
      const bufferMs = 5 * 60 * 1000;
      if (Date.now() > expiresAt.getTime() - bufferMs && raw.refreshToken) {
        const refreshed = await this._oauthRefresh(raw);
        if (refreshed) {
          return {
            token: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: new Date(refreshed.expiresAt),
            scopes: refreshed.scopes,
          };
        }
      }
      return {
        token: raw.accessToken,
        refreshToken: raw.refreshToken,
        expiresAt: new Date(raw.expiresAt),
        scopes: raw.scopes,
      };
    }

    // PAT path
    this.tokens = raw as AirtableTokens;
    return {
      token: raw.accessToken,
      scopes: ["read", "write"],
    };
  }

  /**
   * Override base refreshToken() to use HTTP Basic auth for Airtable's token
   * endpoint (clientId:clientSecret as Basic auth instead of body params).
   */
  protected override async refreshToken(): Promise<AuthContext | null> {
    const raw = loadRawTokens();
    if (!raw || !isOAuthTokens(raw) || !raw.refreshToken) return null;

    const config = this.getOAuthConfig();
    if (!config?.clientSecret) return null;

    const refreshed = await this._oauthRefresh(raw);
    if (!refreshed) return null;

    return {
      token: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: new Date(refreshed.expiresAt),
      scopes: refreshed.scopes,
    };
  }

  /**
   * Perform the actual Airtable OAuth token refresh using HTTP Basic auth.
   * Airtable requires clientId:clientSecret as Basic auth on the token endpoint.
   */
  private async _oauthRefresh(
    tokens: AirtableOAuthTokens,
  ): Promise<AirtableOAuthTokens | null> {
    const clientId = process.env.AIRTABLE_CLIENT_ID ?? "";
    const clientSecret = process.env.AIRTABLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;

    const basicCreds = Buffer.from(`${clientId}:${clientSecret}`).toString(
      "base64",
    );

    let response: Response;
    try {
      response = await fetch(OAUTH_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basicCreds}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
        }).toString(),
      });
    } catch {
      return null;
    }

    if (!response.ok) {
      return null;
    }

    let data: {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      scope?: unknown;
    };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      return null;
    }

    if (typeof data.access_token !== "string" || !data.access_token) {
      return null;
    }

    const expiresIn =
      typeof data.expires_in === "number" && data.expires_in > 0
        ? data.expires_in
        : 3600;

    const updated: AirtableOAuthTokens = {
      ...tokens,
      accessToken: data.access_token,
      refreshToken:
        typeof data.refresh_token === "string" && data.refresh_token
          ? data.refresh_token
          : tokens.refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      scopes:
        typeof data.scope === "string" ? data.scope.split(" ") : tokens.scopes,
    };

    saveOAuthTokens(updated);
    return updated;
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async () => {
        const res = await fetch(`${BASE_URL}/v0/meta/whoami`, {
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
          message: "Airtable authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect airtable",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Airtable permissions for this base/table",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Airtable resource not found",
          retryable: false,
        };
      if (s === 422)
        return {
          code: "provider_error",
          message: "Airtable validation error (invalid fields or formula)",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Airtable API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Airtable API error: HTTP ${s}`,
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
          message: `Cannot connect to Airtable: ${error.message}`,
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
    const raw = loadRawTokens();
    if (!raw) {
      return { id: "airtable", status: "disconnected" };
    }
    if (isOAuthTokens(raw)) {
      return {
        id: "airtable",
        status: "connected",
        lastSync: raw.connected_at,
      };
    }
    const tokens = raw as AirtableTokens;
    return {
      id: "airtable",
      status: "connected",
      lastSync: tokens.connected_at,
      workspace: tokens.email
        ? `Airtable (${tokens.email})`
        : tokens.userId
          ? `Airtable user ${tokens.userId}`
          : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async listBases(): Promise<AirtableListBasesResult> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/v0/meta/bases`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<AirtableListBasesResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableListBasesResult;
  }

  async getBaseSchema(baseId: string): Promise<AirtableSchemaResult> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/v0/meta/bases/${encodeURIComponent(baseId)}/tables`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<AirtableSchemaResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableSchemaResult;
  }

  async listRecords(
    baseId: string,
    tableIdOrName: string,
    params: AirtableListRecordsParams = {},
  ): Promise<AirtableListRecordsResult> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (params.filterByFormula)
        qs.set("filterByFormula", params.filterByFormula);
      if (params.view) qs.set("view", params.view);
      if (params.pageSize) qs.set("pageSize", String(params.pageSize));

      // Cap maxRecords at Airtable's 1000 hard limit. Default 100.
      const maxRecords = Math.min(
        params.maxRecords ?? 100,
        MAX_RECORDS_HARD_CAP,
      );
      qs.set("maxRecords", String(maxRecords));

      if (params.sort) {
        params.sort.forEach((s, i) => {
          qs.set(`sort[${i}][field]`, s.field);
          if (s.direction) qs.set(`sort[${i}][direction]`, s.direction);
        });
      }
      if (params.fields) {
        for (const f of params.fields) qs.append("fields[]", f);
      }

      const url = `${BASE_URL}/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}?${qs}`;
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      return res.json() as Promise<AirtableListRecordsResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableListRecordsResult;
  }

  async getRecord(
    baseId: string,
    tableIdOrName: string,
    recordId: string,
  ): Promise<AirtableRecord> {
    const result = await this.apiCall(async () => {
      const url = `${BASE_URL}/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}/${encodeURIComponent(recordId)}`;
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      return res.json() as Promise<AirtableRecord>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableRecord;
  }

  async createRecord(
    baseId: string,
    tableIdOrName: string,
    fields: Record<string, unknown>,
  ): Promise<AirtableRecord> {
    const result = await this.apiCall(async () => {
      const url = `${BASE_URL}/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...this.buildHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: [{ fields }] }),
      });
      if (!res.ok) throw res;
      const json = (await res.json()) as { records: AirtableRecord[] };
      const first = json.records?.[0];
      if (!first) throw new Error("Airtable returned no record in response");
      return first;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableRecord;
  }

  async updateRecord(
    baseId: string,
    tableIdOrName: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<AirtableRecord> {
    const result = await this.apiCall(async () => {
      const url = `${BASE_URL}/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}/${encodeURIComponent(recordId)}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          ...this.buildHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<AirtableRecord>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableRecord;
  }

  // ── Webhook Methods ────────────────────────────────────────────────────────

  /** GET /v0/bases/{baseId}/webhooks */
  async listWebhooks(baseId: string): Promise<AirtableWebhook[]> {
    const result = await this.apiCall(async () => {
      const url = `${BASE_URL}/v0/bases/${encodeURIComponent(baseId)}/webhooks`;
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      const json = (await res.json()) as { webhooks: AirtableWebhook[] };
      return json.webhooks ?? [];
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableWebhook[];
  }

  /**
   * POST /v0/bases/{baseId}/webhooks
   * Creates a webhook. Returns the webhook id, HMAC secret (base64), and
   * expiration time. Store macSecretBase64 securely — it is only returned once.
   */
  async createWebhook(
    baseId: string,
    notificationUrl: string,
    specification?: {
      filters?: {
        fromSources?: string[];
        dataTypes?: string[];
        changeTypes?: string[];
      };
    },
  ): Promise<AirtableWebhookCreateResult> {
    const result = await this.apiCall(async () => {
      const url = `${BASE_URL}/v0/bases/${encodeURIComponent(baseId)}/webhooks`;
      const body = {
        notificationUrl,
        specification: {
          filters: specification?.filters ?? {
            fromSources: ["client"],
            dataTypes: ["tableData", "tableFields", "tableMetadata"],
            changeTypes: ["add", "update", "remove"],
          },
        },
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { ...this.buildHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<AirtableWebhookCreateResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableWebhookCreateResult;
  }

  /** DELETE /v0/bases/{baseId}/webhooks/{webhookId} */
  async deleteWebhook(baseId: string, webhookId: string): Promise<void> {
    const result = await this.apiCall(async () => {
      const url = `${BASE_URL}/v0/bases/${encodeURIComponent(baseId)}/webhooks/${encodeURIComponent(webhookId)}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return undefined;
    });
    if ("error" in result) throw new Error(result.error.message);
  }

  /**
   * GET /v0/bases/{baseId}/webhooks/{webhookId}/payloads
   * Retrieves queued payloads for a webhook. Pass cursor from previous call
   * to page through results.
   */
  async getWebhookPayloads(
    baseId: string,
    webhookId: string,
    cursor?: number,
  ): Promise<AirtableWebhookPayloadsResult> {
    const result = await this.apiCall(async () => {
      const qs = cursor != null ? `?cursor=${cursor}` : "";
      const url = `${BASE_URL}/v0/bases/${encodeURIComponent(baseId)}/webhooks/${encodeURIComponent(webhookId)}/payloads${qs}`;
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      return res.json() as Promise<AirtableWebhookPayloadsResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableWebhookPayloadsResult;
  }

  /**
   * POST /v0/bases/{baseId}/webhooks/{webhookId}/refresh
   * Extends the webhook expiry by 7 days from now.
   */
  async refreshWebhook(baseId: string, webhookId: string): Promise<void> {
    const result = await this.apiCall(async () => {
      const url = `${BASE_URL}/v0/bases/${encodeURIComponent(baseId)}/webhooks/${encodeURIComponent(webhookId)}/refresh`;
      const res = await fetch(url, {
        method: "POST",
        headers: { ...this.buildHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw res;
      return undefined;
    });
    if ("error" in result) throw new Error(result.error.message);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    // Prefer the in-memory auth token (set after authenticate()), then fall
    // back to reading directly from storage for callers that haven't gone
    // through the full authenticate() flow (e.g. healthCheck).
    const token =
      this.auth?.token ??
      this.tokens?.accessToken ??
      loadRawTokens()?.accessToken ??
      "";
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

/** Discriminator for OAuth vs PAT token blobs. */
function isOAuthTokens(
  raw: AirtableTokens | AirtableOAuthTokens,
): raw is AirtableOAuthTokens {
  return (raw as AirtableOAuthTokens)._oauth === true;
}

/**
 * Load raw token blob from env / storage. Returns either AirtableTokens (PAT)
 * or AirtableOAuthTokens (OAuth), or null when not connected.
 *
 * Priority:
 *   1. AIRTABLE_ACCESS_TOKEN env var → synthetic PAT tokens
 *   2. Stored token blob (may be PAT or OAuth)
 */
export function loadRawTokens(): AirtableTokens | AirtableOAuthTokens | null {
  const envKey = process.env.AIRTABLE_ACCESS_TOKEN;
  if (envKey) {
    return {
      accessToken: envKey,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<AirtableTokens | AirtableOAuthTokens>("airtable");
}

/**
 * loadTokens returns PAT tokens for backward compatibility with existing code
 * that expects AirtableTokens. Returns null for OAuth-only connections.
 */
export function loadTokens(): AirtableTokens | null {
  const raw = loadRawTokens();
  if (!raw) return null;
  if (isOAuthTokens(raw)) {
    // Return a minimal AirtableTokens shape for backward-compat callers that
    // only need the accessToken (e.g. getStatus, healthCheck).
    return {
      accessToken: raw.accessToken,
      connected_at: raw.connected_at,
    };
  }
  return raw as AirtableTokens;
}

export function saveTokens(tokens: AirtableTokens): void {
  storeSecretJsonSync("airtable", tokens);
}

export function saveOAuthTokens(tokens: AirtableOAuthTokens): void {
  storeSecretJsonSync("airtable", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("airtable");
  } catch {
    // ignore
  }
}

// ── Webhook verification ─────────────────────────────────────────────────────

/**
 * Verify an incoming Airtable webhook request.
 *
 * Airtable signs webhook payloads with HMAC-SHA256 using the macSecretBase64
 * returned at webhook creation time. The signature is hex-encoded and sent in
 * the `X-Airtable-Content-MAC` header. The raw body (before JSON parsing) is
 * used as the message.
 *
 * Additionally, `X-Airtable-Client-Secret` should equal the base64-decoded
 * mac secret (raw bytes as a Latin-1/binary string) — but in practice most
 * integrations only check the HMAC signature. This helper validates both.
 *
 * @param rawBody - Raw request body as a Buffer or string
 * @param hmacHeader - Value of the `X-Airtable-Content-MAC` header (hex)
 * @param macSecretBase64 - The macSecretBase64 returned by createWebhook()
 * @returns true if the signature is valid
 */
export function verifyAirtableWebhook(
  rawBody: Buffer | string,
  hmacHeader: string,
  macSecretBase64: string,
): boolean {
  const secret = Buffer.from(macSecretBase64, "base64");
  const body =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf-8") : rawBody;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  // Constant-time compare to prevent timing attacks
  try {
    const expectedBuf = Buffer.from(expected, "utf-8");
    const actualBuf = Buffer.from(hmacHeader, "utf-8");
    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: AirtableConnector | null = null;

function resetAirtableConnector(): void {
  _instance = null;
}

export function getAirtableConnector(): AirtableConnector {
  if (!_instance) {
    _instance = new AirtableConnector();
  }
  return _instance;
}

export { getAirtableConnector as airtable };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/airtable/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/airtable/connect  { accessToken }
 */
export async function handleAirtableConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let accessToken: string;

  try {
    const parsed = JSON.parse(body) as { accessToken?: unknown };
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "accessToken is required" }),
      };
    }
    accessToken = parsed.accessToken;
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const res = await fetch(`${BASE_URL}/v0/meta/whoami`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Airtable (HTTP ${res.status}) — check accessToken`,
        }),
      };
    }
    const who = (await res.json()) as { id?: string; email?: string };

    const userId = who.id ?? undefined;
    const email = who.email ?? undefined;

    const tokens: AirtableTokens = {
      accessToken,
      userId,
      email,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetAirtableConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        userId,
        email,
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
 * POST /connections/airtable/test
 */
export async function handleAirtableTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Airtable not connected" }),
    };
  }
  try {
    const connector = getAirtableConnector();
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
 * DELETE /connections/airtable
 */
export function handleAirtableDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetAirtableConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
