import crypto from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { connectorRedirectUri } from "./connectorRedirectUri.js";
import { safeOAuthErrorCode } from "./oauthError.js";
import { readSecret } from "./secrets.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

const SCOPES = ["https://www.googleapis.com/auth/documents.readonly"];
const REDIRECT_URI = connectorRedirectUri("google-docs");
const DOCS_API = "https://docs.googleapis.com";

function getTokenPath() {
  const dir =
    process.env.PATCHWORK_TOKEN_DIR ??
    path.join(homedir(), ".patchwork", "tokens");
  return path.join(dir, "google-docs.json");
}

export interface DocsTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
  email?: string;
  connected_at: string;
  _client_id?: string;
  _client_secret?: string;
}

export interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected" | "needs_reauth";
  lastSync?: string;
  email?: string;
}

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
  redirect?: string;
}

/**
 * Normalized error categories returned by Google Docs API.
 * Mirrors the Drive/Calendar cluster's error-classification posture.
 */
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

export function normalizeError(status: number, body: string): NormalizedError {
  if (status === 401) {
    return {
      kind: "auth_expired",
      status,
      message: body || "Authentication expired",
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      kind: "permission_denied",
      status,
      message: body || "Permission denied (scope may be too narrow)",
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      kind: "not_found",
      status,
      message: body || "Document not found",
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limited",
      status,
      message: body || "Rate limited",
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      kind: "provider_error",
      status,
      message: body || "Provider error",
      retryable: true,
    };
  }
  return {
    kind: "unknown_error",
    status,
    message: body || `HTTP ${status}`,
    retryable: false,
  };
}

function clientId(): string {
  return readSecret("GOOGLE_DOCS_CLIENT_ID");
}

function clientSecret(): string {
  return readSecret("GOOGLE_DOCS_CLIENT_SECRET");
}

function isConfigured(): boolean {
  return Boolean(clientId() && clientSecret());
}

export function loadTokens(): DocsTokens | null {
  const secureTokens = getSecretJsonSync<DocsTokens>("google-docs");
  if (secureTokens) return secureTokens;

  const tokenPath = getTokenPath();
  if (!existsSync(tokenPath)) return null;
  try {
    const tokens = JSON.parse(readFileSync(tokenPath, "utf-8")) as DocsTokens;
    saveTokens(tokens);
    return tokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: DocsTokens): void {
  storeSecretJsonSync("google-docs", tokens);
  const tokenPath = getTokenPath();
  if (existsSync(tokenPath)) {
    try {
      unlinkSync(tokenPath);
    } catch {}
  }
}

function deleteTokens(): void {
  deleteSecretJsonSync("google-docs");
  const tokenPath = getTokenPath();
  if (existsSync(tokenPath)) {
    try {
      unlinkSync(tokenPath);
    } catch {}
  }
}

export function getStatus(): ConnectorStatus {
  const tokens = loadTokens();
  if (!tokens) return { id: "google-docs", status: "disconnected" };
  const expired = !tokens.expiry_date || Date.now() > tokens.expiry_date;
  const hasCredentials = Boolean(
    (readSecret("GOOGLE_DOCS_CLIENT_ID") || tokens._client_id) &&
      (readSecret("GOOGLE_DOCS_CLIENT_SECRET") || tokens._client_secret),
  );
  const canRefresh = Boolean(tokens.refresh_token) && hasCredentials;
  const status = expired && !canRefresh ? "needs_reauth" : "connected";
  return {
    id: "google-docs",
    status,
    lastSync: tokens.connected_at,
    email: tokens.email,
  };
}

function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode(
  code: string,
): Promise<Omit<DocsTokens, "connected_at">> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
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
    throw new Error(
      `Token exchange failed: ${res.status} (${safeOAuthErrorCode(body)})`,
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expiry_date: json.expires_in
      ? Date.now() + json.expires_in * 1000
      : undefined,
    token_type: json.token_type,
    scope: json.scope,
    _client_id: clientId() || undefined,
    _client_secret: clientSecret() || undefined,
  };
}

async function refreshAccessToken(tokens: DocsTokens): Promise<DocsTokens> {
  if (!tokens.refresh_token) throw new Error("No refresh token available");
  const id = clientId() || tokens._client_id || "";
  const secret = clientSecret() || tokens._client_secret || "";
  if (!id || !secret)
    throw new Error(
      "Google Docs client credentials not available — reconnect the Google Docs connector",
    );
  const res = await fetch("https://oauth2.googleapis.com/token", {
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
    throw new Error(
      `Token refresh failed: ${res.status} (${safeOAuthErrorCode(body)})`,
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    token_type?: string;
  };
  const updated: DocsTokens = {
    ...tokens,
    access_token: json.access_token,
    expiry_date: json.expires_in
      ? Date.now() + json.expires_in * 1000
      : tokens.expiry_date,
  };
  saveTokens(updated);
  return updated;
}

/**
 * In-flight refresh promise. Prevents concurrent expired-token callers from
 * both burning the same refresh token (Google rotates on use).
 */
let refreshInflight: Promise<DocsTokens> | null = null;

export async function getValidAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (!tokens) throw new Error("Google Docs not connected");
  const bufferMs = 60_000;
  if (!tokens.expiry_date || Date.now() > tokens.expiry_date - bufferMs) {
    if (!refreshInflight) {
      refreshInflight = (async () => {
        try {
          return await refreshAccessToken(tokens as DocsTokens);
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
  await fetch(
    `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
    { method: "POST" },
  ).catch(() => {});
}

/** Extract a Doc ID from a Google Docs URL or pass-through a bare ID. */
export function extractDocumentId(urlOrId: string): string {
  const match = /\/document\/d\/([a-zA-Z0-9_-]+)/.exec(urlOrId);
  return match ? (match[1] as string) : urlOrId;
}

// ── Document types (subset of the Docs API response we care about) ───────────

export interface DocsTextRun {
  content?: string;
  textStyle?: Record<string, unknown>;
}

export interface DocsParagraphElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: DocsTextRun;
}

export interface DocsParagraph {
  elements?: DocsParagraphElement[];
  paragraphStyle?: Record<string, unknown>;
}

export interface DocsStructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: DocsParagraph;
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{ content?: DocsStructuralElement[] }>;
    }>;
  };
  sectionBreak?: Record<string, unknown>;
  tableOfContents?: { content?: DocsStructuralElement[] };
}

export interface DocsDocument {
  documentId: string;
  title?: string;
  body?: { content?: DocsStructuralElement[] };
  headers?: Record<string, { content?: DocsStructuralElement[] }>;
  footers?: Record<string, { content?: DocsStructuralElement[] }>;
  revisionId?: string;
}

/**
 * Authenticated GET against a Docs API endpoint. Refreshes on 401 exactly
 * once and retries the original request. Other non-2xx → throws with the
 * normalized error message.
 */
async function docsGet(
  endpoint: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<unknown> {
  const doOnce = async (token: string): Promise<Response> =>
    fetchFn(`${DOCS_API}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  let token = await getValidAccessToken();
  let res = await doOnce(token);
  if (res.status === 401) {
    // Force a refresh by clearing expiry on disk, then retry once.
    const tokens = loadTokens();
    if (tokens?.refresh_token) {
      const refreshed = await refreshAccessToken({
        ...tokens,
        expiry_date: 0,
      });
      token = refreshed.access_token;
      res = await doOnce(token);
    }
  }
  if (!res.ok) {
    const body = await res.text();
    const norm = normalizeError(res.status, body.slice(0, 200));
    throw new Error(`Google Docs API error ${norm.status}: ${norm.message}`);
  }
  return res.json();
}

/**
 * Fetch the structured document tree by ID. Returns the raw Docs API
 * response (body + headers + footers + styles).
 */
export async function getDocument(
  documentId: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<DocsDocument> {
  const id = extractDocumentId(documentId);
  return (await docsGet(
    `/v1/documents/${encodeURIComponent(id)}`,
    fetchFn,
  )) as DocsDocument;
}

/**
 * Walk a list of StructuralElements and emit their text. Recurses into
 * tables and table-of-contents entries.
 */
function extractTextFromElements(elements: DocsStructuralElement[]): string {
  const parts: string[] = [];
  for (const el of elements) {
    if (el.paragraph?.elements) {
      for (const pe of el.paragraph.elements) {
        const text = pe.textRun?.content;
        if (typeof text === "string") parts.push(text);
      }
    }
    if (el.table?.tableRows) {
      for (const row of el.table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          if (cell.content) parts.push(extractTextFromElements(cell.content));
        }
      }
    }
    if (el.tableOfContents?.content) {
      parts.push(extractTextFromElements(el.tableOfContents.content));
    }
  }
  return parts.join("");
}

/**
 * Convenience helper: fetch the doc and return a flat plain-text string
 * by walking the body's StructuralElement[] and extracting text from
 * paragraph.elements[].textRun.content.
 */
export async function getDocumentText(
  documentId: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<string> {
  const doc = await getDocument(documentId, fetchFn);
  const content = doc.body?.content ?? [];
  return extractTextFromElements(content);
}

import { createOAuthStateStore } from "./oauthStateStore.js";

const pendingStates = createOAuthStateStore({ namespace: "googleDocs" });

function generateState(): string {
  const state = crypto.randomBytes(32).toString("hex");
  if (!pendingStates.add(state)) {
    throw new Error(
      "OAuth state store full — too many concurrent authorize requests",
    );
  }
  return state;
}

export function handleDocsAuthRedirect(): ConnectorHandlerResult {
  if (!isConfigured()) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error:
          "GOOGLE_DOCS_CLIENT_ID and GOOGLE_DOCS_CLIENT_SECRET env vars not set",
      }),
    };
  }
  const state = generateState();
  return { status: 302, body: "", redirect: buildAuthUrl(state) };
}

export async function handleDocsCallback(
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
    const tokens: DocsTokens = {
      ...oauthTokens,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
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

/**
 * Health check: verifies the stored access token is still valid by
 * issuing a tokeninfo introspection call (same shape Drive/Calendar
 * cluster use elsewhere). Returns ok=true with email on success.
 */
export async function handleDocsTest(): Promise<ConnectorHandlerResult> {
  try {
    const accessToken = await getValidAccessToken();
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
    );
    if (!res.ok) throw new Error(`Token introspection error ${res.status}`);
    const json = (await res.json()) as { email?: string; scope?: string };
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, email: json.email, scope: json.scope }),
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

export async function handleDocsDisconnect(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (tokens?.access_token) await revokeToken(tokens.access_token);
  deleteTokens();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
