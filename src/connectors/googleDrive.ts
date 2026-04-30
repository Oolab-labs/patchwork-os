import crypto from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];
const REDIRECT_URI = process.env.PATCHWORK_DASHBOARD_URL
  ? `${process.env.PATCHWORK_DASHBOARD_URL}/connections/google-drive/callback`
  : "http://localhost:3200/dashboard/connections/google-drive/callback";

function getTokenPath() {
  const dir =
    process.env.PATCHWORK_TOKEN_DIR ??
    path.join(homedir(), ".patchwork", "tokens");
  return path.join(dir, "google-drive.json");
}

export interface DriveTokens {
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

function clientId(): string {
  return process.env.GOOGLE_DRIVE_CLIENT_ID ?? "";
}

function clientSecret(): string {
  return process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "";
}

function isConfigured(): boolean {
  return Boolean(clientId() && clientSecret());
}

export function loadTokens(): DriveTokens | null {
  const secureTokens = getSecretJsonSync<DriveTokens>("google-drive");
  if (secureTokens) return secureTokens;

  const tokenPath = getTokenPath();
  if (!existsSync(tokenPath)) return null;
  try {
    const tokens = JSON.parse(readFileSync(tokenPath, "utf-8")) as DriveTokens;
    saveTokens(tokens);
    return tokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: DriveTokens): void {
  storeSecretJsonSync("google-drive", tokens);
  const tokenPath = getTokenPath();
  if (existsSync(tokenPath)) {
    try {
      unlinkSync(tokenPath);
    } catch {}
  }
}

function deleteTokens(): void {
  deleteSecretJsonSync("google-drive");
  const tokenPath = getTokenPath();
  if (existsSync(tokenPath)) {
    try {
      unlinkSync(tokenPath);
    } catch {}
  }
}

export function getStatus(): ConnectorStatus {
  const tokens = loadTokens();
  if (!tokens) return { id: "google-drive", status: "disconnected" };
  const expired = !tokens.expiry_date || Date.now() > tokens.expiry_date;
  const hasCredentials = Boolean(
    (process.env.GOOGLE_DRIVE_CLIENT_ID || tokens._client_id) &&
      (process.env.GOOGLE_DRIVE_CLIENT_SECRET || tokens._client_secret),
  );
  const canRefresh = Boolean(tokens.refresh_token) && hasCredentials;
  const status = expired && !canRefresh ? "needs_reauth" : "connected";
  return {
    id: "google-drive",
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
): Promise<Omit<DriveTokens, "connected_at">> {
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
    const body = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${body}`);
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

async function refreshAccessToken(tokens: DriveTokens): Promise<DriveTokens> {
  if (!tokens.refresh_token) throw new Error("No refresh token available");
  const id = clientId() || tokens._client_id || "";
  const secret = clientSecret() || tokens._client_secret || "";
  if (!id || !secret)
    throw new Error(
      "Google Drive client credentials not available — reconnect the Google Drive connector",
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
    const body = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    token_type?: string;
  };
  const updated: DriveTokens = {
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
let refreshInflight: Promise<DriveTokens> | null = null;

export async function getValidAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (!tokens) throw new Error("Google Drive not connected");
  const bufferMs = 60_000;
  if (!tokens.expiry_date || Date.now() > tokens.expiry_date - bufferMs) {
    if (!refreshInflight) {
      refreshInflight = (async () => {
        try {
          return await refreshAccessToken(tokens as DriveTokens);
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

export function extractFileId(urlOrId: string): string {
  const match = /\/d\/([a-zA-Z0-9_-]+)/.exec(urlOrId);
  return match ? (match[1] as string) : urlOrId;
}

const MAX_CONTENT_BYTES = 50 * 1024;

export async function fetchDocContent(
  urlOrId: string,
  accessToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<string> {
  const fileId = extractFileId(urlOrId);
  // Prefer Markdown export so downstream parsers (e.g. meetingNotes.parse)
  // see real `###` headings and `- [ ] task` bullets instead of the lossy
  // text/plain export, which collapses headings into bare lines and renders
  // checkboxes as Unicode glyphs that the parser doesn't strip. Fall back
  // to text/plain for older docs / accounts where Markdown export is
  // unavailable so we never return empty content unnecessarily.
  const tryExport = async (mime: string): Promise<string | null> => {
    try {
      const res = await fetchFn(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mime)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) return null;
      const text = await res.text();
      return text.length > MAX_CONTENT_BYTES
        ? text.slice(0, MAX_CONTENT_BYTES)
        : text;
    } catch {
      return null;
    }
  };

  const md = await tryExport("text/markdown");
  if (md && md.trim().length > 0) return md;
  const plain = await tryExport("text/plain");
  return plain ?? "";
}

/** Fetch the Drive file's display name. Returns "" on failure. */
export async function fetchDocName(
  urlOrId: string,
  accessToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<string> {
  const fileId = extractFileId(urlOrId);
  try {
    const res = await fetchFn(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return "";
    const data = (await res.json()) as { name?: string };
    return data.name ?? "";
  } catch {
    return "";
  }
}

const pendingStates = new Set<string>();

function generateState(): string {
  const state = crypto.randomBytes(32).toString("hex");
  pendingStates.add(state);
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000);
  return state;
}

export function handleDriveAuthRedirect(): ConnectorHandlerResult {
  if (!isConfigured()) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error:
          "GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET env vars not set",
      }),
    };
  }
  const state = generateState();
  return { status: 302, body: "", redirect: buildAuthUrl(state) };
}

export async function handleDriveCallback(
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
  if (!code || !state || !pendingStates.has(state)) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid OAuth state" }),
    };
  }
  pendingStates.delete(state);
  try {
    const oauthTokens = await exchangeCode(code);
    const tokens: DriveTokens = {
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

export async function handleDriveTest(): Promise<ConnectorHandlerResult> {
  try {
    const accessToken = await getValidAccessToken();
    const res = await fetch(
      "https://www.googleapis.com/drive/v3/about?fields=user",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) throw new Error(`Drive API error ${res.status}`);
    const json = (await res.json()) as { user?: { emailAddress?: string } };
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, email: json.user?.emailAddress }),
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

export async function handleDriveDisconnect(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (tokens?.access_token) await revokeToken(tokens.access_token);
  deleteTokens();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
