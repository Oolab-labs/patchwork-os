/**
 * Google Calendar connector.
 *
 * Uses Google Calendar API v3 with an API key (no OAuth app required).
 * Suitable for personal/public calendars — read-only.
 * Token stored at ~/.patchwork/tokens/google-calendar.json (mode 0600).
 * Env vars: GOOGLE_CALENDAR_API_KEY, GOOGLE_CALENDAR_ID
 *
 * HTTP routes registered in server.ts:
 *   POST   /connections/google-calendar/connect  — store key + calendar ID + verify
 *   POST   /connections/google-calendar/test     — verify stored credentials work
 *   DELETE /connections/google-calendar          — delete stored credentials
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const TOKEN_PATH = path.join(
  homedir(),
  ".patchwork",
  "tokens",
  "google-calendar.json",
);

export interface CalendarTokens {
  api_key: string;
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
}

// ── Token storage ─────────────────────────────────────────────────────────────

export function loadTokens(): CalendarTokens | null {
  const envKey = process.env.GOOGLE_CALENDAR_API_KEY;
  const envCal = process.env.GOOGLE_CALENDAR_ID;
  if (envKey && envCal) {
    return {
      api_key: envKey,
      calendar_id: envCal,
      connected_at: new Date().toISOString(),
    };
  }
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

// ── API helpers ───────────────────────────────────────────────────────────────

async function calendarGet(
  endpoint: string,
  apiKey: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const qs = new URLSearchParams({ ...params, key: apiKey });
  const res = await fetch(`${CALENDAR_API}${endpoint}?${qs}`, { signal });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Google Calendar API error ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  return res.json();
}

async function verifyCredentials(
  apiKey: string,
  calendarId: string,
  signal?: AbortSignal,
): Promise<{ summary: string }> {
  const data = (await calendarGet(
    `/calendars/${encodeURIComponent(calendarId)}`,
    apiKey,
    {},
    signal,
  )) as { summary?: string };
  return { summary: data.summary ?? calendarId };
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
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error(
      "Google Calendar not connected. POST /connections/google-calendar/connect first.",
    );
  }

  const calendarId = opts.calendarId ?? tokens.calendar_id;
  const daysAhead = Math.min(opts.daysAhead ?? 7, 30);
  const maxResults = Math.min(opts.maxResults ?? 20, 50);

  const now = new Date();
  const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  const data = (await calendarGet(
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    tokens.api_key,
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

export async function handleCalendarConnect(
  body: unknown,
): Promise<ConnectorHandlerResult> {
  const { api_key, calendar_id } = (body ?? {}) as {
    api_key?: string;
    calendar_id?: string;
  };
  if (!api_key || typeof api_key !== "string") {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "api_key required" }),
    };
  }
  const calId = calendar_id?.trim() || "primary";
  try {
    const { summary } = await verifyCredentials(api_key, calId);
    saveTokens({
      api_key,
      calendar_id: calId,
      connected_at: new Date().toISOString(),
    });
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
    const { summary } = await verifyCredentials(
      tokens.api_key,
      tokens.calendar_id,
    );
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

export function handleCalendarDisconnect(): ConnectorHandlerResult {
  deleteTokens();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
