/**
 * Sentry connector — routes through Sentry's official MCP server.
 *
 * Endpoint: https://mcp.sentry.dev/mcp
 * Auth:     OAuth 2.1 w/ PKCE; dynamic client registration (RFC 7591).
 *
 * HTTP routes (wired in src/server.ts):
 *   GET    /connections/sentry/authorize — returns { url } for popup
 *   GET    /connections/sentry/callback  — token exchange
 *   POST   /connections/sentry/test      — ping MCP server
 *   DELETE /connections/sentry           — revoke + delete token
 *
 * MCP tool: fetchSentryIssue — fetches a Sentry issue/event and returns
 * the stack trace string, ready to pass into enrichStackTrace.
 */

import { McpClient } from "./mcpClient.js";
import {
  completeAuthorize,
  getAccessToken,
  loadTokenFile,
  revoke,
  startAuthorize,
  vendorConfig,
} from "./mcpOAuth.js";

const SENTRY_MCP_ENDPOINT = "https://mcp.sentry.dev/mcp";

export interface SentryTokens {
  auth_token: string; // kept for back-compat
  org?: string;
  connected_at: string;
}

export interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected";
  lastSync?: string;
  org?: string;
}

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
  redirect?: string;
}

// ── MCP client ───────────────────────────────────────────────────────────────

let _client: McpClient | null = null;
function client(): McpClient {
  if (!_client) {
    _client = new McpClient(SENTRY_MCP_ENDPOINT, () =>
      getAccessToken("sentry"),
    );
  }
  return _client;
}

// ── Back-compat ──────────────────────────────────────────────────────────────

export function loadTokens(): SentryTokens | null {
  const file = loadTokenFile("sentry");
  if (!file) return null;
  return {
    auth_token: file.access_token,
    org: file.profile?.org,
    connected_at: file.connected_at,
  };
}

export function getStatus(): ConnectorStatus {
  const file = loadTokenFile("sentry");
  return {
    id: "sentry",
    status: file ? "connected" : "disconnected",
    lastSync: file?.connected_at,
    org: file?.profile?.org,
  };
}

// ── Issue fetch ──────────────────────────────────────────────────────────────

function extractIssueId(issueIdOrUrl: string): string {
  const urlMatch = issueIdOrUrl.match(/\/issues\/(\d+)/);
  if (urlMatch) return urlMatch[1] as string;
  const trimmed = issueIdOrUrl.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  throw new Error(`Cannot parse Sentry issue ID from: ${issueIdOrUrl}`);
}

interface SentryException {
  type?: string;
  value?: string;
  stacktrace?: { frames?: SentryFrame[] };
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
    data?: { values?: SentryException[]; frames?: SentryFrame[] };
  }>;
}

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

export async function fetchIssueStackTrace(
  issueIdOrUrl: string,
  signal?: AbortSignal,
): Promise<{ stackTrace: string; title: string; issueId: string }> {
  if (!loadTokens())
    throw new Error(
      "Sentry not connected. GET /connections/sentry/authorize first.",
    );

  const issueId = extractIssueId(issueIdOrUrl);
  const file = loadTokenFile("sentry");
  const org = file?.profile?.org;

  const issueRes = await client().callTool(
    "get_issue",
    org ? { issueId, organizationSlug: org } : { issueId },
    { signal },
  );
  const issue = McpClient.extractJson<{ title?: string }>(issueRes);

  const eventRes = await client().callTool(
    "get_event",
    org
      ? { issueId, organizationSlug: org, eventId: "latest" }
      : { issueId, eventId: "latest" },
    { signal },
  );
  const event = McpClient.extractJson<SentryEvent>(eventRes);
  event.title = event.title ?? issue.title;

  const stackTrace = eventToStackTrace(event);
  return { stackTrace, title: event.title ?? issueId, issueId };
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

export async function handleSentryAuthorize(): Promise<ConnectorHandlerResult> {
  try {
    const { url } = await startAuthorize(vendorConfig("sentry"));
    return { status: 302, body: "", redirect: url };
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

export async function handleSentryCallback(
  code: string | null,
  state: string | null,
  error: string | null,
): Promise<ConnectorHandlerResult> {
  if (error) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Sentry connect failed</h2><pre>${error}</pre></body></html>`,
    };
  }
  if (!code || !state) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Sentry connect failed</h2><pre>missing code/state</pre></body></html>`,
    };
  }
  try {
    await completeAuthorize(vendorConfig("sentry"), code, state);
    // Best-effort org capture
    try {
      const res = await client().callTool(
        "list_organizations",
        {},
        {
          timeoutMs: 10_000,
        },
      );
      const orgs = McpClient.extractJson<
        Array<{ slug?: string }> | { organizations?: Array<{ slug?: string }> }
      >(res);
      const first = Array.isArray(orgs)
        ? orgs[0]
        : (orgs.organizations ?? [])[0];
      const org = first?.slug;
      if (org) {
        const file = loadTokenFile("sentry");
        if (file) {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { homedir } = await import("node:os");
          const path = await import("node:path");
          const p = path.join(
            homedir(),
            ".patchwork",
            "tokens",
            "sentry-mcp.json",
          );
          mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
          file.profile = { ...(file.profile ?? {}), org };
          writeFileSync(p, JSON.stringify(file, null, 2), { mode: 0o600 });
        }
      }
    } catch {
      // Profile fetch is best-effort
    }
    return {
      status: 200,
      contentType: "text/html",
      body: `<html><body><h2>Sentry connected</h2><script>window.close();</script></body></html>`,
    };
  } catch (err) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Sentry connect failed</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`,
    };
  }
}

export async function handleSentryTest(): Promise<ConnectorHandlerResult> {
  if (!loadTokens()) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Sentry not connected" }),
    };
  }
  try {
    const ok = await client().ping({ timeoutMs: 10_000 });
    return {
      status: ok ? 200 : 400,
      contentType: "application/json",
      body: JSON.stringify({ ok, message: ok ? "connected" : "ping failed" }),
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

export async function handleSentryDisconnect(): Promise<ConnectorHandlerResult> {
  await revoke("sentry");
  _client = null;
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
