/**
 * GitLab connector — read-only: projects, issues, merge requests, current user.
 *
 * OAuth 2.0 Authorization Code Grant. GitLab is a confidential client (bridge
 * holds client secret), so PKCE is not used here. Refresh tokens are issued;
 * access tokens default to 2 hours.
 *
 * Auth: standard OAuth 2.0 with `client_id` + `client_secret` + `redirect_uri`.
 *   - Env vars: GITLAB_CLIENT_ID, GITLAB_CLIENT_SECRET (mirrors asana/discord)
 *   - Optional: GITLAB_BASE_URL — override base for self-hosted GitLab.
 *               Default https://gitlab.com. `/api/v4` is appended internally.
 *   - Stored: getSecretJsonSync("gitlab") → GitLabTokens
 *   - Header: Authorization: Bearer <access_token>
 *
 * Read-only scopes: read_user read_api read_repository.
 *
 * Read tools: getCurrentUser, listProjects, listIssues, getIssue,
 *   listMergeRequests.
 * Write methods (createIssue, createMergeRequestNote) are deferred to a
 * follow-up PR.
 *
 * HTTP routes (wired in src/server.ts):
 *   GET    /connections/gitlab/auth     — redirect to GitLab consent
 *   GET    /connections/gitlab/callback — exchange code for tokens
 *   POST   /connections/gitlab/test     — ping GitLab API
 *   DELETE /connections/gitlab          — best-effort revoke + clear local
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 * Token refresh is delegated to BaseConnector.refreshToken() via apiCall.
 */

import crypto from "node:crypto";
import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
  type OAuthConfig,
} from "./baseConnector.js";
import { escHtml } from "./htmlEscape.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

const SCOPES = ["read_user", "read_api", "read_repository"];

// ── Config ───────────────────────────────────────────────────────────────────

function clientId(): string {
  return process.env.GITLAB_CLIENT_ID ?? "";
}

function clientSecret(): string {
  return process.env.GITLAB_CLIENT_SECRET ?? "";
}

/**
 * Base host for the GitLab instance, e.g. `https://gitlab.com` (default) or
 * `https://gitlab.example.com` for self-hosted. Trailing slash trimmed; the
 * `/api/v4` path is appended internally so users only configure host.
 */
export function gitlabBaseUrl(): string {
  return (process.env.GITLAB_BASE_URL ?? "https://gitlab.com").replace(
    /\/$/,
    "",
  );
}

function apiBase(): string {
  return `${gitlabBaseUrl()}/api/v4`;
}

function authorizeUrl(): string {
  return `${gitlabBaseUrl()}/oauth/authorize`;
}

function tokenUrl(): string {
  return `${gitlabBaseUrl()}/oauth/token`;
}

function revokeUrl(): string {
  return `${gitlabBaseUrl()}/oauth/revoke`;
}

function redirectUri(): string {
  const base = (
    process.env.PATCHWORK_BRIDGE_URL ??
    `http://localhost:${process.env.PATCHWORK_BRIDGE_PORT ?? "3101"}`
  ).replace(/\/$/, "");
  return `${base}/connections/gitlab/callback`;
}

function isConfigured(): boolean {
  return Boolean(clientId() && clientSecret());
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface GitLabTokens {
  access_token: string;
  refresh_token?: string;
  /** ms since epoch; absolute, not relative */
  expires_at?: number;
  scope?: string;
  token_type?: string;
  /** stored at auth time so refresh works even if env vars are absent */
  _client_id?: string;
  _client_secret?: string;
  /** snapshot of base URL at connect time so refresh hits the right host */
  _base_url?: string;
  username?: string;
  user_id?: number;
  email?: string;
  connected_at: string;
}

export interface GitLabUser {
  id: number;
  username: string;
  name?: string;
  email?: string;
  avatar_url?: string | null;
}

export interface GitLabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  description?: string | null;
  web_url?: string;
  default_branch?: string | null;
  visibility?: string;
  archived?: boolean;
}

export interface GitLabIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state: string;
  web_url?: string;
  author?: { id: number; username: string; name?: string };
  assignees?: Array<{ id: number; username: string; name?: string }>;
  labels?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface GitLabMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state: string;
  source_branch?: string;
  target_branch?: string;
  web_url?: string;
  author?: { id: number; username: string; name?: string };
  draft?: boolean;
  merge_status?: string;
  created_at?: string;
  updated_at?: string;
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): GitLabTokens | null {
  return getSecretJsonSync<GitLabTokens>("gitlab");
}

export function saveTokens(tokens: GitLabTokens): void {
  storeSecretJsonSync("gitlab", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("gitlab");
  } catch {
    // ignore
  }
}

export function isConnected(): boolean {
  return loadTokens() !== null;
}

// ── State (CSRF) ─────────────────────────────────────────────────────────────

const pendingStates = new Set<string>();
const STATE_TTL_MS = 5 * 60 * 1000;

function generateState(): string {
  const state = crypto.randomBytes(32).toString("hex");
  pendingStates.add(state);
  setTimeout(() => pendingStates.delete(state), STATE_TTL_MS);
  return state;
}

function consumeState(state: string): boolean {
  if (!pendingStates.has(state)) return false;
  pendingStates.delete(state);
  return true;
}

// ── Connector class ──────────────────────────────────────────────────────────

export class GitLabConnector extends BaseConnector {
  readonly providerName = "gitlab";

  protected getOAuthConfig(): OAuthConfig | null {
    const tokens = loadTokens();
    const id = clientId() || tokens?._client_id || "";
    const secret = clientSecret() || tokens?._client_secret || "";
    if (!id || !secret) return null;
    return {
      clientId: id,
      clientSecret: secret,
      tokenEndpoint: tokenUrl(),
      scopes: SCOPES,
    };
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "GitLab not connected. Visit /connections/gitlab/auth to authorize.",
      );
    }
    return {
      token: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_at ? new Date(tokens.expires_at) : undefined,
      scopes: tokens.scope ? tokens.scope.split(" ") : SCOPES,
    };
  }

  /**
   * Persist refreshed tokens after BaseConnector.refreshToken() updates
   * `this.auth`. Mirror to our GitLab-specific JSON so loadTokens() keeps
   * working for HTTP probes.
   */
  override async saveTokens(): Promise<void> {
    await super.saveTokens();
    if (!this.auth) return;
    const existing = loadTokens();
    saveTokens({
      access_token: this.auth.token,
      refresh_token: this.auth.refreshToken,
      expires_at: this.auth.expiresAt
        ? this.auth.expiresAt.getTime()
        : undefined,
      scope: this.auth.scopes?.join(" "),
      token_type: existing?.token_type ?? "Bearer",
      _client_id: existing?._client_id,
      _client_secret: existing?._client_secret,
      _base_url: existing?._base_url,
      username: existing?.username,
      user_id: existing?.user_id,
      email: existing?.email,
      connected_at: existing?.connected_at ?? new Date().toISOString(),
    });
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async (token) => {
        const res = await fetch(`${apiBase()}/user`, {
          headers: this.buildHeaders(token),
        });
        if (!res.ok) throw res;
        return res.json();
      });
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    if (error instanceof Response) {
      const s = error.status;
      if (s === 401)
        return {
          code: "auth_expired",
          message: "GitLab authentication failed — token expired or revoked",
          retryable: true,
          suggestedAction: "Reconnect via /connections/gitlab/auth",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient GitLab permissions for this resource",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "GitLab resource not found",
          retryable: false,
        };
      if (s === 429) {
        const reset = error.headers.get("ratelimit-reset");
        const retryAfter = error.headers.get("retry-after");
        return {
          code: "rate_limited",
          message: `GitLab API rate limit exceeded${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`,
          retryable: true,
          suggestedAction: retryAfter
            ? `Wait ${retryAfter}s and retry`
            : "Wait and retry",
          providerDetail: {
            ...(retryAfter ? { retryAfter } : {}),
            ...(reset ? { reset } : {}),
          },
        };
      }
      return {
        code: "provider_error",
        message: `GitLab API error: HTTP ${s}`,
        retryable: s >= 500,
      };
    }
    if (error instanceof Error) {
      if (
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ECONNREFUSED")
      ) {
        return {
          code: "network_error",
          message: `Cannot connect to GitLab: ${error.message}`,
          retryable: true,
        };
      }
    }
    return {
      code: "provider_error",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }

  getStatus(): ConnectorStatus {
    const tokens = loadTokens();
    return {
      id: "gitlab",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.username,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async getCurrentUser(): Promise<GitLabUser> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${apiBase()}/user`, {
        headers: this.buildHeaders(token),
      });
      this.captureRateLimit(res);
      if (!res.ok) throw res;
      return res.json() as Promise<GitLabUser>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as GitLabUser;
  }

  async listProjects(
    params: {
      membership?: boolean;
      owned?: boolean;
      search?: string;
      limit?: number;
    } = {},
  ): Promise<GitLabProject[]> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({
        per_page: String(limit),
        // Default to membership=true so users only see their projects unless
        // they explicitly opt out (e.g. for public-search use cases).
        membership: String(params.membership ?? true),
      });
      if (params.owned) qs.set("owned", "true");
      if (params.search) qs.set("search", params.search);
      const res = await fetch(`${apiBase()}/projects?${qs}`, {
        headers: this.buildHeaders(token),
      });
      this.captureRateLimit(res);
      if (!res.ok) throw res;
      return res.json() as Promise<GitLabProject[]>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as GitLabProject[];
  }

  async listIssues(
    params: {
      projectId?: string | number;
      assignedToMe?: boolean;
      state?: "opened" | "closed" | "all";
      limit?: number;
    } = {},
  ): Promise<GitLabIssue[]> {
    if (params.state && !["opened", "closed", "all"].includes(params.state)) {
      throw new Error(
        `listIssues: invalid state "${params.state}" (expected opened|closed|all)`,
      );
    }
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({ per_page: String(limit) });
      if (params.state) qs.set("state", params.state);
      let url: string;
      if (params.projectId !== undefined && params.projectId !== "") {
        url = `${apiBase()}/projects/${encodeURIComponent(String(params.projectId))}/issues?${qs}`;
      } else {
        // Per-user issues endpoint. `assigned_to_me` is the default when
        // `assignedToMe: true`; otherwise it returns issues created by user.
        if (params.assignedToMe) qs.set("scope", "assigned_to_me");
        url = `${apiBase()}/issues?${qs}`;
      }
      const res = await fetch(url, { headers: this.buildHeaders(token) });
      this.captureRateLimit(res);
      if (!res.ok) throw res;
      return res.json() as Promise<GitLabIssue[]>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as GitLabIssue[];
  }

  async getIssue(
    projectId: string | number,
    issueIid: number,
  ): Promise<GitLabIssue> {
    if (projectId === undefined || projectId === "" || !issueIid) {
      throw new Error("getIssue requires projectId and issueIid");
    }
    const result = await this.apiCall(async (token) => {
      const res = await fetch(
        `${apiBase()}/projects/${encodeURIComponent(String(projectId))}/issues/${issueIid}`,
        { headers: this.buildHeaders(token) },
      );
      this.captureRateLimit(res);
      if (!res.ok) throw res;
      return res.json() as Promise<GitLabIssue>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as GitLabIssue;
  }

  async listMergeRequests(
    params: {
      projectId?: string | number;
      state?: "opened" | "closed" | "merged" | "all";
      scope?: "created_by_me" | "assigned_to_me" | "all";
      limit?: number;
    } = {},
  ): Promise<GitLabMergeRequest[]> {
    if (
      params.state &&
      !["opened", "closed", "merged", "all"].includes(params.state)
    ) {
      throw new Error(
        `listMergeRequests: invalid state "${params.state}" (expected opened|closed|merged|all)`,
      );
    }
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({ per_page: String(limit) });
      if (params.state) qs.set("state", params.state);
      if (params.scope) qs.set("scope", params.scope);
      let url: string;
      if (params.projectId !== undefined && params.projectId !== "") {
        url = `${apiBase()}/projects/${encodeURIComponent(String(params.projectId))}/merge_requests?${qs}`;
      } else {
        url = `${apiBase()}/merge_requests?${qs}`;
      }
      const res = await fetch(url, { headers: this.buildHeaders(token) });
      this.captureRateLimit(res);
      if (!res.ok) throw res;
      return res.json() as Promise<GitLabMergeRequest[]>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as GitLabMergeRequest[];
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private captureRateLimit(res: Response): void {
    this.updateRateLimitFromHeaders({
      "x-ratelimit-remaining":
        res.headers.get("ratelimit-remaining") ??
        res.headers.get("x-ratelimit-remaining") ??
        undefined,
      "x-ratelimit-reset":
        res.headers.get("ratelimit-reset") ??
        res.headers.get("x-ratelimit-reset") ??
        undefined,
      "retry-after": res.headers.get("retry-after") ?? undefined,
    });
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: GitLabConnector | null = null;

function resetGitLabConnector(): void {
  _instance = null;
}

export function getGitLabConnector(): GitLabConnector {
  if (!_instance) {
    _instance = new GitLabConnector();
  }
  return _instance;
}

export { getGitLabConnector as gitlab };

// ── HTTP Handlers ────────────────────────────────────────────────────────────

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
  redirect?: string;
}

/**
 * GET /connections/gitlab/auth — redirect to GitLab consent screen.
 */
export function handleGitLabAuthorize(): ConnectorHandlerResult {
  if (!isConfigured()) {
    return {
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error:
          "GitLab connector not configured. Set GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET.",
      }),
    };
  }
  const state = generateState();
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
  });
  return {
    status: 302,
    body: "",
    redirect: `${authorizeUrl()}?${params.toString()}`,
  };
}

/**
 * GET /connections/gitlab/callback — exchange code for tokens.
 */
export async function handleGitLabCallback(
  code: string | null,
  state: string | null,
  error: string | null,
): Promise<ConnectorHandlerResult> {
  if (error) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>GitLab connect failed</h2><pre>${escHtml(error)}</pre></body></html>`,
    };
  }
  if (!code || !state) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>GitLab connect failed</h2><pre>missing code or state</pre></body></html>`,
    };
  }
  if (!consumeState(state)) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>GitLab connect failed</h2><pre>invalid or expired state</pre></body></html>`,
    };
  }

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: clientId(),
      client_secret: clientSecret(),
    });
    const res = await fetch(tokenUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token exchange HTTP ${res.status}: ${body}`);
    }
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };
    if (!json.access_token) {
      throw new Error("Token exchange returned no access_token");
    }

    // Best-effort fetch of user info so the dashboard can show "connected as X".
    let username: string | undefined;
    let userId: number | undefined;
    let userEmail: string | undefined;
    try {
      const userRes = await fetch(`${apiBase()}/user`, {
        headers: { Authorization: `Bearer ${json.access_token}` },
      });
      if (userRes.ok) {
        const u = (await userRes.json()) as GitLabUser;
        username = u.name ?? u.username;
        userId = u.id;
        userEmail = u.email;
      }
    } catch {
      // best-effort
    }

    const expiresAt =
      typeof json.expires_in === "number" && json.expires_in > 0
        ? Date.now() + json.expires_in * 1000
        : undefined;

    saveTokens({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: expiresAt,
      scope: json.scope,
      token_type: json.token_type ?? "Bearer",
      _client_id: clientId() || undefined,
      _client_secret: clientSecret() || undefined,
      _base_url: gitlabBaseUrl(),
      username,
      user_id: userId,
      email: userEmail,
      connected_at: new Date().toISOString(),
    });
    resetGitLabConnector();

    return {
      status: 200,
      contentType: "text/html",
      body: `<html><body><h2>GitLab connected${username ? ` as ${escHtml(username)}` : ""}</h2><script>try { window.opener.postMessage('patchwork:gitlab:connected', '*'); } catch(_) {} window.close();</script></body></html>`,
    };
  } catch (err) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>GitLab connect failed</h2><pre>${escHtml(err instanceof Error ? err.message : String(err))}</pre></body></html>`,
    };
  }
}

/**
 * POST /connections/gitlab/test — verify stored token works.
 */
export async function handleGitLabTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "GitLab not connected" }),
    };
  }
  try {
    const connector = getGitLabConnector();
    const check = await connector.healthCheck();
    return {
      status: check.ok ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(
        check.ok
          ? { ok: true, username: tokens.username }
          : { ok: false, error: check.error?.message },
      ),
    };
  } catch (err) {
    return {
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

/**
 * DELETE /connections/gitlab — best-effort revoke at GitLab + drop locally.
 */
export async function handleGitLabDisconnect(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (tokens?.access_token && isConfigured()) {
    try {
      await fetch(revokeUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: tokens.access_token,
          client_id: clientId(),
          client_secret: clientSecret(),
        }).toString(),
      });
    } catch {
      // ignore — still drop local tokens
    }
  }
  clearTokens();
  resetGitLabConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
