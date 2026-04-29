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

import { escHtml } from "./htmlEscape.js";
import { McpClient } from "./mcpClient.js";
import {
  completeAuthorize,
  getAccessToken,
  isConnected,
  loadTokenFile,
  revoke,
  startAuthorize,
  updateTokenProfile,
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
  } catch (err) {
    // Pre-fix this swallowed everything to `[]`. A token expiry, rate
    // limit, or MCP outage looked identical to "no issues this week"
    // — the recipe agent then summarized "no work" with confidence.
    // Throw real failures so the recipe-tool wrapper can return a
    // `{count:0, issues:[], error}` shape that the runner's silent-
    // fail detector flags as a step error (PR #72).
    throw new Error(
      `github list_issues failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  } catch (err) {
    // Same antipattern as listIssues — see comment there.
    throw new Error(
      `github list_pull_requests failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Single-item fetchers ─────────────────────────────────────────────────────

export interface GitHubIssueDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  repo: string;
  author: string;
  labels: string[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  comments: number;
}

export interface GitHubPRDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  repo: string;
  author: string;
  isDraft: boolean;
  reviewDecision: string;
  labels: string[];
  headBranch: string;
  baseBranch: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
}

function parseIssueRef(ref: string): {
  owner: string;
  repo: string;
  number: number;
} {
  // https://github.com/owner/repo/issues/42
  const urlMatch = ref.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (urlMatch) {
    return {
      owner: urlMatch[1] as string,
      repo: urlMatch[2] as string,
      number: Number(urlMatch[3]),
    };
  }
  // owner/repo#42 or owner/repo/42
  const shortMatch = ref.match(/^([^/]+)\/([^/#]+)[/#](\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1] as string,
      repo: shortMatch[2] as string,
      number: Number(shortMatch[3]),
    };
  }
  throw new Error(`Cannot parse GitHub issue ref: ${ref}`);
}

function parsePRRef(ref: string): {
  owner: string;
  repo: string;
  number: number;
} {
  const urlMatch = ref.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (urlMatch) {
    return {
      owner: urlMatch[1] as string,
      repo: urlMatch[2] as string,
      number: Number(urlMatch[3]),
    };
  }
  const shortMatch = ref.match(/^([^/]+)\/([^/#]+)[/#](\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1] as string,
      repo: shortMatch[2] as string,
      number: Number(shortMatch[3]),
    };
  }
  throw new Error(`Cannot parse GitHub PR ref: ${ref}`);
}

export async function fetchGitHubIssue(
  ref: string,
  signal?: AbortSignal,
): Promise<GitHubIssueDetail> {
  if (!isConnected("github"))
    throw new Error(
      "GitHub not connected. GET /connections/github/auth first.",
    );
  const { owner, repo, number } = parseIssueRef(ref);
  const res = await client().callTool(
    "issue_read",
    { owner, repo, issue_number: number, method: "get" },
    { signal },
  );
  const raw = McpClient.extractJson<Record<string, unknown>>(res);
  return {
    number: (raw.number as number) ?? number,
    title: (raw.title as string) ?? "",
    body: (raw.body as string) ?? "",
    state: (raw.state as string) ?? "",
    url: (raw.html_url as string) ?? (raw.url as string) ?? "",
    repo: `${owner}/${repo}`,
    author:
      ((raw.user as Record<string, unknown>)?.login as string) ??
      (raw.author as string) ??
      "",
    labels: ((raw.labels as Array<Record<string, unknown>>) ?? []).map(
      (l) => (l.name as string) ?? String(l),
    ),
    assignees: ((raw.assignees as Array<Record<string, unknown>>) ?? []).map(
      (a) => (a.login as string) ?? String(a),
    ),
    createdAt: (raw.created_at as string) ?? "",
    updatedAt: (raw.updated_at as string) ?? "",
    comments: (raw.comments as number) ?? 0,
  };
}

export async function fetchGitHubPR(
  ref: string,
  signal?: AbortSignal,
): Promise<GitHubPRDetail> {
  if (!isConnected("github"))
    throw new Error(
      "GitHub not connected. GET /connections/github/auth first.",
    );
  const { owner, repo, number } = parsePRRef(ref);
  const res = await client().callTool(
    "pull_request_read",
    { owner, repo, pullNumber: number, method: "get" },
    { signal },
  );
  const raw = McpClient.extractJson<Record<string, unknown>>(res);
  return {
    number: (raw.number as number) ?? number,
    title: (raw.title as string) ?? "",
    body: (raw.body as string) ?? "",
    state: (raw.state as string) ?? "",
    url: (raw.html_url as string) ?? (raw.url as string) ?? "",
    repo: `${owner}/${repo}`,
    author:
      ((raw.user as Record<string, unknown>)?.login as string) ??
      (raw.author as string) ??
      "",
    isDraft: Boolean(raw.draft ?? raw.isDraft ?? false),
    reviewDecision:
      (raw.review_decision as string) ?? (raw.reviewDecision as string) ?? "",
    labels: ((raw.labels as Array<Record<string, unknown>>) ?? []).map(
      (l) => (l.name as string) ?? String(l),
    ),
    headBranch:
      ((raw.head as Record<string, unknown>)?.ref as string) ??
      (raw.headRefName as string) ??
      "",
    baseBranch:
      ((raw.base as Record<string, unknown>)?.ref as string) ??
      (raw.baseRefName as string) ??
      "",
    createdAt: (raw.created_at as string) ?? "",
    updatedAt: (raw.updated_at as string) ?? "",
    additions: (raw.additions as number) ?? 0,
    deletions: (raw.deletions as number) ?? 0,
  };
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
      body: `<html><body><h2>GitHub connect failed</h2><pre>${escHtml(error)}</pre></body></html>`,
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
          updateTokenProfile("github", { login });
        }
      }
    } catch {
      // Profile fetch is best-effort
    }
    return {
      status: 200,
      contentType: "text/html",
      body: `<html><body><h2>GitHub connected${login ? ` as ${escHtml(login)}` : ""}</h2><script>window.close();</script></body></html>`,
    };
  } catch (err) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>GitHub connect failed</h2><pre>${escHtml(err instanceof Error ? err.message : String(err))}</pre></body></html>`,
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
