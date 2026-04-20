/**
 * GitHub connector — routes through the official GitHub MCP server.
 *
 * Endpoint: https://api.githubcopilot.com/mcp/
 * Auth:     OAuth 2.0 via github.com/login/oauth (requires pre-registered
 *           Patchwork OS OAuth App; client_id via PATCHWORK_GITHUB_CLIENT_ID env).
 *
 * HTTP routes (wired in src/server.ts):
 *   GET    /connections/github/authorize — returns { url } for popup
 *   GET    /connections/github/callback  — token exchange
 *   POST   /connections/github/test      — ping MCP server
 *   DELETE /connections/github           — delete token
 *
 * Exports preserved for yamlRunner; listIssues/listPRs are now async.
 */

import { McpClient } from "./mcpClient.js";
import {
  completeAuthorize,
  getAccessToken,
  isConnected,
  loadTokenFile,
  revoke,
  startAuthorize,
  vendorConfig,
} from "./mcpOAuth.js";

const GITHUB_MCP_ENDPOINT = "https://api.githubcopilot.com/mcp/";

export interface GitHubIssue {
  number: number;
  title: string;
  repo: string;
  url: string;
  labels: string[];
  updatedAt: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  repo: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string;
  updatedAt: string;
}

export interface ListIssuesOpts {
  assignee?: string;
  mention?: string;
  limit?: number;
  repo?: string;
}

export interface ListPRsOpts {
  author?: string;
  reviewRequested?: string;
  limit?: number;
  repo?: string;
}

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
  redirect?: string;
}

// ── MCP client (memoized) ────────────────────────────────────────────────────

let _client: McpClient | null = null;
function client(): McpClient {
  if (!_client) {
    _client = new McpClient(GITHUB_MCP_ENDPOINT, () =>
      getAccessToken("github"),
    );
  }
  return _client;
}

// ── Status ───────────────────────────────────────────────────────────────────

export function getStatus(): { connected: boolean; user?: string } {
  if (!isConnected("github")) return { connected: false };
  const file = loadTokenFile("github");
  return { connected: true, user: file?.profile?.login };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RawIssue {
  number: number;
  title: string;
  html_url?: string;
  url?: string;
  labels?: Array<{ name?: string } | string>;
  updated_at?: string;
  updatedAt?: string;
  repository?: { full_name?: string; nameWithOwner?: string };
}

function parseRepo(opts: { repo?: string }): { owner?: string; repo?: string } {
  if (!opts.repo) return {};
  const [owner, repo] = opts.repo.split("/");
  return { owner, repo };
}

function coerceIssue(raw: RawIssue, fallbackRepo: string): GitHubIssue {
  return {
    number: raw.number,
    title: raw.title,
    repo:
      raw.repository?.full_name ??
      raw.repository?.nameWithOwner ??
      fallbackRepo,
    url: raw.html_url ?? raw.url ?? "",
    labels: (raw.labels ?? [])
      .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
      .filter(Boolean),
    updatedAt: raw.updated_at ?? raw.updatedAt ?? "",
  };
}

// ── Listing ──────────────────────────────────────────────────────────────────

export async function listIssues(
  opts: ListIssuesOpts = {},
): Promise<GitHubIssue[]> {
  if (!isConnected("github")) return [];
  const { owner, repo } = parseRepo(opts);
  const args: Record<string, unknown> = {
    state: "open",
    perPage: Math.min(opts.limit ?? 20, 50),
  };
  if (owner) args.owner = owner;
  if (repo) args.repo = repo;
  if (opts.assignee)
    args.assignee = opts.assignee === "@me" ? "@me" : opts.assignee;
  if (opts.mention) args.mentioned = opts.mention;
  try {
    const res = await client().callTool("list_issues", args, {
      cacheKey: `gh:issues:${JSON.stringify(args)}`,
      cacheTtlMs: 60_000,
    });
    const parsed = McpClient.extractJson<RawIssue[] | { items?: RawIssue[] }>(
      res,
    );
    const arr = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    const fallbackRepo = opts.repo ?? "";
    return arr.map((i) => coerceIssue(i, fallbackRepo));
  } catch {
    return [];
  }
}

interface RawPR extends RawIssue {
  draft?: boolean;
  isDraft?: boolean;
  review_decision?: string;
  reviewDecision?: string;
}

export async function listPRs(opts: ListPRsOpts = {}): Promise<GitHubPR[]> {
  if (!isConnected("github")) return [];
  const { owner, repo } = parseRepo(opts);
  const args: Record<string, unknown> = {
    state: "open",
    perPage: Math.min(opts.limit ?? 20, 50),
  };
  if (owner) args.owner = owner;
  if (repo) args.repo = repo;
  if (opts.author) args.author = opts.author === "@me" ? "@me" : opts.author;
  if (opts.reviewRequested) args.reviewRequested = opts.reviewRequested;
  try {
    const res = await client().callTool("list_pull_requests", args, {
      cacheKey: `gh:prs:${JSON.stringify(args)}`,
      cacheTtlMs: 60_000,
    });
    const parsed = McpClient.extractJson<RawPR[] | { items?: RawPR[] }>(res);
    const arr = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    const fallbackRepo = opts.repo ?? "";
    return arr.map((p) => ({
      ...coerceIssue(p, fallbackRepo),
      isDraft: Boolean(p.draft ?? p.isDraft ?? false),
      reviewDecision: p.review_decision ?? p.reviewDecision ?? "",
    }));
  } catch {
    return [];
  }
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

export async function handleGithubAuthorize(): Promise<ConnectorHandlerResult> {
  const config = vendorConfig("github");
  if (!config.preregisteredClientId) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error:
          "PATCHWORK_GITHUB_CLIENT_ID not set — register a GitHub OAuth App first",
      }),
    };
  }
  try {
    const { url } = await startAuthorize(config);
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

export async function handleGithubCallback(
  code: string | null,
  state: string | null,
  error: string | null,
): Promise<ConnectorHandlerResult> {
  if (error) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>GitHub connect failed</h2><pre>${error}</pre></body></html>`,
    };
  }
  if (!code || !state) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>GitHub connect failed</h2><pre>missing code or state</pre></body></html>`,
    };
  }
  const config = vendorConfig("github");
  try {
    await completeAuthorize(config, code, state);
    // Capture user login for status display
    let login = "";
    try {
      const token = await getAccessToken("github");
      const res = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      if (res.ok) {
        const u = (await res.json()) as { login?: string };
        login = u.login ?? "";
        if (login) {
          const file = loadTokenFile("github");
          if (file) {
            const { writeFileSync, mkdirSync } = await import("node:fs");
            const { homedir } = await import("node:os");
            const path = await import("node:path");
            const p = path.join(
              homedir(),
              ".patchwork",
              "tokens",
              "github-mcp.json",
            );
            mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
            file.profile = { ...(file.profile ?? {}), login };
            writeFileSync(p, JSON.stringify(file, null, 2), { mode: 0o600 });
          }
        }
      }
    } catch {
      // Profile fetch is best-effort
    }
    return {
      status: 200,
      contentType: "text/html",
      body: `<html><body><h2>GitHub connected${login ? ` as ${login}` : ""}</h2><script>window.close();</script></body></html>`,
    };
  } catch (err) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>GitHub connect failed</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`,
    };
  }
}

export async function handleGithubTest(): Promise<ConnectorHandlerResult> {
  const s = getStatus();
  if (!s.connected) {
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, message: "Not connected" }),
    };
  }
  try {
    const ok = await client().ping({ timeoutMs: 10_000 });
    if (ok) {
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          message: `Connected as ${s.user ?? "unknown"}`,
        }),
      };
    }
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, message: "MCP ping failed" }),
    };
  } catch (err) {
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

export async function handleGithubDisconnect(): Promise<ConnectorHandlerResult> {
  await revoke("github");
  _client = null;
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
