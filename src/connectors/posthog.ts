/**
 * PostHog connector — product analytics, feature flags, events, and persons.
 *
 * Auth: Personal API key (phx_ prefix) stored as getSecretJsonSync("posthog").
 *   - Env var: POSTHOG_API_KEY
 *   - Header: Authorization: Bearer <apiKey>
 *   - Project key: projectApiKey used for event capture (distinct from management key)
 *
 * Tools: captureEvent, getProjects, getProject, getInsights, getInsight,
 *        queryInsight, getFeatureFlags, getFeatureFlag, getPersons, getPerson, getEvents
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 */

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

const DEFAULT_POSTHOG_HOST = "https://us.posthog.com";

export interface PostHogTokens {
  apiKey: string; // Personal API key (phx_ prefix) — management API
  projectApiKey?: string; // Project API key — event capture
  projectId?: string | number;
  host: string; // e.g. "https://us.posthog.com" or "https://eu.posthog.com"
  connected_at: string;
}

export interface PostHogProject {
  id: number | string;
  name: string;
  api_token: string;
  created_at: string;
  timezone: string;
}

export interface PostHogInsight {
  id: number | string;
  name: string;
  description?: string;
  filters: Record<string, unknown>;
  result?: unknown;
  last_modified_at?: string;
}

export interface PostHogFeatureFlag {
  id: number | string;
  key: string;
  name: string;
  active: boolean;
  filters: Record<string, unknown>;
  created_at: string;
  rollout_percentage?: number;
}

export interface PostHogPerson {
  id: number | string;
  distinct_ids: string[];
  properties: Record<string, unknown>;
  created_at: string;
}

export interface PostHogEvent {
  id: string;
  distinct_id: string;
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
  person?: Partial<PostHogPerson>;
}

export class PostHogConnector extends BaseConnector {
  readonly providerName = "posthog";
  private tokens: PostHogTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadPostHogTokens();
    if (!tokens) {
      throw new Error(
        "PostHog not connected. Run: patchwork-os connect posthog or set POSTHOG_API_KEY",
      );
    }
    this.tokens = tokens;
    return {
      token: tokens.apiKey,
      scopes: ["read", "write"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async () => {
        const res = await fetch(`${this.baseUrl()}/api/projects/`, {
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
          message: "PostHog authentication failed — check API key",
          retryable: false,
          suggestedAction: "patchwork-os connect posthog",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "PostHog permission denied — insufficient scopes",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "PostHog resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "PostHog API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `PostHog API error: HTTP ${s}`,
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
          message: `Cannot connect to PostHog: ${error.message}`,
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
    const tokens = loadPostHogTokens();
    return {
      id: "posthog",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.host ?? undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  /** Capture a product analytics event via project API key */
  async captureEvent(
    distinctId: string,
    event: string,
    properties?: Record<string, unknown>,
    timestamp?: string,
  ): Promise<{ status: string }> {
    const tokens = this.tokens;
    if (!tokens?.projectApiKey) {
      throw new Error(
        "PostHog projectApiKey is required for event capture. Re-connect with a project API key.",
      );
    }
    const result = await this.apiCall(async () => {
      const body: Record<string, unknown> = {
        api_key: tokens.projectApiKey,
        distinct_id: distinctId,
        event,
      };
      if (properties !== undefined) body.properties = properties;
      if (timestamp !== undefined) body.timestamp = timestamp;
      const res = await fetch(`${this.baseUrl()}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ status: string }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as { status: string };
  }

  async getProjects(): Promise<PostHogProject[]> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${this.baseUrl()}/api/projects/`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as
        | PostHogProject[]
        | { results: PostHogProject[] };
      return Array.isArray(data) ? data : data.results;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PostHogProject[];
  }

  async getProject(id: string | number): Promise<PostHogProject> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${this.baseUrl()}/api/projects/${id}/`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<PostHogProject>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PostHogProject;
  }

  async getInsights(
    projectId: string | number,
    limit?: number,
  ): Promise<PostHogInsight[]> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (limit !== undefined) qs.set("limit", String(limit));
      const url = `${this.baseUrl()}/api/projects/${projectId}/insights/${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      const data = (await res.json()) as
        | PostHogInsight[]
        | { results: PostHogInsight[] };
      return Array.isArray(data) ? data : data.results;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PostHogInsight[];
  }

  async getInsight(
    projectId: string | number,
    id: string | number,
  ): Promise<PostHogInsight> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${this.baseUrl()}/api/projects/${projectId}/insights/${id}/`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<PostHogInsight>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PostHogInsight;
  }

  /** Run a HogQL query against a project */
  async queryInsight(
    projectId: string | number,
    query: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${this.baseUrl()}/api/projects/${projectId}/query/`,
        {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify(query),
        },
      );
      if (!res.ok) throw res;
      return res.json();
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async getFeatureFlags(
    projectId: string | number,
  ): Promise<PostHogFeatureFlag[]> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${this.baseUrl()}/api/projects/${projectId}/feature_flags/`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      const data = (await res.json()) as
        | PostHogFeatureFlag[]
        | { results: PostHogFeatureFlag[] };
      return Array.isArray(data) ? data : data.results;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PostHogFeatureFlag[];
  }

  async getFeatureFlag(
    projectId: string | number,
    id: string | number,
  ): Promise<PostHogFeatureFlag> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${this.baseUrl()}/api/projects/${projectId}/feature_flags/${id}/`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<PostHogFeatureFlag>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PostHogFeatureFlag;
  }

  async getPersons(
    projectId: string | number,
    params: { search?: string; limit?: number } = {},
  ): Promise<PostHogPerson[]> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (params.search) qs.set("search", params.search);
      if (params.limit !== undefined) qs.set("limit", String(params.limit));
      const url = `${this.baseUrl()}/api/projects/${projectId}/persons/${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      const data = (await res.json()) as
        | PostHogPerson[]
        | { results: PostHogPerson[] };
      return Array.isArray(data) ? data : data.results;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PostHogPerson[];
  }

  async getPerson(
    projectId: string | number,
    distinctId: string,
  ): Promise<PostHogPerson[]> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams({ distinct_id: distinctId });
      const res = await fetch(
        `${this.baseUrl()}/api/projects/${projectId}/persons/?${qs}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      const data = (await res.json()) as
        | PostHogPerson[]
        | { results: PostHogPerson[] };
      return Array.isArray(data) ? data : data.results;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PostHogPerson[];
  }

  async getEvents(
    projectId: string | number,
    params: {
      event?: string;
      personId?: string;
      after?: string;
      before?: string;
      limit?: number;
    } = {},
  ): Promise<PostHogEvent[]> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (params.event) qs.set("event", params.event);
      if (params.personId) qs.set("person_id", params.personId);
      if (params.after) qs.set("after", params.after);
      if (params.before) qs.set("before", params.before);
      if (params.limit !== undefined) qs.set("limit", String(params.limit));
      const url = `${this.baseUrl()}/api/projects/${projectId}/events/${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      const data = (await res.json()) as
        | PostHogEvent[]
        | { results: PostHogEvent[] };
      return Array.isArray(data) ? data : data.results;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PostHogEvent[];
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private baseUrl(): string {
    return (this.tokens?.host ?? DEFAULT_POSTHOG_HOST).replace(/\/$/, "");
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.tokens?.apiKey ?? ""}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadPostHogTokens(): PostHogTokens | null {
  const envApiKey = process.env.POSTHOG_API_KEY;
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      host: process.env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<PostHogTokens>("posthog");
}

export function savePostHogTokens(tokens: PostHogTokens): void {
  storeSecretJsonSync("posthog", tokens);
}

export function clearPostHogTokens(): void {
  try {
    deleteSecretJsonSync("posthog");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: PostHogConnector | null = null;

function resetPostHogConnector(): void {
  _instance = null;
}

export function getPostHogConnector(): PostHogConnector {
  if (!_instance) {
    _instance = new PostHogConnector();
  }
  return _instance;
}

export { getPostHogConnector as posthog };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/posthog/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/posthog/connect  { apiKey, host?, projectApiKey?, projectId? }
 */
export async function handlePostHogConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let apiKey: string;
  let host: string;
  let projectApiKey: string | undefined;
  let projectId: string | number | undefined;

  try {
    const parsed = JSON.parse(body) as {
      apiKey?: unknown;
      host?: unknown;
      projectApiKey?: unknown;
      projectId?: unknown;
    };
    if (typeof parsed.apiKey !== "string" || !parsed.apiKey) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "apiKey is required" }),
      };
    }
    apiKey = parsed.apiKey;
    host =
      typeof parsed.host === "string" && parsed.host
        ? parsed.host.replace(/\/$/, "")
        : DEFAULT_POSTHOG_HOST;

    // SSRF guard: only allow https:// URLs
    if (!host.startsWith("https://")) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "host must start with https://",
        }),
      };
    }
    if (typeof parsed.projectApiKey === "string" && parsed.projectApiKey) {
      projectApiKey = parsed.projectApiKey;
    }
    if (
      parsed.projectId !== undefined &&
      (typeof parsed.projectId === "string" ||
        typeof parsed.projectId === "number")
    ) {
      projectId = parsed.projectId;
    }
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const res = await fetch(`${host}/api/projects/`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by PostHog (HTTP ${res.status}) — check apiKey`,
        }),
      };
    }

    const tokens: PostHogTokens = {
      apiKey,
      host,
      connected_at: new Date().toISOString(),
    };
    if (projectApiKey !== undefined) tokens.projectApiKey = projectApiKey;
    if (projectId !== undefined) tokens.projectId = projectId;
    savePostHogTokens(tokens);
    resetPostHogConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        host,
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
 * POST /connections/posthog/test
 */
export async function handlePostHogTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadPostHogTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "PostHog not connected" }),
    };
  }
  try {
    const connector = getPostHogConnector();
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
 * DELETE /connections/posthog
 */
export function handlePostHogDisconnect(): ConnectorHandlerResult {
  clearPostHogTokens();
  resetPostHogConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
