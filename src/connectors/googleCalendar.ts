/**
 * Google Calendar OAuth 2.0 connector.
 *
 * Handles:
 *   GET  /connections/google-calendar/auth      — redirect to Google consent screen
 *   GET  /connections/google-calendar/callback  — exchange code for tokens, store locally
 *   POST /connections/google-calendar/test      — verify stored token works
 *   DELETE /connections/google-calendar         — revoke + delete stored token
 *
 * Tokens stored at ~/.patchwork/tokens/google-calendar.json (mode 0600).
 * Client credentials read from env: GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET
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

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const REDIRECT_URI = process.env.PATCHWORK_DASHBOARD_URL
  ? `${process.env.PATCHWORK_DASHBOARD_URL}/connections/google-calendar/callback`
  : "http://localhost:3200/connections/google-calendar/callback";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
function getTokenPath() {
  const dir =
    process.env.PATCHWORK_TOKEN_DIR ??
    path.join(homedir(), ".patchwork", "tokens");
  return path.join(dir, "google-calendar.json");
}

export interface CalendarTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
  calendar_id: string;
  connected_at: string;
  /** Stored at auth time so refresh works even if env vars are absent. */
  _client_id?: string;
  _client_secret?: string;
}

export interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected" | "needs_reauth";
  lastSync?: string;
  calendarId?: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  htmlLink: string;
  attendees?: string[];
}

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
  redirect?: string;
}

function clientId(): string {
  return process.env.GOOGLE_CALENDAR_CLIENT_ID ?? "";
}

function clientSecret(): string {
  return process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? "";
}

function isConfigured(): boolean {
  return Boolean(clientId() && clientSecret());
}

// ── Token storage ─────────────────────────────────────────────────────────────

export function loadTokens(): CalendarTokens | null {
  const secureTokens = getSecretJsonSync<CalendarTokens>("google-calendar");
  if (secureTokens) {
    return secureTokens;
  }

  const tokenPath = getTokenPath();
  if (!existsSync(tokenPath)) return null;
  try {
    const tokens = JSON.parse(
      readFileSync(tokenPath, "utf-8"),
    ) as CalendarTokens;
    saveTokens(tokens);
    return tokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: CalendarTokens): void {
  storeSecretJsonSync("google-calendar", tokens);

  const tokenPath = getTokenPath();
  if (existsSync(tokenPath)) {
    try {
      unlinkSync(tokenPath);
    } catch {}
  }
}

function deleteTokens(): void {
  deleteSecretJsonSync("google-calendar");

  const tokenPath = getTokenPath();
  if (existsSync(tokenPath)) {
    try {
      unlinkSync(tokenPath);
    } catch {}
  }
}

export function getStatus(): ConnectorStatus {
  const tokens = loadTokens();
  if (!tokens) return { id: "google-calendar", status: "disconnected" };
  const expired = !tokens.expiry_date || Date.now() > tokens.expiry_date;
  const hasCredentials = Boolean(
    (process.env.GOOGLE_CALENDAR_CLIENT_ID || tokens._client_id) &&
      (process.env.GOOGLE_CALENDAR_CLIENT_SECRET || tokens._client_secret),
  );
  const canRefresh = Boolean(tokens.refresh_token) && hasCredentials;
  const status = expired && !canRefresh ? "needs_reauth" : "connected";
  return {
    id: "google-calendar",
    status,
    lastSync: tokens.connected_at,
    calendarId: tokens.calendar_id,
  };
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

async function exchangeCode(
  code: string,
): Promise<Omit<CalendarTokens, "calendar_id" | "connected_at">> {
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
    let code = "unknown";
    try {
      code = (JSON.parse(body) as { error?: string }).error ?? "unknown";
    } catch {}
    throw new Error(`Token exchange failed: ${res.status} (${code})`);
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

async function refreshAccessToken(
  tokens: CalendarTokens,
): Promise<CalendarTokens> {
  if (!tokens.refresh_token) throw new Error("No refresh token available");
  const id = clientId() || tokens._client_id || "";
  const secret = clientSecret() || tokens._client_secret || "";
  if (!id || !secret)
    throw new Error(
      "Google Calendar client credentials not available — reconnect the Google Calendar connector",
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
    let code = "unknown";
    try {
      code = (JSON.parse(body) as { error?: string }).error ?? "unknown";
    } catch {}
    throw new Error(`Token refresh failed: ${res.status} (${code})`);
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    token_type?: string;
  };
  const updated: CalendarTokens = {
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
let refreshInflight: Promise<CalendarTokens> | null = null;

/** Returns a valid access token, refreshing if needed. */
export async function getValidAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (!tokens) throw new Error("Google Calendar not connected");
  const bufferMs = 60_000;
  if (!tokens.expiry_date || Date.now() > tokens.expiry_date - bufferMs) {
    if (!refreshInflight) {
      refreshInflight = (async () => {
        try {
          return await refreshAccessToken(tokens as CalendarTokens);
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

// ── State map (in-memory CSRF protection) ────────────────────────────────────

import { createOAuthStateStore } from "./oauthStateStore.js";

const pendingStates = createOAuthStateStore();

function generateState(): string {
  const state = crypto.randomBytes(32).toString("hex");
  if (!pendingStates.add(state)) {
    throw new Error(
      "OAuth state store full — too many concurrent authorize requests",
    );
  }
  return state;
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function calendarGet(
  endpoint: string,
  accessToken: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${CALENDAR_API}${endpoint}?${qs}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Google Calendar API error ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  return res.json();
}

async function fetchCalendarSummary(
  accessToken: string,
  calendarId: string,
): Promise<string> {
  const data = (await calendarGet(
    `/calendars/${encodeURIComponent(calendarId)}`,
    accessToken,
  )) as { summary?: string };
  return data.summary ?? calendarId;
}

// ── Event fetching ────────────────────────────────────────────────────────────

export async function listEvents(
  opts: {
    daysAhead?: number;
    maxResults?: number;
    calendarId?: string;
  } = {},
  signal?: AbortSignal,
): Promise<CalendarEvent[]> {
  const accessToken = await getValidAccessToken();
  const tokens = loadTokens();
  const calendarId = opts.calendarId ?? tokens?.calendar_id ?? "primary";
  const daysAhead = Math.min(opts.daysAhead ?? 7, 30);
  const maxResults = Math.min(opts.maxResults ?? 20, 50);

  const now = new Date();
  const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  const data = (await calendarGet(
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    accessToken,
    {
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      maxResults: String(maxResults),
      singleEvents: "true",
      orderBy: "startTime",
    },
    signal,
  )) as {
    items?: Array<{
      id: string;
      summary?: string;
      description?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      location?: string;
      htmlLink?: string;
      attendees?: Array<{ email?: string; displayName?: string }>;
    }>;
  };

  return (data.items ?? []).map((item) => {
    const startRaw = item.start?.dateTime ?? item.start?.date ?? "";
    const endRaw = item.end?.dateTime ?? item.end?.date ?? "";
    const allDay = !item.start?.dateTime;
    return {
      id: item.id,
      summary: item.summary ?? "(no title)",
      description: item.description,
      start: startRaw,
      end: endRaw,
      allDay,
      location: item.location,
      htmlLink: item.htmlLink ?? "",
      attendees: (item.attendees ?? [])
        .map((a) => a.displayName ?? a.email ?? "")
        .filter(Boolean),
    };
  });
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

export function handleCalendarAuthRedirect(): ConnectorHandlerResult {
  if (!isConfigured()) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error:
          "GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET env vars not set",
      }),
    };
  }
  const state = generateState();
  return { status: 302, body: "", redirect: buildAuthUrl(state) };
}

export async function handleCalendarCallback(
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
    // Default to "primary" calendar; user can update later
    const calId = "primary";
    const summary = await fetchCalendarSummary(oauthTokens.access_token, calId);
    const tokens: CalendarTokens = {
      ...oauthTokens,
      calendar_id: calId,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, calendarId: calId, summary }),
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

export async function handleCalendarTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: "Google Calendar not connected",
      }),
    };
  }
  try {
    const accessToken = await getValidAccessToken();
    const summary = await fetchCalendarSummary(accessToken, tokens.calendar_id);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        calendarId: tokens.calendar_id,
        summary,
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

export async function handleCalendarDisconnect(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (tokens?.access_token) await revokeToken(tokens.access_token);
  deleteTokens();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
