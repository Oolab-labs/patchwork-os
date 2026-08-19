/**
 * Todoist connector — manage tasks and projects via the Todoist unified API v1.
 *
 * REST v2 answers 410 Gone. The base URL moved to v1; the response interfaces
 * below moved with it on 2026-08-19, nine days later — see `TodoistTask`.
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

// Todoist retired REST v2 — it answers 410 Gone, so every call through this
// connector failed regardless of the token. The unified API is v1; it keeps the
// same paths but wraps LIST responses in { results, next_cursor }.
const TODOIST_BASE = "https://api.todoist.com/api/v1";

/** A v1 list response. Single-resource endpoints still return the object. */
interface TodoistListEnvelope<T> {
  results: T[];
  next_cursor: string | null;
}

/**
 * Unwrap a v1 list response. Tolerates a bare array so a future shape change,
 * or an endpoint that never adopted the envelope, degrades to the old
 * behaviour instead of throwing.
 */
function unwrapList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const env = body as TodoistListEnvelope<T> | null;
  return env && Array.isArray(env.results) ? env.results : [];
}

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

/**
 * A task as the v1 API sends it.
 *
 * These names are v1's, not REST v2's, and the difference is not cosmetic. The
 * base URL moved to v1 when v2 started answering 410 Gone; this interface did
 * not move with it, so for nine days it declared six fields the wire never
 * sent. Two of them were read to make a decision:
 *
 *   `is_completed` → v1 sends `checked` (plus `completed_at`)
 *   `created_at`   → v1 sends `added_at`
 *
 * `observeTask` read both, so a Butler errand the operator had genuinely
 * completed graded `unknown` / `open-recent` and no filing could ever earn
 * trust. A blind `res.json() as Promise<TodoistTask>` cast reports nothing when
 * it is wrong: the fields simply arrive `undefined`.
 *
 * The others — `url`, `order`, `comment_count`, `creator_id`, `assignee_id`,
 * `assigner_id` — are removed rather than renamed where v1 has no counterpart.
 * `url` in particular never existed on v1: Todoist exposes no task permalink,
 * which is why the outcome join key had to be generalised to `<tool>:<id>`.
 *
 * Key set captured from the live API on 2026-08-19; the shared test fixture
 * (`__tests__/todoistV1Fixture.ts`) carries the same set and is asserted
 * against it.
 */
export interface TodoistTask {
  id: string;
  content: string;
  description: string;
  project_id: string;
  section_id: string | null;
  parent_id: string | null;
  /** v1's ordering field. Was declared `order`, which v1 does not send. */
  child_order: number;
  day_order: number;
  priority: number;
  due: TodoistDue | null;
  deadline: unknown | null;
  duration: unknown | null;
  labels: string[];
  /** Completion flag. Was declared `is_completed`, which v1 does not send. */
  checked: boolean;
  completed_at: string | null;
  completed_by_uid: string | null;
  completed_count: number;
  /** Creation stamp. Was declared `created_at`, which v1 does not send. */
  added_at: string;
  added_by_uid: string | null;
  updated_at: string;
  assigned_by_uid?: string | null;
  responsible_uid?: string | null;
  user_id: string;
  note_count: number;
  postponed_count: number;
  is_collapsed: boolean;
  is_deleted: boolean;
}

/**
 * A project as the v1 API sends it.
 *
 * Same migration, same miss: `order` is `child_order`, `is_inbox_project` is
 * `inbox_project`, `is_team_inbox` does not exist, and there is no `url`.
 *
 * Note the asymmetry with `TodoistTask`, which is real rather than a
 * transcription slip: projects DO carry `created_at`; tasks carry `added_at`.
 * That is a large part of why the task interface's `created_at` looked right.
 */
export interface TodoistProject {
  id: string;
  name: string;
  color: string;
  description: string;
  parent_id: string | null;
  child_order: number;
  default_order: number;
  order_key: string;
  is_favorite: boolean;
  inbox_project: boolean;
  is_shared: boolean;
  is_archived: boolean;
  is_collapsed: boolean;
  is_deleted: boolean;
  is_frozen: boolean;
  can_assign_tasks: boolean;
  can_comment: boolean;
  view_style: string;
  created_at: string;
  updated_at: string;
  creator_uid: string;
}

/**
 * A label as the v1 API sends it.
 *
 * DELIBERATELY LEFT AS DECLARED. The account used to capture the task and
 * project shapes has no labels, so `GET /labels` returned an empty list and
 * there is no observed item shape to correct this against. Rewriting it from
 * the pattern of its siblings would be a guess wearing the same clothes as the
 * measurements above, and this file is a demonstration of what that costs.
 */
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
 *
 * NO INGRESS PATH — deliberate, do not "clean up". Audited 2026-08-02 (#1216):
 * this function is complete and correct, but nothing in `src/` outside this
 * file calls it. `POST /hooks/*` (`src/server.ts`) accepts exactly two
 * credentials — a Bearer token, or `X-Hub-Signature-256` HMAC'd with the
 * bridge's own `--webhook-secret` — and never reads Todoist's HMAC header. A
 * provider signs with ITS secret under ITS header, so its delivery is rejected
 * at the outer gate before this could ever run. That is a feature gap, not a
 * hole: the gate fails closed, nothing is accepted-but-unverified.
 *
 * Wiring it up needs per-connector signing-secret storage (today there is one
 * global `--webhook-secret`), header dispatch in the gate with the same
 * multi-value/missing fail-closed handling as `readSingleSignatureHeader`,
 * raw-body preservation per route, and a decision on whether provider
 * verification replaces or supplements the bearer gate. Deferred until a user
 * actually wants this provider's webhooks; do one connector end-to-end first.
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
      return unwrapList<TodoistTask>(await res.json());
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

  /**
   * Observe a task for outcome grading — the ONE call the Butler ingester
   * makes, and deliberately not `getTask`.
   *
   * `getTask` throws on every failure, which collapses three different facts
   * into one: the task is gone, the token expired, the network is down. The
   * grader's contract is explicit that a lookup failure must be reported as
   * `undefined` and never as `deleted: true` — "a transient API error that
   * reads as deletion would manufacture a negative against a worker that did
   * nothing wrong."
   *
   * So this returns a discriminated result instead of throwing:
   *
   *   `observed`     — HTTP 200. `completed` is the task's own flag.
   *   `deleted`      — HTTP 404 ONLY. Todoist returns 404 for a deleted task,
   *                    and `not_found` is already a distinct error code here,
   *                    so this does not have to infer deletion from a message.
   *   `unavailable`  — everything else: 401, 403, 429, 5xx, network. NOT an
   *                    observation, and the caller must not treat it as one.
   *
   * Additive on purpose. Changing `getTask` would alter behaviour for every
   * existing caller to serve one new one.
   */
  /**
   * Read one task's current state for the Butler observation channel.
   *
   * `createdAt` is OPTIONAL, and that is the fix for the subtler half of the
   * v1 field mismatch. It previously read `created_at` — absent on v1 — so
   * `Date.parse` returned NaN and the guard below substituted `Date.now()`.
   * The guard is right that 0 would be read as 1970 and graded `junk`; it was
   * wrong to answer with a fabricated timestamp instead, because "created just
   * now" is what the staleness horizon measures, and refreshing it on every
   * run put `stale-unactioned` permanently out of reach. Silently: the channel
   * reported a clean observation throughout.
   *
   * Omitting it is the honest third answer. The grader checks `completed`
   * FIRST, so a real completion still confirms; only the age-based branch
   * withholds, which is exactly what "we could not read its age" means.
   */
  async observeTask(
    id: string,
  ): Promise<
    | { kind: "observed"; completed: boolean; createdAt?: number }
    | { kind: "deleted" }
    | { kind: "unavailable"; reason: string }
  > {
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
    if ("error" in result) {
      if (result.error.code === "not_found") return { kind: "deleted" };
      return { kind: "unavailable", reason: result.error.code };
    }
    const createdAt = Date.parse(result.data.added_at);
    return {
      kind: "observed",
      completed: result.data.checked === true,
      // An unparseable stamp yields NO age rather than a made-up one. Zero
      // reads as 1970 and grades `junk` — a negative manufactured from a parse
      // failure. `Date.now()` reads as brand new, which is what hid the v1
      // field rename for nine days. Neither is an observation of age.
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
    };
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
      return unwrapList<TodoistProject>(await res.json());
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
      // `unwrapList`, like its siblings. This was the one list endpoint the v1
      // migration missed, so it returned the raw `{ results, next_cursor }`
      // envelope typed as an array: `.length` undefined, `.map` a TypeError.
      // Latent rather than live only because nothing calls it yet.
      return unwrapList<TodoistLabel>(await res.json());
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
