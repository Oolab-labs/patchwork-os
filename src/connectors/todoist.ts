/**
 * Todoist connector — manage tasks and projects via the Todoist REST API v2.
 *
 * Auth: API token (personal or app token).
 *   - Env var: TODOIST_API_KEY overrides stored token for CI/headless use.
 *   - Stored: getSecretJsonSync("todoist") → TodoistTokens
 *
 * Tools: getTasks, getTask, createTask, updateTask, closeTask, reopenTask,
 *        deleteTask, getProjects, createProject, getLabels
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 */

import crypto from "node:crypto";
import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
} from "./baseConnector.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

const TODOIST_BASE = "https://api.todoist.com/rest/v2";

export interface TodoistTokens {
  apiToken: string;
  email?: string;
  connected_at: string;
}

// ------------------------------------------------------------------ API types

export interface TodoistDue {
  date: string;
  string: string;
  lang: string;
  is_recurring: boolean;
  datetime?: string;
  timezone?: string;
}

export interface TodoistTask {
  id: string;
  content: string;
  description: string;
  project_id: string;
  section_id: string | null;
  parent_id: string | null;
  order: number;
  priority: number;
  due: TodoistDue | null;
  labels: string[];
  is_completed: boolean;
  created_at: string;
  url: string;
  assignee_id?: string | null;
  assigner_id?: string | null;
  comment_count: number;
  creator_id: string;
}

export interface TodoistProject {
  id: string;
  name: string;
  color: string;
  parent_id: string | null;
  order: number;
  is_favorite: boolean;
  is_inbox_project: boolean;
  is_team_inbox: boolean;
  is_shared: boolean;
  url: string;
}

export interface TodoistLabel {
  id: string;
  name: string;
  color: string;
  order: number;
  is_favorite: boolean;
}

// ------------------------------------------------------------------ token helpers

export function loadTokens(): TodoistTokens | null {
  const envToken = process.env.TODOIST_API_KEY;
  if (envToken) {
    return {
      apiToken: envToken,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<TodoistTokens>("todoist");
}

export function saveTokens(tokens: TodoistTokens): void {
  storeSecretJsonSync("todoist", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("todoist");
  } catch {
    /* already gone */
  }
}

// ------------------------------------------------------------------ webhook helper

/**
 * Verify a Todoist webhook payload.
 * Todoist signs the raw request body with HMAC-SHA256 and sends the result
 * as a base64-encoded value in the `X-Todoist-Hmac-SHA256` header.
 */
export function verifyTodoistWebhook(
  rawBody: string | Buffer,
  hmacHeader: string,
  clientSecret: string,
): boolean {
  const computed = crypto
    .createHmac("sha256", clientSecret)
    .update(rawBody)
    .digest("base64");
  // Constant-time compare
  const a = Buffer.from(computed);
  const b = Buffer.from(hmacHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------------ connector

export class TodoistConnector extends BaseConnector {
  readonly providerName = "todoist";

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Todoist not connected. Run: patchwork connect todoist  or set TODOIST_API_KEY",
      );
    }
    return { token: tokens.apiToken };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async (token) => {
        const res = await fetch(`${TODOIST_BASE}/projects`, {
          headers: this.buildHeaders(token),
        });
        if (!res.ok)
          throw Object.assign(new Error(`HTTP ${res.status}`), {
            status: res.status,
          });
        return res.json();
      });
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    if (
      error instanceof Response ||
      (error && typeof error === "object" && "status" in error)
    ) {
      const status = (error as { status: number }).status;
      if (status === 401)
        return {
          code: "auth_expired",
          message: "Todoist token expired or invalid",
          retryable: false,
          suggestedAction: "Reconnect: patchwork connect todoist",
        };
      if (status === 403)
        return {
          code: "permission_denied",
          message: "Todoist token lacks permission for this resource",
          retryable: false,
        };
      if (status === 404)
        return {
          code: "not_found",
          message: "Todoist resource not found",
          retryable: false,
        };
      if (status === 429)
        return {
          code: "rate_limited",
          message: "Todoist API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Todoist API error: HTTP ${status}`,
        retryable: status >= 500,
      };
    }
    if (error instanceof Error) {
      if (
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ECONNREFUSED")
      ) {
        return {
          code: "network_error",
          message: `Cannot reach Todoist API: ${error.message}`,
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
      id: "todoist",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.email,
    };
  }

  private buildHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  // ---------------------------------------------------------------- task ops

  async getTasks(
    projectId?: string,
    filter?: string,
    limit?: number,
  ): Promise<TodoistTask[]> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams();
      if (projectId) qs.set("project_id", projectId);
      if (filter) qs.set("filter", filter);
      if (limit != null) qs.set("limit", String(limit));
      const url = `${TODOIST_BASE}/tasks${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url, { headers: this.buildHeaders(token) });
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<TodoistTask[]>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async getTask(id: string): Promise<TodoistTask> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${TODOIST_BASE}/tasks/${id}`, {
        headers: this.buildHeaders(token),
      });
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<TodoistTask>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async createTask(
    content: string,
    projectId?: string,
    description?: string,
    dueString?: string,
    priority?: number,
    labels?: string[],
  ): Promise<TodoistTask> {
    const result = await this.apiCall(async (token) => {
      const body: Record<string, unknown> = { content };
      if (projectId) body.project_id = projectId;
      if (description) body.description = description;
      if (dueString) body.due_string = dueString;
      if (priority != null) body.priority = priority;
      if (labels) body.labels = labels;

      const res = await fetch(`${TODOIST_BASE}/tasks`, {
        method: "POST",
        headers: this.buildHeaders(token),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<TodoistTask>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async updateTask(
    id: string,
    content?: string,
    description?: string,
    dueString?: string,
    priority?: number,
    labels?: string[],
  ): Promise<TodoistTask> {
    const result = await this.apiCall(async (token) => {
      const body: Record<string, unknown> = {};
      if (content != null) body.content = content;
      if (description != null) body.description = description;
      if (dueString != null) body.due_string = dueString;
      if (priority != null) body.priority = priority;
      if (labels != null) body.labels = labels;

      const res = await fetch(`${TODOIST_BASE}/tasks/${id}`, {
        method: "POST",
        headers: this.buildHeaders(token),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<TodoistTask>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async closeTask(id: string): Promise<void> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${TODOIST_BASE}/tasks/${id}/close`, {
        method: "POST",
        headers: this.buildHeaders(token),
      });
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return null;
    });
    if (result && "error" in result) throw new Error(result.error.message);
  }

  async reopenTask(id: string): Promise<void> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${TODOIST_BASE}/tasks/${id}/reopen`, {
        method: "POST",
        headers: this.buildHeaders(token),
      });
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return null;
    });
    if (result && "error" in result) throw new Error(result.error.message);
  }

  async deleteTask(id: string): Promise<void> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${TODOIST_BASE}/tasks/${id}`, {
        method: "DELETE",
        headers: this.buildHeaders(token),
      });
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return null;
    });
    if (result && "error" in result) throw new Error(result.error.message);
  }

  // ---------------------------------------------------------------- project ops

  async getProjects(): Promise<TodoistProject[]> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${TODOIST_BASE}/projects`, {
        headers: this.buildHeaders(token),
      });
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<TodoistProject[]>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async createProject(
    name: string,
    parentId?: string,
    color?: string,
    isFavorite?: boolean,
  ): Promise<TodoistProject> {
    const result = await this.apiCall(async (token) => {
      const body: Record<string, unknown> = { name };
      if (parentId) body.parent_id = parentId;
      if (color) body.color = color;
      if (isFavorite != null) body.is_favorite = isFavorite;

      const res = await fetch(`${TODOIST_BASE}/projects`, {
        method: "POST",
        headers: this.buildHeaders(token),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<TodoistProject>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  // ---------------------------------------------------------------- label ops

  async getLabels(): Promise<TodoistLabel[]> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${TODOIST_BASE}/labels`, {
        headers: this.buildHeaders(token),
      });
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<TodoistLabel[]>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }
}

// ------------------------------------------------------------------ singleton

let _instance: TodoistConnector | null = null;

export function getTodoistConnector(): TodoistConnector {
  if (!_instance) _instance = new TodoistConnector();
  return _instance;
}

export function resetTodoistConnector(): void {
  _instance = null;
}

// ------------------------------------------------------------------ HTTP handlers
// Wired in src/server.ts under /connections/todoist/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/todoist/connect  { apiToken: "..." }
 * Verifies the token by calling GET /projects; stores on success.
 */
export async function handleTodoistConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let apiToken: string;
  try {
    const parsed = JSON.parse(body) as { apiToken?: unknown };
    if (typeof parsed.apiToken !== "string" || !parsed.apiToken) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "apiToken is required" }),
      };
    }
    apiToken = parsed.apiToken;
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const res = await fetch(`${TODOIST_BASE}/projects`, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Token rejected by Todoist API (HTTP ${res.status}) — check the token is valid`,
        }),
      };
    }

    const tokens: TodoistTokens = {
      apiToken,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetTodoistConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        connectedAt: tokens.connected_at,
      }),
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
 * POST /connections/todoist/test
 * Verifies stored token is still valid.
 */
export async function handleTodoistTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Todoist not connected" }),
    };
  }
  try {
    const connector = getTodoistConnector();
    const check = await connector.healthCheck();
    return {
      status: check.ok ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(
        check.ok ? { ok: true } : { ok: false, error: check.error?.message },
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
 * DELETE /connections/todoist
 * Removes stored token.
 */
export function handleTodoistDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetTodoistConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
