/**
 * Linear connector — routes through Linear's official MCP server.
 *
 * Endpoint: https://mcp.linear.app/mcp
 * Auth:     OAuth 2.1 w/ PKCE; dynamic client registration (RFC 7591).
 *
 * HTTP routes (wired in src/server.ts):
 *   GET    /connections/linear/authorize — returns { url } for popup
 *   GET    /connections/linear/callback  — token exchange
 *   POST   /connections/linear/test      — ping MCP server
 *   DELETE /connections/linear           — revoke + delete token
 *
 * Back-compat: loadTokens() returns a shape compatible with legacy code
 * that expected { api_key }. Set LINEAR_API_KEY to bypass OAuth for CI/headless.
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

const LINEAR_MCP_ENDPOINT = "https://mcp.linear.app/mcp";

export interface LinearTokens {
  api_key: string; // kept for back-compat: the access token is returned here
  workspace?: string;
  connected_at: string;
}

export interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected";
  lastSync?: string;
  workspace?: string;
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
    _client = new McpClient(LINEAR_MCP_ENDPOINT, async () => {
      const envKey = process.env.LINEAR_API_KEY;
      if (envKey) return envKey;
      return getAccessToken("linear");
    });
  }
  return _client;
}

// ── Back-compat token loader ─────────────────────────────────────────────────

export function loadTokens(): LinearTokens | null {
  const envKey = process.env.LINEAR_API_KEY;
  if (envKey) {
    return { api_key: envKey, connected_at: new Date().toISOString() };
  }
  const file = loadTokenFile("linear");
  if (!file) return null;
  return {
    api_key: file.access_token,
    workspace: file.profile?.workspace,
    connected_at: file.connected_at,
  };
}

export function getStatus(): ConnectorStatus {
  const envKey = process.env.LINEAR_API_KEY;
  if (envKey) {
    return { id: "linear", status: "connected" };
  }
  const file = loadTokenFile("linear");
  return {
    id: "linear",
    status: file ? "connected" : "disconnected",
    lastSync: file?.connected_at,
    workspace: file?.profile?.workspace,
  };
}

// ── Tool wrappers ────────────────────────────────────────────────────────────

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: { name: string; type: string };
  assignee?: { name: string; email: string };
  priority: number;
  priorityLabel: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  team: { name: string; key: string };
  labels: { nodes: Array<{ name: string }> };
}

function extractIssueId(issueIdOrUrl: string): string {
  const urlMatch = issueIdOrUrl.match(/\/issue\/([A-Z]+-\d+|[a-f0-9-]{36})/i);
  if (urlMatch) return urlMatch[1] as string;
  const trimmed = issueIdOrUrl.trim();
  if (/^[A-Z]+-\d+$/i.test(trimmed)) return trimmed;
  if (/^[a-f0-9-]{36}$/i.test(trimmed)) return trimmed;
  throw new Error(`Cannot parse Linear issue ID from: ${issueIdOrUrl}`);
}

export async function fetchIssue(
  issueIdOrUrl: string,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  if (!loadTokens())
    throw new Error(
      "Linear not connected. GET /connections/linear/authorize first.",
    );
  const id = extractIssueId(issueIdOrUrl);
  const res = await client().callTool("get_issue", { id }, { signal });
  const parsed = McpClient.extractJson<LinearIssue | { issue: LinearIssue }>(
    res,
  );
  const issue =
    (parsed as { issue?: LinearIssue }).issue ?? (parsed as LinearIssue);
  if (!issue) throw new Error(`Linear issue not found: ${id}`);
  return issue;
}

export interface ListLinearIssuesOpts {
  team?: string;
  assigneeMe?: boolean;
  states?: string[]; // state types e.g. ["started", "unstarted"]
  limit?: number;
}

export async function listIssues(
  opts: ListLinearIssuesOpts = {},
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  if (!loadTokens()) return [];
  const args: Record<string, unknown> = {
    limit: Math.min(opts.limit ?? 20, 50),
  };
  if (opts.team) args.team = opts.team;
  if (opts.assigneeMe) args.assignee = "me";
  if (opts.states?.length) args.stateTypes = opts.states;
  try {
    const res = await client().callTool("list_issues", args, {
      signal,
      cacheKey: `linear:issues:${JSON.stringify(args)}`,
      cacheTtlMs: 60_000,
    });
    const parsed = McpClient.extractJson<
      | Record<string, unknown>[]
      | {
          issues?: Record<string, unknown>[];
          nodes?: Record<string, unknown>[];
        }
    >(res);
    if (Array.isArray(parsed)) return parsed;
    return parsed.issues ?? parsed.nodes ?? [];
  } catch {
    return [];
  }
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

export async function handleLinearAuthorize(): Promise<ConnectorHandlerResult> {
  try {
    const { url } = await startAuthorize(vendorConfig("linear"));
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

export async function handleLinearCallback(
  code: string | null,
  state: string | null,
  error: string | null,
): Promise<ConnectorHandlerResult> {
  if (error) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Linear connect failed</h2><pre>${error}</pre></body></html>`,
    };
  }
  if (!code || !state) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Linear connect failed</h2><pre>missing code/state</pre></body></html>`,
    };
  }
  try {
    await completeAuthorize(vendorConfig("linear"), code, state);
    // Best-effort profile capture (workspace name)
    try {
      const res = await client().callTool(
        "get_viewer",
        {},
        { timeoutMs: 10_000 },
      );
      const viewer = McpClient.extractJson<{
        organization?: { urlKey?: string; name?: string };
      }>(res);
      const workspace =
        viewer.organization?.urlKey ?? viewer.organization?.name ?? "";
      if (workspace) {
        const file = loadTokenFile("linear");
        if (file) {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { homedir } = await import("node:os");
          const path = await import("node:path");
          const p = path.join(
            homedir(),
            ".patchwork",
            "tokens",
            "linear-mcp.json",
          );
          mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
          file.profile = { ...(file.profile ?? {}), workspace };
          writeFileSync(p, JSON.stringify(file, null, 2), { mode: 0o600 });
        }
      }
    } catch {
      // Profile fetch is best-effort
    }
    return {
      status: 200,
      contentType: "text/html",
      body: `<html><body><h2>Linear connected</h2><script>window.close();</script></body></html>`,
    };
  } catch (err) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Linear connect failed</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`,
    };
  }
}

export async function handleLinearTest(): Promise<ConnectorHandlerResult> {
  if (!loadTokens()) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Linear not connected" }),
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

export async function handleLinearDisconnect(): Promise<ConnectorHandlerResult> {
  await revoke("linear");
  _client = null;
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}

// ── Team + label lookup + create ─────────────────────────────────────────────

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export async function listTeams(signal?: AbortSignal): Promise<LinearTeam[]> {
  const res = await client().callTool("list_teams", {}, { signal });
  const parsed = McpClient.extractJson<
    LinearTeam[] | { teams?: LinearTeam[]; nodes?: LinearTeam[] }
  >(res);
  if (Array.isArray(parsed)) return parsed;
  return parsed.teams ?? parsed.nodes ?? [];
}

export async function listLabels(
  signal?: AbortSignal,
): Promise<Array<{ id: string; name: string }>> {
  const res = await client().callTool("list_issue_labels", {}, { signal });
  const parsed = McpClient.extractJson<
    | Array<{ id: string; name: string }>
    | {
        labels?: Array<{ id: string; name: string }>;
        nodes?: Array<{ id: string; name: string }>;
      }
  >(res);
  if (Array.isArray(parsed)) return parsed;
  return parsed.labels ?? parsed.nodes ?? [];
}

export interface CreateIssueInput {
  team: string; // team name or ID
  title: string;
  description?: string;
  priority?: number;
  labels?: string[]; // label names or IDs
}

export async function createIssue(
  input: CreateIssueInput,
  signal?: AbortSignal,
): Promise<{
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { name: string };
}> {
  const res = await client().callTool(
    "save_issue",
    input as unknown as Record<string, unknown>,
    { signal },
  );
  const parsed = McpClient.extractJson<
    | {
        id: string;
        identifier: string;
        title: string;
        url: string;
        state: { name: string };
      }
    | {
        issue: {
          id: string;
          identifier: string;
          title: string;
          url: string;
          state: { name: string };
        };
      }
  >(res);
  const issue = (parsed as { issue?: typeof parsed }).issue ?? parsed;
  return issue as {
    id: string;
    identifier: string;
    title: string;
    url: string;
    state: { name: string };
  };
}
