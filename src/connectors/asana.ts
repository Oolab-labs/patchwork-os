/**
 * Asana connector — read workspaces, projects, tasks, and current user, plus
 * writes (createTask, updateTask, completeTask, addTaskComment).
 *
 * OAuth 2.0 Authorization Code Grant. Asana is a confidential client (bridge
 * holds client secret), so PKCE is not used. Refresh tokens are issued; access
 * tokens expire after 1 hour (3600s).
 *
 * Auth: standard OAuth 2.0 with `client_id` + `client_secret` + `redirect_uri`.
 *   - Env vars: ASANA_CLIENT_ID, ASANA_CLIENT_SECRET (mirrors discord/slack)
 *   - Stored: getSecretJsonSync("asana") → AsanaTokens
 *   - Header: Authorization: Bearer <access_token>
 *
 * Scope note: Asana's only OAuth scope is `default`, which grants read+write
 * combined — there is no read-only-only scope. Defense lives at the recipe-tool
 * layer where each tool declares `isWrite: true|false`. Newer Asana accounts
 * may also expose granular scopes; we set `default` for compatibility.
 *
 * Read tools: getCurrentUser, listWorkspaces, listProjects, listTasks, getTask.
 * Write tools: createTask, updateTask, completeTask, addTaskComment.
 *
 * Idempotency: Asana doesn't honor an Idempotency-Key header. Writes simply
 * throw on error — callers must dedupe via app-level checks if needed.
 *
 * HTTP routes (wired in src/server.ts):
 *   GET    /connections/asana/auth     — redirect to Asana consent
 *   GET    /connections/asana/callback — exchange code for tokens
 *   POST   /connections/asana/test     — ping Asana API
 *   DELETE /connections/asana          — clear stored tokens
 *
 * Asana wraps every API response in `{ data: ... }`. We unwrap consistently
 * inside this class so recipe-tool wrappers see clean arrays/objects.
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

const ASANA_API_BASE = "https://app.asana.com/api/1.0";
const ASANA_AUTH_URL = "https://app.asana.com/-/oauth_authorize";
const ASANA_TOKEN_URL = "https://app.asana.com/-/oauth_token";
const SCOPES = ["default"];

export interface AsanaTokens {
  access_token: string;
  refresh_token?: string;
  /** ms since epoch; absolute, not relative */
  expires_at?: number;
  scope?: string;
  token_type?: string;
  /** stored at auth time so refresh works even if env vars are absent */
  _client_id?: string;
  _client_secret?: string;
  username?: string;
  user_gid?: string;
  email?: string;
  connected_at: string;
}

export interface AsanaUser {
  gid: string;
  name: string;
  email?: string;
  resource_type?: string;
  photo?: { image_60x60?: string } | null;
}

export interface AsanaWorkspace {
  gid: string;
  name: string;
  resource_type?: string;
  is_organization?: boolean;
}

export interface AsanaProject {
  gid: string;
  name: string;
  resource_type?: string;
  archived?: boolean;
}

export interface AsanaTask {
  gid: string;
  name: string;
  resource_type?: string;
  completed?: boolean;
  assignee?: { gid: string; name?: string } | null;
  due_on?: string | null;
  notes?: string;
}

export interface AsanaStory {
  gid: string;
  resource_type?: string;
  type?: string;
  text?: string;
  created_at?: string;
  created_by?: { gid: string; name?: string } | null;
}

export interface CreateTaskParams {
  workspaceGid: string;
  name: string;
  projectGid?: string;
  notes?: string;
  assigneeGid?: string;
  /** ISO date YYYY-MM-DD */
  dueOn?: string;
  parentTaskGid?: string;
}

export interface UpdateTaskParams {
  name?: string;
  notes?: string;
  completed?: boolean;
  assigneeGid?: string;
  /** ISO date YYYY-MM-DD */
  dueOn?: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

function clientId(): string {
  return process.env.ASANA_CLIENT_ID ?? "";
}

function clientSecret(): string {
  return process.env.ASANA_CLIENT_SECRET ?? "";
}

function redirectUri(): string {
  const base = (
    process.env.PATCHWORK_BRIDGE_URL ??
    `http://localhost:${process.env.PATCHWORK_BRIDGE_PORT ?? "3101"}`
  ).replace(/\/$/, "");
  return `${base}/connections/asana/callback`;
}

function isConfigured(): boolean {
  return Boolean(clientId() && clientSecret());
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): AsanaTokens | null {
  return getSecretJsonSync<AsanaTokens>("asana");
}

export function saveTokens(tokens: AsanaTokens): void {
  storeSecretJsonSync("asana", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("asana");
  } catch {
    // ignore
  }
}

export function isConnected(): boolean {
  return loadTokens() !== null;
}

// ── State (CSRF) ─────────────────────────────────────────────────────────────
// In-memory map keyed by hex random — short-lived (5 min). Mirrors discord's
// approach (Set + setTimeout).

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

export class AsanaConnector extends BaseConnector {
  readonly providerName = "asana";

  protected getOAuthConfig(): OAuthConfig | null {
    // Resolve credentials from env first, then fall back to credentials we
    // stored at auth time (so refresh keeps working even if env is unset).
    const tokens = loadTokens();
    const id = clientId() || tokens?._client_id || "";
    const secret = clientSecret() || tokens?._client_secret || "";
    if (!id || !secret) return null;
    return {
      clientId: id,
      clientSecret: secret,
      tokenEndpoint: ASANA_TOKEN_URL,
      scopes: SCOPES,
    };
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Asana not connected. Visit /connections/asana/auth to authorize.",
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
   * `this.auth`. BaseConnector calls `saveTokens()` (its own method on the
   * tokenStorage StoredToken shape); we additionally mirror to our
   * Asana-specific JSON so loadTokens() keeps working for HTTP probes.
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
      username: existing?.username,
      user_gid: existing?.user_gid,
      email: existing?.email,
      connected_at: existing?.connected_at ?? new Date().toISOString(),
    });
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async (token) => {
        const res = await fetch(`${ASANA_API_BASE}/users/me`, {
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
      // Asana 4xx payloads have an `errors: [{message, help}]` array — surface
      // the first message when we can. We can't await here because the body
      // may already be consumed; callers that want detail should pre-read.
      const detail = (error as Response & { _asanaDetail?: string })
        ._asanaDetail;
      const tag = detail ? `: ${detail}` : "";
      if (s === 401)
        return {
          code: "auth_expired",
          message: `Asana authentication failed — token expired or revoked${tag}`,
          retryable: true,
          suggestedAction: "Reconnect via /connections/asana/auth",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: `Insufficient Asana permissions for this resource${tag}`,
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: `Asana resource not found${tag}`,
          retryable: false,
        };
      if (s === 429) {
        const retryAfter = error.headers.get("retry-after");
        return {
          code: "rate_limited",
          message: `Asana API rate limit exceeded${retryAfter ? ` (retry after ${retryAfter}s)` : ""}${tag}`,
          retryable: true,
          suggestedAction: retryAfter
            ? `Wait ${retryAfter}s and retry`
            : "Wait and retry",
          providerDetail: retryAfter ? { retryAfter } : undefined,
        };
      }
      return {
        code: "provider_error",
        message: `Asana API error: HTTP ${s}${tag}`,
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
          message: `Cannot connect to Asana: ${error.message}`,
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
      id: "asana",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.username,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async getCurrentUser(): Promise<AsanaUser> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${ASANA_API_BASE}/users/me`, {
        headers: this.buildHeaders(token),
      });
      this.captureRateLimit(res);
      if (!res.ok) throw await this.attachErrorDetail(res);
      const json = (await res.json()) as { data: AsanaUser };
      return json.data;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as AsanaUser;
  }

  async listWorkspaces(
    params: { limit?: number } = {},
  ): Promise<AsanaWorkspace[]> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({
        limit: String(Math.min(Math.max(params.limit ?? 50, 1), 100)),
      });
      const res = await fetch(`${ASANA_API_BASE}/workspaces?${qs}`, {
        headers: this.buildHeaders(token),
      });
      this.captureRateLimit(res);
      if (!res.ok) throw await this.attachErrorDetail(res);
      const json = (await res.json()) as { data: AsanaWorkspace[] };
      return json.data;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as AsanaWorkspace[];
  }

  async listProjects(params: {
    workspaceGid: string;
    limit?: number;
  }): Promise<AsanaProject[]> {
    if (!params.workspaceGid) {
      throw new Error("listProjects requires workspaceGid");
    }
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({
        workspace: params.workspaceGid,
        limit: String(Math.min(Math.max(params.limit ?? 50, 1), 100)),
      });
      const res = await fetch(`${ASANA_API_BASE}/projects?${qs}`, {
        headers: this.buildHeaders(token),
      });
      this.captureRateLimit(res);
      if (!res.ok) throw await this.attachErrorDetail(res);
      const json = (await res.json()) as { data: AsanaProject[] };
      return json.data;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as AsanaProject[];
  }

  async listTasks(
    params: {
      projectGid?: string;
      assignee?: string;
      workspaceGid?: string;
      limit?: number;
    } = {},
  ): Promise<AsanaTask[]> {
    // Asana's GET /tasks requires either `project` OR (`assignee` + `workspace`).
    // Asana itself returns a 400 when this is wrong; we surface a clearer error
    // up front so recipe authors see the real problem instantly.
    const hasProject = Boolean(params.projectGid);
    const hasAssigneePair = Boolean(params.assignee && params.workspaceGid);
    if (!hasProject && !hasAssigneePair) {
      throw new Error(
        "listTasks requires either projectGid, or assignee + workspaceGid",
      );
    }

    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({
        limit: String(Math.min(Math.max(params.limit ?? 50, 1), 100)),
      });
      if (params.projectGid) qs.set("project", params.projectGid);
      if (params.assignee) qs.set("assignee", params.assignee);
      if (params.workspaceGid) qs.set("workspace", params.workspaceGid);

      const res = await fetch(`${ASANA_API_BASE}/tasks?${qs}`, {
        headers: this.buildHeaders(token),
      });
      this.captureRateLimit(res);
      if (!res.ok) throw await this.attachErrorDetail(res);
      const json = (await res.json()) as { data: AsanaTask[] };
      return json.data;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as AsanaTask[];
  }

  async getTask(taskGid: string): Promise<AsanaTask> {
    if (!taskGid) throw new Error("getTask requires taskGid");
    const result = await this.apiCall(async (token) => {
      const res = await fetch(
        `${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}`,
        { headers: this.buildHeaders(token) },
      );
      this.captureRateLimit(res);
      if (!res.ok) throw await this.attachErrorDetail(res);
      const json = (await res.json()) as { data: AsanaTask };
      return json.data;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as AsanaTask;
  }

  // ── Write methods ──────────────────────────────────────────────────────────
  // Asana wraps both request and response bodies in `{ data: ... }`. We
  // unwrap the response consistently here so recipe-tool wrappers see the
  // clean object. Required-param validation happens up front so recipe
  // authors get a clear error instead of an Asana 400.

  async createTask(params: CreateTaskParams): Promise<AsanaTask> {
    if (!params.name) throw new Error("createTask requires name");
    if (!params.workspaceGid) {
      throw new Error("createTask requires workspaceGid");
    }
    const result = await this.apiCall(async (token) => {
      const data: Record<string, unknown> = {
        workspace: params.workspaceGid,
        name: params.name,
      };
      if (params.projectGid) data.projects = [params.projectGid];
      if (params.notes !== undefined) data.notes = params.notes;
      if (params.assigneeGid) data.assignee = params.assigneeGid;
      if (params.dueOn) data.due_on = params.dueOn;
      if (params.parentTaskGid) data.parent = params.parentTaskGid;

      const res = await fetch(`${ASANA_API_BASE}/tasks`, {
        method: "POST",
        headers: this.buildHeaders(token),
        body: JSON.stringify({ data }),
      });
      this.captureRateLimit(res);
      if (!res.ok) throw await this.attachErrorDetail(res);
      const json = (await res.json()) as { data: AsanaTask };
      return json.data;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as AsanaTask;
  }

  async updateTask(
    taskGid: string,
    updates: UpdateTaskParams,
  ): Promise<AsanaTask> {
    if (!taskGid) throw new Error("updateTask requires taskGid");
    // Strip undefined keys — Asana interprets `undefined`-stringified values
    // differently than missing keys. Only forward fields that were explicitly
    // provided by the caller.
    const data: Record<string, unknown> = {};
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.notes !== undefined) data.notes = updates.notes;
    if (updates.completed !== undefined) data.completed = updates.completed;
    if (updates.assigneeGid !== undefined) data.assignee = updates.assigneeGid;
    if (updates.dueOn !== undefined) data.due_on = updates.dueOn;

    if (Object.keys(data).length === 0) {
      throw new Error("updateTask requires at least one field to update");
    }

    const result = await this.apiCall(async (token) => {
      const res = await fetch(
        `${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}`,
        {
          method: "PUT",
          headers: this.buildHeaders(token),
          body: JSON.stringify({ data }),
        },
      );
      this.captureRateLimit(res);
      if (!res.ok) throw await this.attachErrorDetail(res);
      const json = (await res.json()) as { data: AsanaTask };
      return json.data;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as AsanaTask;
  }

  /**
   * Convenience wrapper around updateTask that flips `completed: true`. Lower
   * risk than other updates since it's a single, well-known state transition.
   */
  async completeTask(taskGid: string): Promise<AsanaTask> {
    if (!taskGid) throw new Error("completeTask requires taskGid");
    return this.updateTask(taskGid, { completed: true });
  }

  async addTaskComment(
    taskGid: string,
    options: { text: string },
  ): Promise<AsanaStory> {
    if (!taskGid) throw new Error("addTaskComment requires taskGid");
    if (!options.text)
      throw new Error("addTaskComment requires non-empty text");
    const result = await this.apiCall(async (token) => {
      const res = await fetch(
        `${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}/stories`,
        {
          method: "POST",
          headers: this.buildHeaders(token),
          body: JSON.stringify({
            data: { text: options.text, type: "comment" },
          }),
        },
      );
      this.captureRateLimit(res);
      if (!res.ok) throw await this.attachErrorDetail(res);
      const json = (await res.json()) as { data: AsanaStory };
      return json.data;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as AsanaStory;
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
        res.headers.get("x-ratelimit-remaining") ?? undefined,
      "x-ratelimit-reset": res.headers.get("x-ratelimit-reset") ?? undefined,
      "retry-after": res.headers.get("retry-after") ?? undefined,
    });
  }

  /**
   * Read the response body once and stash the first Asana `errors[].message`
   * onto a sidecar property so normalizeError can include it without a second
   * read. Returns the same Response for `throw` to consume.
   */
  private async attachErrorDetail(res: Response): Promise<Response> {
    try {
      const body = (await res.clone().json()) as {
        errors?: Array<{ message?: string }>;
      };
      const first = body?.errors?.[0]?.message;
      if (first) {
        (res as Response & { _asanaDetail?: string })._asanaDetail = first;
      }
    } catch {
      // body wasn't JSON or already consumed — proceed without detail
    }
    return res;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: AsanaConnector | null = null;

function resetAsanaConnector(): void {
  _instance = null;
}

export function getAsanaConnector(): AsanaConnector {
  if (!_instance) {
    _instance = new AsanaConnector();
  }
  return _instance;
}

export { getAsanaConnector as asana };

// ── HTTP Handlers ────────────────────────────────────────────────────────────

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
  redirect?: string;
}

/**
 * GET /connections/asana/auth — redirect to Asana consent screen.
 */
export function handleAsanaAuthorize(): ConnectorHandlerResult {
  if (!isConfigured()) {
    return {
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error:
          "Asana connector not configured. Set ASANA_CLIENT_ID and ASANA_CLIENT_SECRET.",
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
    redirect: `${ASANA_AUTH_URL}?${params.toString()}`,
  };
}

/**
 * GET /connections/asana/callback — exchange code for tokens.
 */
export async function handleAsanaCallback(
  code: string | null,
  state: string | null,
  error: string | null,
): Promise<ConnectorHandlerResult> {
  if (error) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Asana connect failed</h2><pre>${escHtml(error)}</pre></body></html>`,
    };
  }
  if (!code || !state) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Asana connect failed</h2><pre>missing code or state</pre></body></html>`,
    };
  }
  if (!consumeState(state)) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Asana connect failed</h2><pre>invalid or expired state</pre></body></html>`,
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
    const res = await fetch(ASANA_TOKEN_URL, {
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
      data?: { id?: number; gid?: string; name?: string; email?: string };
    };
    if (!json.access_token) {
      throw new Error("Token exchange returned no access_token");
    }

    // Asana's token response includes `data: { gid, name, email }` for the
    // authorizing user — use that if present, otherwise fall back to /users/me.
    let username: string | undefined = json.data?.name;
    let userGid: string | undefined =
      json.data?.gid ??
      (typeof json.data?.id === "number" ? String(json.data.id) : undefined);
    let userEmail: string | undefined = json.data?.email;
    if (!username) {
      try {
        const userRes = await fetch(`${ASANA_API_BASE}/users/me`, {
          headers: { Authorization: `Bearer ${json.access_token}` },
        });
        if (userRes.ok) {
          const u = (await userRes.json()) as { data: AsanaUser };
          username = u.data?.name;
          userGid = u.data?.gid ?? userGid;
          userEmail = u.data?.email ?? userEmail;
        }
      } catch {
        // best-effort
      }
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
      username,
      user_gid: userGid,
      email: userEmail,
      connected_at: new Date().toISOString(),
    });
    resetAsanaConnector();

    return {
      status: 200,
      contentType: "text/html",
      body: `<html><body><h2>Asana connected${username ? ` as ${escHtml(username)}` : ""}</h2><script>try { window.opener.postMessage('patchwork:asana:connected', '*'); } catch(_) {} window.close();</script></body></html>`,
    };
  } catch (err) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Asana connect failed</h2><pre>${escHtml(err instanceof Error ? err.message : String(err))}</pre></body></html>`,
    };
  }
}

/**
 * POST /connections/asana/test — verify stored token works.
 */
export async function handleAsanaTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Asana not connected" }),
    };
  }
  try {
    const connector = getAsanaConnector();
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
 * DELETE /connections/asana — clear stored tokens.
 *
 * Asana does not expose a public OAuth revocation endpoint, so we just drop
 * local credentials. The token remains valid at Asana until it naturally
 * expires (1h) or the user revokes the integration in their Asana account
 * settings.
 */
export async function handleAsanaDisconnect(): Promise<ConnectorHandlerResult> {
  clearTokens();
  resetAsanaConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
