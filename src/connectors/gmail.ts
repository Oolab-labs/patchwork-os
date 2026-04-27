/**
 * Gmail OAuth 2.0 connector.
 *
 * Handles:
 *   GET  /connections/gmail/auth      — redirect to Google consent screen
 *   GET  /connections/gmail/callback  — exchange code for tokens, store locally
 *   POST /connections/gmail/test      — verify stored token works
 *   DELETE /connections/gmail         — revoke + delete stored token
 *   GET  /connections                 — list connector statuses
 *
 * Tokens stored at ~/.patchwork/tokens/gmail.json (mode 0600, never leaves machine).
 * Client credentials read from env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET.
 */

import crypto from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const REDIRECT_URI = `http://localhost:${process.env.PATCHWORK_BRIDGE_PORT ?? "3101"}/connections/gmail/callback`;
function getTokenPath() {
  const dir =
    process.env.PATCHWORK_TOKEN_DIR ??
    path.join(homedir(), ".patchwork", "tokens");
  return path.join(dir, "gmail.json");
}

export interface GmailTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
  /** Stored at auth time so refresh works even if env vars are absent. */
  _client_id?: string;
  _client_secret?: string;
}

export interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected" | "needs_reauth";
  lastSync?: string;
  email?: string;
}

function clientId(): string {
  return process.env.GMAIL_CLIENT_ID ?? "";
}

function clientSecret(): string {
  return process.env.GMAIL_CLIENT_SECRET ?? "";
}

function isConfigured(): boolean {
  return Boolean(clientId() && clientSecret());
}

// ── Token storage ─────────────────────────────────────────────────────────────

export function loadTokens(): GmailTokens | null {
  const secureTokens = getSecretJsonSync<GmailTokens>("gmail");
  if (secureTokens) {
    return secureTokens;
  }

  const tokenPath = getTokenPath();
  if (!existsSync(tokenPath)) return null;
  try {
    const tokens = JSON.parse(readFileSync(tokenPath, "utf-8")) as GmailTokens;
    saveTokens(tokens);
    return tokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: GmailTokens): void {
  storeSecretJsonSync("gmail", tokens);

  const tokenPath = getTokenPath();
  if (existsSync(tokenPath)) {
    try {
      unlinkSync(tokenPath);
    } catch {}
  }
}

function deleteTokens(): void {
  deleteSecretJsonSync("gmail");

  const tokenPath = getTokenPath();
  if (existsSync(tokenPath)) {
    try {
      unlinkSync(tokenPath);
    } catch {}
  }
}

// ── OAuth helpers ─────────────────────────────────────────────────────────────

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

async function exchangeCode(code: string): Promise<GmailTokens> {
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

async function refreshAccessToken(tokens: GmailTokens): Promise<GmailTokens> {
  if (!tokens.refresh_token) throw new Error("No refresh token available");
  const id = clientId() || tokens._client_id || "";
  const secret = clientSecret() || tokens._client_secret || "";
  if (!id || !secret)
    throw new Error(
      "Gmail client credentials not available — reconnect the Gmail connector",
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
  const updated: GmailTokens = {
    ...tokens,
    access_token: json.access_token,
    expiry_date: json.expires_in
      ? Date.now() + json.expires_in * 1000
      : tokens.expiry_date,
  };
  saveTokens(updated);
  return updated;
}

/** Returns a valid access token, refreshing if needed. */
export async function getValidAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (!tokens) throw new Error("Gmail not connected");
  const bufferMs = 60_000;
  if (!tokens.expiry_date || Date.now() > tokens.expiry_date - bufferMs) {
    tokens = await refreshAccessToken(tokens);
  }
  return tokens.access_token;
}

async function revokeToken(token: string): Promise<void> {
  await fetch(
    `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
    { method: "POST" },
  ).catch(() => {});
}

async function fetchUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return "";
  const json = (await res.json()) as { emailAddress?: string };
  return json.emailAddress ?? "";
}

// ── State map (in-memory CSRF protection) ────────────────────────────────────

const pendingStates = new Set<string>();

function generateState(): string {
  const state = crypto.randomBytes(32).toString("hex");
  pendingStates.add(state);
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000); // 10 min TTL
  return state;
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
  redirect?: string;
}

function gmailStatus(tokens: GmailTokens | null): ConnectorStatus["status"] {
  if (!tokens) return "disconnected";
  const expired = !tokens.expiry_date || Date.now() > tokens.expiry_date;
  const hasCredentials = Boolean(
    (process.env.GMAIL_CLIENT_ID || tokens._client_id) &&
      (process.env.GMAIL_CLIENT_SECRET || tokens._client_secret),
  );
  const canRefresh = Boolean(tokens.refresh_token) && hasCredentials;
  return expired && !canRefresh ? "needs_reauth" : "connected";
}

export async function handleConnectionsList(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  const { getStatus: getGitHubStatus } = await import("./github.js");
  const { getStatus: getSentryStatus } = await import("./sentry.js");
  const { getStatus: getLinearStatus } = await import("./linear.js");
  const { getStatus: getCalendarStatus } = await import("./googleCalendar.js");
  const { isConnected: isSlackConnected, getProfile: getSlackProfile } =
    await import("./slack.js");
  const gh = getGitHubStatus();
  const sentry = getSentryStatus();
  const linear = getLinearStatus();
  const calendar = getCalendarStatus();
  const slackConnected = isSlackConnected();
  const slackProfile = getSlackProfile();

  // Token-paste connectors expose loadTokens() which returns null when
  // no credentials are stored. Probe each one so the dashboard reflects
  // their actual state instead of always-disconnected.
  const tokenPasteProbes = [
    { id: "notion", mod: () => import("./notion.js") },
    { id: "confluence", mod: () => import("./confluence.js") },
    { id: "datadog", mod: () => import("./datadog.js") },
    { id: "hubspot", mod: () => import("./hubspot.js") },
    { id: "intercom", mod: () => import("./intercom.js") },
    { id: "stripe", mod: () => import("./stripe.js") },
    { id: "zendesk", mod: () => import("./zendesk.js") },
    { id: "jira", mod: () => import("./jira.js") },
  ] as const;
  const tokenPasteStatuses = await Promise.all(
    tokenPasteProbes.map(async (probe) => {
      try {
        const m = (await probe.mod()) as { loadTokens?: () => unknown };
        const connected = m.loadTokens ? m.loadTokens() !== null : false;
        return {
          id: probe.id,
          status: connected
            ? ("connected" as const)
            : ("disconnected" as const),
          lastSync: connected ? new Date().toISOString() : undefined,
        };
      } catch {
        return {
          id: probe.id,
          status: "disconnected" as const,
          lastSync: undefined,
        };
      }
    }),
  );

  const connectors: ConnectorStatus[] = [
    {
      id: "gmail",
      status: gmailStatus(tokens),
      lastSync: tokens ? new Date().toISOString() : undefined,
    },
    {
      id: "github",
      status: gh.connected ? "connected" : "disconnected",
      lastSync: gh.connected ? new Date().toISOString() : undefined,
    },
    {
      id: "sentry",
      status: sentry.status,
      lastSync: sentry.lastSync,
    },
    {
      id: "linear",
      status: linear.status,
      lastSync: linear.lastSync,
    },
    {
      id: "google-calendar",
      status: calendar.status,
      lastSync: calendar.lastSync,
    },
    {
      id: "slack",
      status: slackConnected ? "connected" : "disconnected",
      lastSync:
        slackConnected && slackProfile ? new Date().toISOString() : undefined,
    },
    ...tokenPasteStatuses,
  ];
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ connectors }),
  };
}

export function handleGmailAuthRedirect(): ConnectorHandlerResult {
  if (!isConfigured()) {
    return {
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error:
          "Gmail connector not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET.",
      }),
    };
  }
  const state = generateState();
  const url = buildAuthUrl(state);
  return { status: 302, redirect: url, body: "" };
}

export async function handleGmailCallback(
  code: string | null,
  state: string | null,
  error: string | null,
): Promise<ConnectorHandlerResult> {
  if (error) {
    return {
      status: 400,
      contentType: "text/html",
      body: callbackHtml(
        "Connection cancelled",
        `Google returned: ${error}`,
        false,
      ),
    };
  }
  if (!code || !state || !pendingStates.has(state)) {
    return {
      status: 400,
      contentType: "text/html",
      body: callbackHtml("Invalid request", "Missing or expired state.", false),
    };
  }
  pendingStates.delete(state);
  try {
    const tokens = await exchangeCode(code);
    saveTokens(tokens);
    const email = await fetchUserEmail(tokens.access_token);
    return {
      status: 200,
      contentType: "text/html",
      body: callbackHtml(
        "Gmail connected",
        `Connected${email ? ` as ${email}` : ""}. You can close this tab.`,
        true,
      ),
    };
  } catch (err) {
    return {
      status: 500,
      contentType: "text/html",
      body: callbackHtml(
        "Connection failed",
        err instanceof Error ? err.message : String(err),
        false,
      ),
    };
  }
}

export async function handleGmailTest(): Promise<ConnectorHandlerResult> {
  try {
    const token = await getValidAccessToken();
    const email = await fetchUserEmail(token);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, email }),
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

export async function handleGmailDisconnect(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (tokens?.access_token) {
    await revokeToken(tokens.access_token);
  }
  deleteTokens();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}

// ── Callback HTML ─────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function callbackHtml(
  title: string,
  message: string,
  success: boolean,
): string {
  const color = success ? "#b8ff57" : "#ff5555";
  const t = escHtml(title);
  const m = escHtml(message);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${t} — Patchwork OS</title>
<style>
  body { background: #040406; color: #e0e0e0; font-family: system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #0d0d14; border: 1px solid #1e1e2e; border-radius: 8px;
    padding: 40px 48px; max-width: 420px; text-align: center; }
  h1 { color: ${color}; font-size: 1.4rem; margin-bottom: 12px; }
  p { color: #888; line-height: 1.6; }
  a { color: ${color}; text-decoration: none; font-size: 0.9rem; }
</style>
</head>
<body><div class="card">
  <h1>${t}</h1>
  <p>${m}</p>
  <br><a href="javascript:window.close()">Close this tab</a>
</div>
<script>
  // Notify the opener tab that auth completed so it can poll.
  if (window.opener) { try { window.opener.postMessage('patchwork:gmail:connected', 'http://localhost:3100'); } catch(_) {} }
</script>
</body></html>`;
}
