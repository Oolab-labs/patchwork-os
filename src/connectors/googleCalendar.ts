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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const REDIRECT_URI = process.env.PATCHWORK_DASHBOARD_URL
  ? `${process.env.PATCHWORK_DASHBOARD_URL}/connections/google-calendar/callback`
  : "http://localhost:3200/connections/google-calendar/callback";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const TOKEN_PATH = path.join(
  homedir(),
  ".patchwork",
  "tokens",
  "google-calendar.json",
);

export interface CalendarTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
  calendar_id: string;
  connected_at: string;
}

export interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected";
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
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf-8")) as CalendarTokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: CalendarTokens): void {
  mkdirSync(path.dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function deleteTokens(): void {
  if (existsSync(TOKEN_PATH)) unlinkSync(TOKEN_PATH);
}

export function getStatus(): ConnectorStatus {
  const tokens = loadTokens();
  return {
    id: "google-calendar",
    status: tokens ? "connected" : "disconnected",
    lastSync: tokens?.connected_at,
    calendarId: tokens?.calendar_id,
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
  };
}

async function refreshAccessToken(
  tokens: CalendarTokens,
): Promise<CalendarTokens> {
  if (!tokens.refresh_token) throw new Error("No refresh token available");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: clientId(),
      client_secret: clientSecret(),
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

/** Returns a valid access token, refreshing if needed. */
export async function getValidAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (!tokens) throw new Error("Google Calendar not connected");
  const bufferMs = 60_000;
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - bufferMs) {
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

// ── State map (in-memory CSRF protection) ────────────────────────────────────

const pendingStates = new Set<string>();

function generateState(): string {
  const state = crypto.randomBytes(32).toString("hex");
  pendingStates.add(state);
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000);
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
  const tokens = loadTokens()!;
  const calendarId = opts.calendarId ?? tokens.calendar_id ?? "primary";
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
