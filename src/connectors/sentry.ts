/**
 * Sentry connector.
 *
 * Uses Sentry's REST API with an auth token (no OAuth app required).
 * Token stored at ~/.patchwork/tokens/sentry.json (mode 0600).
 * Env vars: SENTRY_AUTH_TOKEN, SENTRY_ORG (optional default org slug).
 *
 * HTTP routes registered in bridge.ts:
 *   POST   /connections/sentry/connect   — store token + verify
 *   POST   /connections/sentry/test      — verify stored token works
 *   DELETE /connections/sentry           — delete stored token
 *
 * MCP tool: fetchSentryIssue — fetches a Sentry issue/event and returns
 * the stack trace string, ready to pass into enrichStackTrace.
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

const SENTRY_API = "https://sentry.io/api/0";
const TOKEN_PATH = path.join(homedir(), ".patchwork", "tokens", "sentry.json");

export interface SentryTokens {
  auth_token: string;
  org?: string;
  connected_at: string;
}

export interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected";
  lastSync?: string;
  org?: string;
}

// ── Token storage ─────────────────────────────────────────────────────────────

export function loadTokens(): SentryTokens | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf-8")) as SentryTokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: SentryTokens): void {
  mkdirSync(path.dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function deleteTokens(): void {
  if (existsSync(TOKEN_PATH)) unlinkSync(TOKEN_PATH);
}

export function getStatus(): ConnectorStatus {
  const tokens = loadTokens();
  return {
    id: "sentry",
    status: tokens ? "connected" : "disconnected",
    lastSync: tokens?.connected_at,
    org: tokens?.org,
  };
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function sentryGet(
  path: string,
  token: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetch(`${SENTRY_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sentry API error ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Verify the token and return the authenticated user's identity. */
async function verifyToken(
  token: string,
  signal?: AbortSignal,
): Promise<{ username: string }> {
  const data = (await sentryGet("/", token, signal)) as {
    user?: { username?: string };
  };
  return { username: data.user?.username ?? "unknown" };
}

/**
 * Fetch the latest event for a Sentry issue and extract the stack trace text.
 * issueIdOrUrl accepts:
 *   - A numeric issue ID: "12345"
 *   - A Sentry issue URL: "https://sentry.io/organizations/my-org/issues/12345/"
 */
export async function fetchIssueStackTrace(
  issueIdOrUrl: string,
  signal?: AbortSignal,
): Promise<{ stackTrace: string; title: string; issueId: string }> {
  const tokens = loadTokens();
  if (!tokens)
    throw new Error(
      "Sentry not connected. POST /connections/sentry/connect first.",
    );

  const issueId = extractIssueId(issueIdOrUrl);
  // Org-scoped endpoint required for self-hosted / team orgs.
  // Fall back to legacy path if no org stored.
  const issuePath = tokens.org
    ? `/organizations/${tokens.org}/issues/${issueId}/`
    : `/issues/${issueId}/`;
  const eventPath = tokens.org
    ? `/organizations/${tokens.org}/issues/${issueId}/events/latest/`
    : `/issues/${issueId}/events/latest/`;

  // Fetch issue metadata first to get the title
  const issue = (await sentryGet(issuePath, tokens.auth_token, signal)) as {
    title?: string;
  };

  const event = (await sentryGet(
    eventPath,
    tokens.auth_token,
    signal,
  )) as SentryEvent;
  event.title = event.title ?? issue.title;

  const stackTrace = eventToStackTrace(event);
  return { stackTrace, title: event.title ?? issueId, issueId };
}

function extractIssueId(issueIdOrUrl: string): string {
  // URL form: https://sentry.io/organizations/.../issues/12345/
  const urlMatch = issueIdOrUrl.match(/\/issues\/(\d+)/);
  if (urlMatch) return urlMatch[1] as string;
  // Plain numeric or alphanumeric ID
  const trimmed = issueIdOrUrl.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  throw new Error(`Cannot parse Sentry issue ID from: ${issueIdOrUrl}`);
}

// ── Sentry event → stack trace text ──────────────────────────────────────────

interface SentryException {
  type?: string;
  value?: string;
  stacktrace?: {
    frames?: SentryFrame[];
  };
}

interface SentryFrame {
  filename?: string;
  absPath?: string;
  lineNo?: number;
  colNo?: number;
  function?: string;
  module?: string;
  inApp?: boolean;
}

interface SentryEvent {
  title?: string;
  entries?: Array<{
    type: string;
    data?: {
      values?: SentryException[];
      frames?: SentryFrame[];
    };
  }>;
}

/**
 * Convert a Sentry event JSON into a stack trace string that parseStackTrace
 * (used by enrichStackTrace) can parse. Uses Node.js-style format.
 */
function eventToStackTrace(event: SentryEvent): string {
  const exceptions: SentryException[] = [];

  for (const entry of event.entries ?? []) {
    if (entry.type === "exception" && Array.isArray(entry.data?.values)) {
      exceptions.push(...(entry.data?.values ?? []));
    }
  }

  if (exceptions.length === 0) {
    return `Error: ${event.title ?? "Unknown error"}\n    (no stack frames in Sentry event)`;
  }

  const lines: string[] = [];
  for (const exc of exceptions.reverse()) {
    lines.push(`${exc.type ?? "Error"}: ${exc.value ?? ""}`);
    const frames = exc.stacktrace?.frames ?? [];
    // Sentry stores frames innermost-last; reverse for top-of-stack-first output
    for (const frame of [...frames].reverse()) {
      const file =
        frame.absPath ?? frame.filename ?? frame.module ?? "<unknown>";
      const line = frame.lineNo ?? 0;
      const col = frame.colNo !== undefined ? `:${frame.colNo}` : "";
      const fn = frame.function ? ` (${frame.function})` : "";
      lines.push(
        `    at ${fn.trim() || "<anonymous>"} (${file}:${line}${col})`,
      );
    }
  }

  return lines.join("\n");
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

export async function handleSentryConnect(
  body: unknown,
): Promise<ConnectorHandlerResult> {
  const signal = undefined;
  const { auth_token, org } = (body ?? {}) as {
    auth_token?: string;
    org?: string;
  };
  if (!auth_token || typeof auth_token !== "string") {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "auth_token required" }),
    };
  }
  try {
    const { username } = await verifyToken(auth_token, signal);
    const tokens: SentryTokens = {
      auth_token,
      org: org ?? undefined,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, username, org: org ?? null }),
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

export async function handleSentryTest(): Promise<ConnectorHandlerResult> {
  const signal = undefined;
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Sentry not connected" }),
    };
  }
  try {
    const { username } = await verifyToken(tokens.auth_token, signal);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, username }),
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

export function handleSentryDisconnect(): ConnectorHandlerResult {
  deleteTokens();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
