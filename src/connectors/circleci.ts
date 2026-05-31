/**
 * CircleCI connector — pipeline + workflow management via the CircleCI v2 API.
 *
 * Auth: PAT via `Circle-Token` header (NOT Bearer).
 *   - Env var: CIRCLECI_API_TOKEN
 *   - Stored: getSecretJsonSync("circleci") → CircleCITokens
 *
 * Tools: getProject, getPipelines, getPipeline, triggerPipeline,
 *        getPipelineWorkflows, getWorkflow, getWorkflowJobs, cancelWorkflow,
 *        approveJob, getJob, listWebhooks, createWebhook, deleteWebhook
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
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

// ── Token shape ──────────────────────────────────────────────────────────────

export interface CircleCITokens {
  apiToken: string;
  login?: string;
  connected_at: string;
}

// ── API types ────────────────────────────────────────────────────────────────

export interface CircleCIPipeline {
  id: string;
  project_slug: string;
  state: "created" | "errored" | "setup-pending" | "setup" | "pending";
  number: number;
  trigger: {
    type: string;
    received_at: string;
  };
  vcs?: {
    branch?: string;
    tag?: string;
    commit?: {
      oid?: string;
      subject?: string;
    };
  };
  created_at?: string;
  updated_at?: string;
}

export interface CircleCIWorkflow {
  id: string;
  name: string;
  status:
    | "success"
    | "running"
    | "not_run"
    | "failed"
    | "error"
    | "failing"
    | "on_hold"
    | "canceled"
    | "unauthorized";
  pipeline_id: string;
  pipeline_number?: number;
  project_slug?: string;
  started_by: string;
  created_at: string;
  stopped_at?: string | null;
}

export interface CircleCIJob {
  id: string;
  name: string;
  status: string;
  job_number?: number;
  type: "build" | "approval";
  created_at?: string;
  started_at?: string | null;
  stopped_at?: string | null;
  approval_request_id?: string;
  dependencies?: string[];
}

export interface CircleCIWebhook {
  id: string;
  name: string;
  url: string;
  scope: { id: string; type: string };
  events: string[];
  verify_tls: boolean;
  signing_secret: string;
  created_at?: string;
  updated_at?: string;
}

export interface CircleCIProject {
  slug: string;
  name: string;
  id?: string;
  organization_name?: string;
  vcs_url?: string;
}

export interface CircleCITriggerResult {
  id: string;
  state: string;
  number: number;
  created_at: string;
}

const BASE_URL = "https://circleci.com/api/v2";

// ── Connector ────────────────────────────────────────────────────────────────

export class CircleCIConnector extends BaseConnector {
  readonly providerName = "circleci";
  private tokens: CircleCITokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "CircleCI not connected. Run: patchwork connect circleci or set CIRCLECI_API_TOKEN",
      );
    }
    this.tokens = tokens;
    return { token: tokens.apiToken, scopes: ["read", "write"] };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const tokens = this.tokens ?? loadTokens();
      if (!tokens) {
        return {
          ok: false,
          error: {
            code: "auth_expired",
            message: "CircleCI not connected",
            retryable: false,
          },
        };
      }
      this.tokens = tokens;
      const result = await this.apiCall(async () => {
        const res = await fetch(`${BASE_URL}/me`, {
          headers: this.buildHeaders(),
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
          message: "CircleCI authentication failed — check your API token",
          retryable: false,
          suggestedAction: "patchwork connect circleci",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient CircleCI permissions for this resource",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "CircleCI resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "CircleCI API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `CircleCI API error: HTTP ${s}`,
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
          message: `Cannot connect to CircleCI: ${error.message}`,
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
      id: "circleci",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.login ? `CircleCI: ${tokens.login}` : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async getProject(slug: string): Promise<CircleCIProject> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("CircleCI not connected");
    this.tokens = tokens;
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/project/${encodeSlug(slug)}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<CircleCIProject>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CircleCIProject;
  }

  async getPipelines(
    projectSlug: string,
    branch?: string,
  ): Promise<CircleCIPipeline[]> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("CircleCI not connected");
    this.tokens = tokens;
    const qs = new URLSearchParams();
    if (branch) qs.set("branch", branch);
    const query = qs.toString() ? `?${qs}` : "";
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/project/${encodeSlug(projectSlug)}/pipeline${query}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      const data = (await res.json()) as { items?: CircleCIPipeline[] };
      return data.items ?? [];
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CircleCIPipeline[];
  }

  async getPipeline(id: string): Promise<CircleCIPipeline> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("CircleCI not connected");
    this.tokens = tokens;
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/pipeline/${id}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<CircleCIPipeline>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CircleCIPipeline;
  }

  async triggerPipeline(
    projectSlug: string,
    params: {
      branch?: string;
      tag?: string;
      parameters?: Record<string, string | boolean | number>;
    } = {},
  ): Promise<CircleCITriggerResult> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("CircleCI not connected");
    this.tokens = tokens;
    const body: Record<string, unknown> = {};
    if (params.branch) body.branch = params.branch;
    if (params.tag) body.tag = params.tag;
    if (params.parameters) body.parameters = params.parameters;
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/project/${encodeSlug(projectSlug)}/pipeline`,
        {
          method: "POST",
          headers: {
            ...this.buildHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<CircleCITriggerResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CircleCITriggerResult;
  }

  async getPipelineWorkflows(pipelineId: string): Promise<CircleCIWorkflow[]> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("CircleCI not connected");
    this.tokens = tokens;
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/pipeline/${pipelineId}/workflow`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as { items?: CircleCIWorkflow[] };
      return data.items ?? [];
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CircleCIWorkflow[];
  }

  async getWorkflow(id: string): Promise<CircleCIWorkflow> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("CircleCI not connected");
    this.tokens = tokens;
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/workflow/${id}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<CircleCIWorkflow>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CircleCIWorkflow;
  }

  async getWorkflowJobs(workflowId: string): Promise<CircleCIJob[]> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("CircleCI not connected");
    this.tokens = tokens;
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/workflow/${workflowId}/job`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as { items?: CircleCIJob[] };
      return data.items ?? [];
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CircleCIJob[];
  }

  async cancelWorkflow(id: string): Promise<void> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("CircleCI not connected");
    this.tokens = tokens;
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/workflow/${id}/cancel`, {
        method: "POST",
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return null;
    });
    if ("error" in result) throw new Error(result.error.message);
  }

  async approveJob(
    workflowId: string,
    approvalRequestId: string,
  ): Promise<void> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("CircleCI not connected");
    this.tokens = tokens;
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/workflow/${workflowId}/approve/${approvalRequestId}`,
        {
          method: "POST",
          headers: this.buildHeaders(),
        },
      );
      if (!res.ok) throw res;
      return null;
    });
    if ("error" in result) throw new Error(result.error.message);
  }

  async getJob(projectSlug: string, jobNumber: number): Promise<CircleCIJob> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("CircleCI not connected");
    this.tokens = tokens;
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/project/${encodeSlug(projectSlug)}/job/${jobNumber}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<CircleCIJob>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CircleCIJob;
  }

  async listWebhooks(
    scopeId: string,
    scopeType = "project",
  ): Promise<CircleCIWebhook[]> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("CircleCI not connected");
    this.tokens = tokens;
    const qs = new URLSearchParams({
      "scope-id": scopeId,
      "scope-type": scopeType,
    });
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/webhook?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as { items?: CircleCIWebhook[] };
      return data.items ?? [];
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CircleCIWebhook[];
  }

  async createWebhook(params: {
    name: string;
    events: string[];
    url: string;
    scopeId: string;
    scopeType?: string;
    signingSecret: string;
    verifyTls?: boolean;
  }): Promise<CircleCIWebhook> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("CircleCI not connected");
    this.tokens = tokens;
    const body = {
      name: params.name,
      events: params.events,
      url: params.url,
      scope: { id: params.scopeId, type: params.scopeType ?? "project" },
      signing_secret: params.signingSecret,
      verify_tls: params.verifyTls ?? true,
    };
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/webhook`, {
        method: "POST",
        headers: { ...this.buildHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<CircleCIWebhook>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CircleCIWebhook;
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("CircleCI not connected");
    this.tokens = tokens;
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/webhook/${webhookId}`, {
        method: "DELETE",
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return null;
    });
    if ("error" in result) throw new Error(result.error.message);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const token = this.tokens?.apiToken ?? "";
    return {
      "Circle-Token": token,
      Accept: "application/json",
    };
  }
}

// ── Webhook verification ─────────────────────────────────────────────────────

/**
 * Verify a CircleCI webhook delivery.
 *
 * CircleCI signs payloads with HMAC-SHA256 and sends the signature in the
 * `circleci-signature` header as `v1=<hex>`. This function recomputes the
 * expected HMAC and does a constant-time comparison to prevent timing attacks.
 *
 * @param rawBody       Raw request body bytes (Buffer or string)
 * @param signatureHeader  Value of the `circleci-signature` header
 * @param signingSecret    The signing secret configured on the webhook
 * @returns true if the signature is valid, false otherwise
 */
export function verifyCircleCIWebhook(
  rawBody: Buffer | string,
  signatureHeader: string,
  signingSecret: string,
): boolean {
  if (!signatureHeader || !signingSecret) return false;
  // Header format: "v1=<hex>[,v1=<hex>...]" — take the first v1 entry
  const v1Entry = signatureHeader
    .split(",")
    .map((s) => s.trim())
    .find((s) => s.startsWith("v1="));
  if (!v1Entry) return false;
  const providedHex = v1Entry.slice(3);
  const expected = createHmac("sha256", signingSecret)
    .update(rawBody)
    .digest("hex");
  try {
    return timingSafeEqual(
      Buffer.from(providedHex, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch {
    return false;
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): CircleCITokens | null {
  const envToken = process.env.CIRCLECI_API_TOKEN;
  if (envToken) {
    return { apiToken: envToken, connected_at: new Date().toISOString() };
  }
  return getSecretJsonSync<CircleCITokens>("circleci");
}

export function saveTokens(tokens: CircleCITokens): void {
  storeSecretJsonSync("circleci", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("circleci");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: CircleCIConnector | null = null;

function resetCircleCIConnector(): void {
  _instance = null;
}

export function getCircleCIConnector(): CircleCIConnector {
  if (!_instance) {
    _instance = new CircleCIConnector();
  }
  return _instance;
}

export { getCircleCIConnector as circleci };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/circleci/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/circleci/connect  { apiToken }
 */
export async function handleCircleCIConnect(
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
    const res = await fetch(`${BASE_URL}/me`, {
      headers: { "Circle-Token": apiToken, Accept: "application/json" },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by CircleCI (HTTP ${res.status}) — check apiToken`,
        }),
      };
    }
    const me = (await res.json()) as { login?: string; name?: string };
    const login = me.login ?? me.name ?? undefined;

    const tokens: CircleCITokens = {
      apiToken,
      login,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetCircleCIConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        login,
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
 * POST /connections/circleci/test
 */
export async function handleCircleCITest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "CircleCI not connected" }),
    };
  }
  try {
    const connector = getCircleCIConnector();
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
 * DELETE /connections/circleci
 */
export function handleCircleCIDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetCircleCIConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Encode a project slug for use in a URL path segment.
 * Slugs like `gh/owner/repo` contain `/` which must NOT be percent-encoded
 * because the CircleCI API expects them verbatim in the path. We only encode
 * characters that would be truly illegal (spaces, #, etc.).
 */
function encodeSlug(slug: string): string {
  // Normalise `github/` → `gh/` prefix so both forms work
  return slug
    .replace(/^github\//, "gh/")
    .replace(/^bitbucket\//, "bb/")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
