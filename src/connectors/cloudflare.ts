/**
 * Cloudflare connector — zones, DNS, cache, Pages, Workers, analytics.
 *
 * Auth: API token (Bearer).
 *   - Env var: CLOUDFLARE_API_TOKEN (+ optional CLOUDFLARE_ACCOUNT_ID)
 *   - Stored: getSecretJsonSync("cloudflare") → CloudflareTokens
 *   - Header: Authorization: Bearer <apiToken>
 *
 * Tools: listZones, getZone, listDnsRecords, createDnsRecord, updateDnsRecord,
 *         deleteDnsRecord, purgeCache, listPagesProjects, getPagesProject,
 *         createPagesDeployment, listWorkers, getZoneAnalytics
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

export interface CloudflareTokens {
  apiToken: string;
  accountId?: string;
  email?: string; // from /user on connect, for display
  connected_at: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: "active" | "pending" | "paused" | "deactivated";
  nameservers: string[];
  plan: { name: string };
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  proxiable: boolean;
  created_on: string;
  modified_on: string;
}

export interface CloudflarePagesProject {
  id: string;
  name: string;
  subdomain: string;
  domains: string[];
  source?: {
    type: string;
    config?: {
      owner?: string;
      repo_name?: string;
      production_branch?: string;
    };
  };
  created_on: string;
  latest_deployment?: {
    id: string;
    url: string;
    environment: string;
    created_on: string;
  };
}

export interface CloudflareWorkerScript {
  id: string;
  etag: string;
  handlers: string[];
  modified_on: string;
}

/** Shape of every Cloudflare API v4 response envelope */
interface CfEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
}

const BASE_URL = "https://api.cloudflare.com/client/v4";

export class CloudflareConnector extends BaseConnector {
  readonly providerName = "cloudflare";
  private tokens: CloudflareTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Cloudflare not connected. Run: patchwork-os connect cloudflare or set CLOUDFLARE_API_TOKEN",
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
            message: "Cloudflare not connected",
            retryable: false,
          },
        };
      }
      this.tokens = tokens;
      const result = await this.apiCall(async () => {
        const res = await fetch(`${BASE_URL}/user/tokens/verify`, {
          headers: this.buildHeaders(),
        });
        if (!res.ok) throw res;
        const json = (await res.json()) as CfEnvelope<{ status: string }>;
        if (!json.success) throw cfError(json);
        return json;
      });
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    // Cloudflare success:false body thrown as Error with "CF:" prefix
    if (error instanceof Error && error.message.startsWith("CF:")) {
      const msg = error.message.slice(3);
      const codeMatch = /^(\d+)/.exec(msg);
      const code = codeMatch ? Number(codeMatch[1]) : 0;
      if (code === 9109 || code === 1000)
        return {
          code: "auth_expired",
          message: `Cloudflare: ${msg}`,
          retryable: false,
          suggestedAction: "patchwork-os connect cloudflare",
        };
      return {
        code: "provider_error",
        message: `Cloudflare: ${msg}`,
        retryable: false,
      };
    }
    if (error instanceof Response) {
      const s = error.status;
      if (s === 401)
        return {
          code: "auth_expired",
          message: "Cloudflare authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect cloudflare",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Cloudflare permissions",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Cloudflare resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Cloudflare API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Cloudflare API error: HTTP ${s}`,
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
          message: `Cannot connect to Cloudflare: ${error.message}`,
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
      id: "cloudflare",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.email
        ? `Cloudflare: ${tokens.email}`
        : tokens?.accountId
          ? `Cloudflare account ${tokens.accountId}`
          : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async listZones(name?: string): Promise<CloudflareZone[]> {
    const tokens = this.ensureTokens();
    void tokens; // loaded for side-effect (sets this.tokens)
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams({ per_page: "50" });
      if (name) qs.set("name", name);
      const res = await fetch(`${BASE_URL}/zones?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      const json = (await res.json()) as CfEnvelope<CloudflareZone[]>;
      if (!json.success) throw cfError(json);
      return json.result;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CloudflareZone[];
  }

  async getZone(zoneId: string): Promise<CloudflareZone> {
    this.ensureTokens();
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/zones/${zoneId}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      const json = (await res.json()) as CfEnvelope<CloudflareZone>;
      if (!json.success) throw cfError(json);
      return json.result;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CloudflareZone;
  }

  async listDnsRecords(
    zoneId: string,
    type?: string,
    name?: string,
  ): Promise<CloudflareDnsRecord[]> {
    this.ensureTokens();
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams({ per_page: "100" });
      if (type) qs.set("type", type);
      if (name) qs.set("name", name);
      const res = await fetch(`${BASE_URL}/zones/${zoneId}/dns_records?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      const json = (await res.json()) as CfEnvelope<CloudflareDnsRecord[]>;
      if (!json.success) throw cfError(json);
      return json.result;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CloudflareDnsRecord[];
  }

  async createDnsRecord(
    zoneId: string,
    type: string,
    name: string,
    content: string,
    ttl?: number,
    proxied?: boolean,
  ): Promise<CloudflareDnsRecord> {
    this.ensureTokens();
    const result = await this.apiCall(async () => {
      const body: Record<string, unknown> = { type, name, content };
      if (ttl !== undefined) body.ttl = ttl;
      if (proxied !== undefined) body.proxied = proxied;
      const res = await fetch(`${BASE_URL}/zones/${zoneId}/dns_records`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw res;
      const json = (await res.json()) as CfEnvelope<CloudflareDnsRecord>;
      if (!json.success) throw cfError(json);
      return json.result;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CloudflareDnsRecord;
  }

  async updateDnsRecord(
    zoneId: string,
    recordId: string,
    fields: Partial<
      Pick<CloudflareDnsRecord, "type" | "name" | "content" | "ttl" | "proxied">
    >,
  ): Promise<CloudflareDnsRecord> {
    this.ensureTokens();
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/zones/${zoneId}/dns_records/${recordId}`,
        {
          method: "PATCH",
          headers: this.buildHeaders(),
          body: JSON.stringify(fields),
        },
      );
      if (!res.ok) throw res;
      const json = (await res.json()) as CfEnvelope<CloudflareDnsRecord>;
      if (!json.success) throw cfError(json);
      return json.result;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CloudflareDnsRecord;
  }

  async deleteDnsRecord(
    zoneId: string,
    recordId: string,
  ): Promise<{ id: string }> {
    this.ensureTokens();
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/zones/${zoneId}/dns_records/${recordId}`,
        {
          method: "DELETE",
          headers: this.buildHeaders(),
        },
      );
      if (!res.ok) throw res;
      const json = (await res.json()) as CfEnvelope<{ id: string }>;
      if (!json.success) throw cfError(json);
      return json.result;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as { id: string };
  }

  async purgeCache(
    zoneId: string,
    params: {
      files?: string[];
      tags?: string[];
      hosts?: string[];
      prefixes?: string[];
    } = {},
  ): Promise<{ id: string }> {
    this.ensureTokens();
    const result = await this.apiCall(async () => {
      const body: Record<string, unknown> = {};
      if (params.files?.length) body.files = params.files;
      if (params.tags?.length) body.tags = params.tags;
      if (params.hosts?.length) body.hosts = params.hosts;
      if (params.prefixes?.length) body.prefixes = params.prefixes;
      // If nothing specified, purge everything
      if (!Object.keys(body).length) body.purge_everything = true;
      const res = await fetch(`${BASE_URL}/zones/${zoneId}/purge_cache`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw res;
      const json = (await res.json()) as CfEnvelope<{ id: string }>;
      if (!json.success) throw cfError(json);
      return json.result;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as { id: string };
  }

  async listPagesProjects(
    accountId?: string,
  ): Promise<CloudflarePagesProject[]> {
    const tokens = this.ensureTokens();
    const acctId = accountId ?? tokens.accountId;
    if (!acctId) throw new Error("accountId is required for listPagesProjects");
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/accounts/${acctId}/pages/projects`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      const json = (await res.json()) as CfEnvelope<CloudflarePagesProject[]>;
      if (!json.success) throw cfError(json);
      return json.result;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CloudflarePagesProject[];
  }

  async getPagesProject(
    accountId: string,
    projectName: string,
  ): Promise<CloudflarePagesProject> {
    this.ensureTokens();
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/accounts/${accountId}/pages/projects/${projectName}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      const json = (await res.json()) as CfEnvelope<CloudflarePagesProject>;
      if (!json.success) throw cfError(json);
      return json.result;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CloudflarePagesProject;
  }

  async createPagesDeployment(
    accountId: string,
    projectName: string,
  ): Promise<{ id: string; url: string; created_on: string }> {
    this.ensureTokens();
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/accounts/${accountId}/pages/projects/${projectName}/deployments`,
        {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) throw res;
      const json = (await res.json()) as CfEnvelope<{
        id: string;
        url: string;
        created_on: string;
      }>;
      if (!json.success) throw cfError(json);
      return json.result;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as { id: string; url: string; created_on: string };
  }

  async listWorkers(accountId?: string): Promise<CloudflareWorkerScript[]> {
    const tokens = this.ensureTokens();
    const acctId = accountId ?? tokens.accountId;
    if (!acctId) throw new Error("accountId is required for listWorkers");
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/accounts/${acctId}/workers/scripts`,
        {
          headers: this.buildHeaders(),
        },
      );
      if (!res.ok) throw res;
      const json = (await res.json()) as CfEnvelope<CloudflareWorkerScript[]>;
      if (!json.success) throw cfError(json);
      return json.result;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as CloudflareWorkerScript[];
  }

  async getZoneAnalytics(
    zoneId: string,
    since?: string,
    until?: string,
  ): Promise<Record<string, unknown>> {
    this.ensureTokens();
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (since) qs.set("since", since);
      if (until) qs.set("until", until);
      const url = `${BASE_URL}/zones/${zoneId}/analytics/dashboard${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      const json = (await res.json()) as CfEnvelope<Record<string, unknown>>;
      if (!json.success) throw cfError(json);
      return json.result;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as Record<string, unknown>;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.tokens?.apiToken ?? ""}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private ensureTokens(): CloudflareTokens {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("Cloudflare not connected");
    this.tokens = tokens;
    return tokens;
  }
}

// ── Envelope error helper ────────────────────────────────────────────────────

function cfError(envelope: CfEnvelope<unknown>): Error {
  const first = envelope.errors[0];
  const msg = first
    ? `${first.code}: ${first.message}`
    : "Unknown Cloudflare error";
  return new Error(`CF:${msg}`);
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): CloudflareTokens | null {
  const envToken = process.env.CLOUDFLARE_API_TOKEN;
  if (envToken) {
    return {
      apiToken: envToken,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<CloudflareTokens>("cloudflare");
}

export function saveTokens(tokens: CloudflareTokens): void {
  storeSecretJsonSync("cloudflare", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("cloudflare");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: CloudflareConnector | null = null;

function resetCloudflareConnector(): void {
  _instance = null;
}

export function getCloudflareConnector(): CloudflareConnector {
  if (!_instance) {
    _instance = new CloudflareConnector();
  }
  return _instance;
}

export { getCloudflareConnector as cloudflare };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/cloudflare/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/cloudflare/connect  { apiToken, accountId? }
 *
 * Validates the token via GET /user/tokens/verify.
 * If no accountId is supplied, fetches GET /accounts and uses the first one.
 */
export async function handleCloudflareConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let apiToken: string;
  let accountId: string | undefined;

  try {
    const parsed = JSON.parse(body) as {
      apiToken?: unknown;
      accountId?: unknown;
    };
    if (typeof parsed.apiToken !== "string" || !parsed.apiToken) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "apiToken is required" }),
      };
    }
    apiToken = parsed.apiToken;
    if (typeof parsed.accountId === "string" && parsed.accountId) {
      accountId = parsed.accountId;
    }
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  try {
    // Verify token
    const verifyRes = await fetch(`${BASE_URL}/user/tokens/verify`, {
      headers,
    });
    if (!verifyRes.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Cloudflare rejected the API token (HTTP ${verifyRes.status}) — check apiToken`,
        }),
      };
    }
    const verifyJson = (await verifyRes.json()) as CfEnvelope<{
      status: string;
    }>;
    if (!verifyJson.success) {
      const first = verifyJson.errors[0];
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: first
            ? `Cloudflare: ${first.message}`
            : "Token verification failed",
        }),
      };
    }

    // Fetch email for display
    let email: string | undefined;
    try {
      const userRes = await fetch(`${BASE_URL}/user`, { headers });
      if (userRes.ok) {
        const userJson = (await userRes.json()) as CfEnvelope<{
          email?: string;
        }>;
        if (userJson.success) email = userJson.result.email;
      }
    } catch {
      // email is optional
    }

    // Resolve accountId if not provided
    if (!accountId) {
      try {
        const acctRes = await fetch(`${BASE_URL}/accounts?per_page=1`, {
          headers,
        });
        if (acctRes.ok) {
          const acctJson = (await acctRes.json()) as CfEnvelope<
            Array<{ id: string; name: string }>
          >;
          if (acctJson.success && acctJson.result[0]) {
            accountId = acctJson.result[0].id;
          }
        }
      } catch {
        // accountId is optional
      }
    }

    const tokens: CloudflareTokens = {
      apiToken,
      accountId,
      email,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetCloudflareConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        accountId,
        email,
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
 * POST /connections/cloudflare/test
 */
export async function handleCloudflareTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Cloudflare not connected" }),
    };
  }
  try {
    const connector = getCloudflareConnector();
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
 * DELETE /connections/cloudflare
 */
export function handleCloudflareDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetCloudflareConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
