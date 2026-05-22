/**
 * Salesforce OAuth 2.0 connector.
 *
 * Handles:
 *   GET    /connections/salesforce/auth      — redirect to Salesforce login consent
 *   GET    /connections/salesforce/callback  — exchange code → tokens (captures instance_url)
 *   POST   /connections/salesforce/test      — health check against /services/data/<v>/
 *   DELETE /connections/salesforce           — revoke + delete stored token
 *
 * Multi-tenant nuance:
 *   Salesforce is multi-tenant. Each org has a unique `https://your-org.my.salesforce.com`
 *   base URL returned in the token response as `instance_url`. This value MUST be
 *   persisted in the tokens file — every subsequent API call uses it as the base URL.
 *   The login host (login.salesforce.com vs test.salesforce.com) is configurable via
 *   SALESFORCE_LOGIN_HOST so sandbox orgs can flip the front-door host without code
 *   changes; the instance_url returned from the token endpoint determines where
 *   data API calls go.
 *
 * Tokens stored at ~/.patchwork/tokens/salesforce.json (mode 0600).
 * Client credentials read from env: SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET.
 */

import crypto from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { connectorRedirectUri } from "./connectorRedirectUri.js";
import { createOAuthStateStore } from "./oauthStateStore.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

// `api`           — REST/SOAP/Bulk surface
// `refresh_token` — issue a refresh_token grant
// `offline_access` — keep the refresh_token valid while user is offline
const SCOPES = ["api", "refresh_token", "offline_access"];
const REDIRECT_URI = connectorRedirectUri("salesforce");
const API_VERSION = "v59.0";
const DEFAULT_LOGIN_HOST = "login.salesforce.com";

function loginHost(): string {
  const raw = process.env.SALESFORCE_LOGIN_HOST?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_LOGIN_HOST;
}

function authBase(): string {
  return `https://${loginHost()}`;
}

function getTokenPath() {
  const dir =
    process.env.PATCHWORK_TOKEN_DIR ??
    path.join(homedir(), ".patchwork", "tokens");
  return path.join(dir, "salesforce.json");
}

export interface SalesforceTokens {
  access_token: string;
  refresh_token?: string;
  /** Salesforce-specific. Org-unique base URL (`https://<org>.my.salesforce.com`). */
  instance_url: string;
  /** Identity URL — points to the user identity service for the connected user. */
  id?: string;
  token_type?: string;
  scope?: string;
  /** Salesforce returns `issued_at` as ms-epoch string; expiry isn't included. */
  issued_at?: string;
  /** Optional. We compute and persist this for getStatus() expiry heuristics. */
  expiry_date?: number;
  /** Captured identity profile fields (best-effort from the `id` endpoint). */
  username?: string;
  display_name?: string;
  organization_id?: string;
  connected_at?: string;
  /** Stored at auth time so refresh works even if env vars are absent. */
  _client_id?: string;
  _client_secret?: string;
  /** Pinned login host at auth time (sandbox vs prod). */
  _login_host?: string;
}

export interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected" | "needs_reauth";
  lastSync?: string;
  username?: string;
  instanceUrl?: string;
}

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
  redirect?: string;
}

/** Normalized error categories returned by the Salesforce REST API. */
export type NormalizedErrorKind =
  | "auth_expired"
  | "permission_denied"
  | "not_found"
  | "rate_limited"
  | "provider_error"
  | "unknown_error";

export interface NormalizedError {
  kind: NormalizedErrorKind;
  status: number;
  message: string;
  retryable: boolean;
}

/**
 * Salesforce returns errors as `[{ message, errorCode }]` arrays for most
 * REST endpoints. Pull `errorCode` into the message so the caller can route
 * on it (most importantly, distinguish INVALID_SESSION_ID — the canonical
 * 401 signal — from a 401 caused by some upstream gateway).
 */
export function normalizeError(status: number, body: string): NormalizedError {
  let errorCode = "";
  let message = body;
  if (body) {
    try {
      const parsed = JSON.parse(body);
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first && typeof first === "object") {
        const ec = (first as { errorCode?: unknown }).errorCode;
        const msg = (first as { message?: unknown }).message;
        if (typeof ec === "string") errorCode = ec;
        if (typeof msg === "string") message = msg;
      }
    } catch {
      // body wasn't JSON — fall back to raw text
    }
  }
  const prefixed = errorCode ? `${errorCode}: ${message}` : message;
  if (status === 401) {
    return {
      kind: "auth_expired",
      status,
      message: prefixed || "Authentication expired (INVALID_SESSION_ID)",
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      kind: "permission_denied",
      status,
      message: prefixed || "Permission denied",
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      kind: "not_found",
      status,
      message: prefixed || "Resource not found",
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limited",
      status,
      message: prefixed || "Rate limited",
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      kind: "provider_error",
      status,
      message: prefixed || "Salesforce provider error",
      retryable: true,
    };
  }
  return {
    kind: "unknown_error",
    status,
    message: prefixed || `HTTP ${status}`,
    retryable: false,
  };
}

function clientId(): string {
  return process.env.SALESFORCE_CLIENT_ID ?? "";
}

function clientSecret(): string {
  return process.env.SALESFORCE_CLIENT_SECRET ?? "";
}

function isConfigured(): boolean {
  return Boolean(clientId() && clientSecret());
}

// ── Token storage ────────────────────────────────────────────────────────────

export function loadTokens(): SalesforceTokens | null {
  const secureTokens = getSecretJsonSync<SalesforceTokens>("salesforce");
  if (secureTokens) return secureTokens;

  const tokenPath = getTokenPath();
  if (!existsSync(tokenPath)) return null;
  try {
    const tokens = JSON.parse(
      readFileSync(tokenPath, "utf-8"),
    ) as SalesforceTokens;
    saveTokens(tokens);
    return tokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: SalesforceTokens): void {
  storeSecretJsonSync("salesforce", tokens);
  const tokenPath = getTokenPath();
  if (existsSync(tokenPath)) {
    try {
      unlinkSync(tokenPath);
    } catch {}
  }
}

function deleteTokens(): void {
  deleteSecretJsonSync("salesforce");
  const tokenPath = getTokenPath();
  if (existsSync(tokenPath)) {
    try {
      unlinkSync(tokenPath);
    } catch {}
  }
}

export function getStatus(): ConnectorStatus {
  const tokens = loadTokens();
  if (!tokens) return { id: "salesforce", status: "disconnected" };
  // Salesforce doesn't return expires_in on the standard web-server flow —
  // session timeout is a per-org policy setting. Treat the presence of a
  // refresh_token + client creds as "we can recover" → connected; otherwise
  // we can only mark needs_reauth on a confirmed 401.
  const hasCredentials = Boolean(
    (process.env.SALESFORCE_CLIENT_ID || tokens._client_id) &&
      (process.env.SALESFORCE_CLIENT_SECRET || tokens._client_secret),
  );
  const canRefresh = Boolean(tokens.refresh_token) && hasCredentials;
  const expired = tokens.expiry_date ? Date.now() > tokens.expiry_date : false;
  const status: ConnectorStatus["status"] =
    expired && !canRefresh ? "needs_reauth" : "connected";
  return {
    id: "salesforce",
    status,
    lastSync: tokens.connected_at,
    username: tokens.username,
    instanceUrl: tokens.instance_url,
  };
}

// ── OAuth helpers ────────────────────────────────────────────────────────────

function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
  });
  return `${authBase()}/services/oauth2/authorize?${params.toString()}`;
}

interface SalesforceTokenResponse {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  id?: string;
  token_type?: string;
  scope?: string;
  issued_at?: string;
  signature?: string;
}

async function exchangeCode(code: string): Promise<SalesforceTokens> {
  const host = loginHost();
  const res = await fetch(`https://${host}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let errCode = "unknown";
    try {
      errCode = (JSON.parse(body) as { error?: string }).error ?? "unknown";
    } catch {}
    throw new Error(`Token exchange failed: ${res.status} (${errCode})`);
  }
  const json = (await res.json()) as SalesforceTokenResponse;
  if (!json.instance_url) {
    // Without instance_url every subsequent call is undirected — fail loud.
    throw new Error("Salesforce token response missing instance_url");
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    instance_url: json.instance_url,
    id: json.id,
    token_type: json.token_type,
    scope: json.scope,
    issued_at: json.issued_at,
    _client_id: clientId() || undefined,
    _client_secret: clientSecret() || undefined,
    _login_host: host,
  };
}

async function refreshAccessToken(
  tokens: SalesforceTokens,
): Promise<SalesforceTokens> {
  if (!tokens.refresh_token) throw new Error("No refresh token available");
  const id = clientId() || tokens._client_id || "";
  const secret = clientSecret() || tokens._client_secret || "";
  if (!id || !secret) {
    throw new Error(
      "Salesforce client credentials not available — reconnect the Salesforce connector",
    );
  }
  // Refresh against the host the user originally authed to (prod vs sandbox).
  const host = tokens._login_host || loginHost();
  const res = await fetch(`https://${host}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: id,
      client_secret: secret,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let errCode = "unknown";
    try {
      errCode = (JSON.parse(body) as { error?: string }).error ?? "unknown";
    } catch {}
    throw new Error(`Token refresh failed: ${res.status} (${errCode})`);
  }
  const json = (await res.json()) as Partial<SalesforceTokenResponse>;
  const updated: SalesforceTokens = {
    ...tokens,
    access_token: json.access_token ?? tokens.access_token,
    // Some Salesforce refresh responses re-emit instance_url; preserve the
    // existing one if not — instance never changes for a given user/org.
    instance_url: json.instance_url ?? tokens.instance_url,
    issued_at: json.issued_at ?? tokens.issued_at,
  };
  saveTokens(updated);
  return updated;
}

/**
 * Single-flight refresh promise. Prevents concurrent expired-token callers
 * from POSTing to the token endpoint in parallel and racing each other's
 * refresh token rotation.
 */
let refreshInflight: Promise<SalesforceTokens> | null = null;

export async function getValidAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (!tokens) throw new Error("Salesforce not connected");
  // Salesforce doesn't surface expires_in; we rely on the 401-driven refresh
  // path in `sfRequest` below. But if a caller stashed an explicit expiry,
  // honour it with a 60s buffer.
  const bufferMs = 60_000;
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - bufferMs) {
    if (!refreshInflight) {
      refreshInflight = (async () => {
        try {
          return await refreshAccessToken(tokens as SalesforceTokens);
        } finally {
          refreshInflight = null;
        }
      })();
    }
    tokens = await refreshInflight;
  }
  return tokens.access_token;
}

async function revokeToken(token: string): Promise<void> {
  const host = loadTokens()?._login_host || loginHost();
  await fetch(
    `https://${host}/services/oauth2/revoke?token=${encodeURIComponent(token)}`,
    { method: "POST" },
  ).catch(() => {});
}

/**
 * Fetch the connected user's identity from the `id` URL Salesforce returned
 * with the token response. Used to populate `username` / `display_name` /
 * `organization_id` on the stored token blob (best-effort).
 */
async function fetchIdentity(
  idUrl: string,
  accessToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<{
  username?: string;
  display_name?: string;
  organization_id?: string;
}> {
  try {
    const res = await fetchFn(idUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return {};
    const json = (await res.json()) as {
      username?: string;
      display_name?: string;
      organization_id?: string;
    };
    return {
      username: json.username,
      display_name: json.display_name,
      organization_id: json.organization_id,
    };
  } catch {
    return {};
  }
}

// ── Authenticated request helper (refresh-on-401) ────────────────────────────

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  fetchFn?: typeof fetch;
}

/**
 * Core authenticated request against `<instance_url>/services/data/<v>/<endpoint>`.
 * Mirrors gmail.ts pattern: on 401, refresh once and retry. Throws a normalized
 * error message for every non-2xx.
 */
async function sfRequest(
  endpoint: string,
  opts: RequestOptions = {},
): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const method = opts.method ?? "GET";
  const tokens = loadTokens();
  if (!tokens) throw new Error("Salesforce not connected");
  const url = `${tokens.instance_url}/services/data/${API_VERSION}${endpoint}`;

  const headersFor = (token: string): Record<string, string> => {
    const h: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (opts.body !== undefined) h["Content-Type"] = "application/json";
    return h;
  };

  const doOnce = async (token: string): Promise<Response> =>
    fetchFn(url, {
      method,
      headers: headersFor(token),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let token = await getValidAccessToken();
  let res = await doOnce(token);
  if (res.status === 401) {
    const stored = loadTokens();
    if (stored?.refresh_token) {
      const refreshed = await refreshAccessToken({
        ...stored,
        expiry_date: 0,
      });
      token = refreshed.access_token;
      res = await doOnce(token);
    }
  }
  if (!res.ok) {
    const body = await res.text();
    const norm = normalizeError(res.status, body.slice(0, 500));
    throw new Error(`Salesforce API error ${norm.status}: ${norm.message}`);
  }
  // DELETE returns 204 No Content
  if (res.status === 204) return {};
  return res.json();
}

// ── Public tools ─────────────────────────────────────────────────────────────

const SELECT_ONLY = /^\s*select\b/i;
const FIND_ONLY = /^\s*find\b/i;

export interface SoqlQueryResult {
  totalSize: number;
  done: boolean;
  records: Array<Record<string, unknown>>;
  nextRecordsUrl?: string;
}

/**
 * Execute a SOQL SELECT query. Hard-rejects any non-SELECT statement to keep
 * this surface read-only — Salesforce SOQL supports SELECT only by definition,
 * but defending against accidental DML-by-string-concat is cheap.
 *
 * Result cap defaults to 200 (Salesforce returns 2000 by default; narrowing
 * the page size prevents accidental org-scans from blowing the rate budget).
 */
export async function query(
  soql: string,
  opts: { limit?: number; fetchFn?: typeof fetch } = {},
): Promise<SoqlQueryResult> {
  if (typeof soql !== "string" || !SELECT_ONLY.test(soql)) {
    throw new Error("SOQL query must start with SELECT");
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 200));
  // Inject a LIMIT clause if the caller didn't supply one. SOQL is case
  // insensitive — match \blimit\b regardless of case.
  const hasLimit = /\blimit\b/i.test(soql);
  const final = hasLimit ? soql : `${soql.trim()} LIMIT ${limit}`;
  const endpoint = `/query?q=${encodeURIComponent(final)}`;
  return (await sfRequest(endpoint, {
    fetchFn: opts.fetchFn,
  })) as SoqlQueryResult;
}

export interface SoslSearchResult {
  searchRecords: Array<Record<string, unknown>>;
}

/**
 * Execute a SOSL search. Validates the first keyword is FIND so callers can't
 * smuggle a different verb in.
 */
export async function searchSosl(
  soslQuery: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<SoslSearchResult> {
  if (typeof soslQuery !== "string" || !FIND_ONLY.test(soslQuery)) {
    throw new Error("SOSL query must start with FIND");
  }
  const endpoint = `/search?q=${encodeURIComponent(soslQuery)}`;
  return (await sfRequest(endpoint, {
    fetchFn: opts.fetchFn,
  })) as SoslSearchResult;
}

function validateObjectName(objectName: string): void {
  // sObject API names are letters/digits/underscores. Reject anything else so
  // we can't be talked into traversing the path with `..` or whitespace.
  if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(objectName)) {
    throw new Error(`Invalid sObject name: ${objectName}`);
  }
}

function validateRecordId(recordId: string): void {
  // Salesforce IDs are 15 or 18 chars of [A-Za-z0-9].
  if (!/^[A-Za-z0-9]{15,18}$/.test(recordId)) {
    throw new Error(`Invalid record id: ${recordId}`);
  }
}

export async function getObject(
  objectName: string,
  recordId: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  validateObjectName(objectName);
  validateRecordId(recordId);
  const endpoint = `/sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}`;
  return (await sfRequest(endpoint, { fetchFn: opts.fetchFn })) as Record<
    string,
    unknown
  >;
}

export async function listObjects(
  opts: { fetchFn?: typeof fetch } = {},
): Promise<unknown> {
  return sfRequest(`/sobjects`, { fetchFn: opts.fetchFn });
}

export async function describeObject(
  objectName: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<unknown> {
  validateObjectName(objectName);
  const endpoint = `/sobjects/${encodeURIComponent(objectName)}/describe`;
  return sfRequest(endpoint, { fetchFn: opts.fetchFn });
}

export interface CreateRecordResult {
  id: string;
  success: boolean;
  errors: unknown[];
}

export async function createRecord(
  objectName: string,
  fields: Record<string, unknown>,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<CreateRecordResult> {
  validateObjectName(objectName);
  if (!fields || typeof fields !== "object")
    throw new Error("createRecord: fields must be an object");
  const endpoint = `/sobjects/${encodeURIComponent(objectName)}`;
  return (await sfRequest(endpoint, {
    method: "POST",
    body: fields,
    fetchFn: opts.fetchFn,
  })) as CreateRecordResult;
}

export async function updateRecord(
  objectName: string,
  recordId: string,
  fields: Record<string, unknown>,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<{ ok: true }> {
  validateObjectName(objectName);
  validateRecordId(recordId);
  if (!fields || typeof fields !== "object")
    throw new Error("updateRecord: fields must be an object");
  const endpoint = `/sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}`;
  await sfRequest(endpoint, {
    method: "PATCH",
    body: fields,
    fetchFn: opts.fetchFn,
  });
  return { ok: true };
}

/** Health check — hits the API version list endpoint, which is auth-required. */
export async function healthCheck(
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const tokens = loadTokens();
  if (!tokens) return { ok: false, status: 0, error: "Not connected" };
  try {
    const accessToken = await getValidAccessToken();
    const res = await fetchFn(
      `${tokens.instance_url}/services/data/${API_VERSION}/`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const norm = normalizeError(res.status, body.slice(0, 200));
      return { ok: false, status: res.status, error: norm.message };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── State store (CSRF) ───────────────────────────────────────────────────────

const pendingStates = createOAuthStateStore({ namespace: "salesforce" });

function generateState(): string {
  const state = crypto.randomBytes(32).toString("hex");
  if (!pendingStates.add(state)) {
    throw new Error(
      "OAuth state store full — too many concurrent authorize requests",
    );
  }
  return state;
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

export function handleSalesforceAuthRedirect(): ConnectorHandlerResult {
  if (!isConfigured()) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error:
          "SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET env vars not set",
      }),
    };
  }
  const state = generateState();
  return { status: 302, body: "", redirect: buildAuthUrl(state) };
}

export async function handleSalesforceCallback(
  code: string | null,
  state: string | null,
  error: string | null,
): Promise<ConnectorHandlerResult> {
  if (error) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error }),
    };
  }
  if (!code || !state || !pendingStates.consume(state)) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid OAuth state" }),
    };
  }
  try {
    const oauthTokens = await exchangeCode(code);
    // Identity lookup is best-effort. A failure here must not block the
    // connection — the user has a valid access token + instance_url already.
    let identity: {
      username?: string;
      display_name?: string;
      organization_id?: string;
    } = {};
    if (oauthTokens.id) {
      identity = await fetchIdentity(oauthTokens.id, oauthTokens.access_token);
    }
    const tokens: SalesforceTokens = {
      ...oauthTokens,
      ...identity,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        instance_url: tokens.instance_url,
        username: tokens.username,
      }),
    };
  } catch (err) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

export async function handleSalesforceTest(): Promise<ConnectorHandlerResult> {
  const result = await healthCheck();
  if (result.ok) {
    const tokens = loadTokens();
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        instance_url: tokens?.instance_url,
        username: tokens?.username,
      }),
    };
  }
  return {
    status: 400,
    contentType: "application/json",
    body: JSON.stringify({ ok: false, error: result.error }),
  };
}

export async function handleSalesforceDisconnect(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (tokens?.access_token) await revokeToken(tokens.access_token);
  deleteTokens();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
