/**
 * Vercel connector — project, deployment, and environment variable management
 * via the Vercel REST API.
 *
 * Auth: Bearer token (personal access token).
 *   - Env var: VERCEL_ACCESS_TOKEN
 *   - Stored: getSecretJsonSync("vercel") → VercelTokens
 *   - Team support: if teamId set, appended as ?teamId= query param.
 *
 * Tools: listProjects, getProject, listDeployments, getDeployment,
 *        createDeployment, cancelDeployment, listEnvironmentVariables,
 *        createEnvironmentVariable, deleteEnvironmentVariable
 *
 * Webhook verification: HMAC-SHA1 over raw body, compared to x-vercel-signature.
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

export interface VercelTokens {
  accessToken: string;
  teamId?: string;
  username?: string;
  connected_at: string;
}

export interface VercelDeployment {
  id: string;
  uid: string;
  name: string;
  url: string;
  state:
    | "BUILDING"
    | "ERROR"
    | "INITIALIZING"
    | "QUEUED"
    | "READY"
    | "CANCELED";
  createdAt: number;
  target?: string | null;
}

export interface VercelProject {
  id: string;
  name: string;
  framework?: string | null;
  link?: Record<string, unknown>;
  latestDeployments: VercelDeployment[];
}

export interface VercelEnvVar {
  id: string;
  key: string;
  value: string;
  target: string[];
  type: "plain" | "secret" | "encrypted";
}

const BASE_URL = "https://api.vercel.com";

export class VercelConnector extends BaseConnector {
  readonly providerName = "vercel";
  private tokens: VercelTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Vercel not connected. Run: patchwork-os connect vercel or set VERCEL_ACCESS_TOKEN",
      );
    }
    this.tokens = tokens;
    return {
      token: tokens.accessToken,
      scopes: ["read", "write"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const tokens = this.tokens ?? loadTokens();
      if (!tokens) {
        return {
          ok: false,
          error: {
            code: "auth_expired",
            message: "Vercel not connected",
            retryable: false,
          },
        };
      }
      this.tokens = tokens;
      const result = await this.apiCall(async () => {
        const res = await fetch(`${BASE_URL}/v2/user`, {
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
          message: "Vercel authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect vercel",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Vercel permissions",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Vercel resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Vercel API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Vercel API error: HTTP ${s}`,
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
          message: `Cannot connect to Vercel: ${error.message}`,
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
      id: "vercel",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.username
        ? `Vercel: ${tokens.username}`
        : tokens?.teamId
          ? `Vercel team ${tokens.teamId}`
          : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async listProjects(
    params: { limit?: number } = {},
  ): Promise<VercelProject[]> {
    const result = await this.apiCall(async () => {
      const qs = this.buildQs({ limit: params.limit });
      const res = await fetch(`${BASE_URL}/v9/projects${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as { projects: VercelProject[] };
      return data.projects;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as VercelProject[];
  }

  async getProject(idOrName: string): Promise<VercelProject> {
    const result = await this.apiCall(async () => {
      const qs = this.buildQs({});
      const res = await fetch(
        `${BASE_URL}/v9/projects/${encodeURIComponent(idOrName)}${qs}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<VercelProject>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as VercelProject;
  }

  async listDeployments(
    params: { projectId?: string; limit?: number; state?: string } = {},
  ): Promise<VercelDeployment[]> {
    const result = await this.apiCall(async () => {
      const qs = this.buildQs({
        projectId: params.projectId,
        limit: params.limit,
        state: params.state,
      });
      const res = await fetch(`${BASE_URL}/v6/deployments${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as { deployments: VercelDeployment[] };
      return data.deployments;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as VercelDeployment[];
  }

  async getDeployment(id: string): Promise<VercelDeployment> {
    const result = await this.apiCall(async () => {
      const qs = this.buildQs({});
      const res = await fetch(
        `${BASE_URL}/v13/deployments/${encodeURIComponent(id)}${qs}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<VercelDeployment>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as VercelDeployment;
  }

  async createDeployment(
    projectId: string,
    gitSource?: { type: string; ref?: string; sha?: string },
  ): Promise<VercelDeployment> {
    const result = await this.apiCall(async () => {
      const qs = this.buildQs({});
      const body: Record<string, unknown> = { name: projectId };
      if (gitSource) body.gitSource = gitSource;
      const res = await fetch(`${BASE_URL}/v13/deployments${qs}`, {
        method: "POST",
        headers: {
          ...this.buildHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<VercelDeployment>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as VercelDeployment;
  }

  async cancelDeployment(id: string): Promise<VercelDeployment> {
    const result = await this.apiCall(async () => {
      const qs = this.buildQs({});
      const res = await fetch(
        `${BASE_URL}/v12/deployments/${encodeURIComponent(id)}/cancel${qs}`,
        {
          method: "PATCH",
          headers: this.buildHeaders(),
        },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<VercelDeployment>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as VercelDeployment;
  }

  async listEnvironmentVariables(projectId: string): Promise<VercelEnvVar[]> {
    const result = await this.apiCall(async () => {
      const qs = this.buildQs({});
      const res = await fetch(
        `${BASE_URL}/v9/projects/${encodeURIComponent(projectId)}/env${qs}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      const data = (await res.json()) as { envs: VercelEnvVar[] };
      return data.envs;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as VercelEnvVar[];
  }

  async createEnvironmentVariable(
    projectId: string,
    key: string,
    value: string,
    targets: string[],
    type?: "plain" | "secret" | "encrypted",
  ): Promise<VercelEnvVar> {
    const result = await this.apiCall(async () => {
      const qs = this.buildQs({});
      const res = await fetch(
        `${BASE_URL}/v10/projects/${encodeURIComponent(projectId)}/env${qs}`,
        {
          method: "POST",
          headers: {
            ...this.buildHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            key,
            value,
            target: targets,
            type: type ?? "plain",
          }),
        },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<VercelEnvVar>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as VercelEnvVar;
  }

  async deleteEnvironmentVariable(
    projectId: string,
    envId: string,
  ): Promise<void> {
    const result = await this.apiCall(async () => {
      const qs = this.buildQs({});
      const res = await fetch(
        `${BASE_URL}/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}${qs}`,
        {
          method: "DELETE",
          headers: this.buildHeaders(),
        },
      );
      if (!res.ok) throw res;
      return null;
    });
    if ("error" in result) throw new Error(result.error.message);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const token = this.tokens?.accessToken ?? "";
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
  }

  /**
   * Build query string. Always prepends teamId when present.
   */
  private buildQs(params: Record<string, string | number | undefined>): string {
    const qs = new URLSearchParams();
    const teamId = this.tokens?.teamId;
    if (teamId) qs.set("teamId", teamId);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const str = qs.toString();
    return str ? `?${str}` : "";
  }
}

// ── Webhook verification ─────────────────────────────────────────────────────

/**
 * Vercel signs webhook payloads with HMAC-SHA1 over the raw body using the
 * client secret. The signature arrives as the `x-vercel-signature` header.
 */
export function verifyVercelWebhook(
  rawBody: string | Buffer,
  signatureHeader: string,
  clientSecret: string,
): boolean {
  try {
    const mac = createHmac("sha1", clientSecret);
    mac.update(rawBody);
    const expected = mac.digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    const actualBuf = Buffer.from(signatureHeader, "hex");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): VercelTokens | null {
  const envToken = process.env.VERCEL_ACCESS_TOKEN;
  if (envToken) {
    return {
      accessToken: envToken,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<VercelTokens>("vercel");
}

export function saveTokens(tokens: VercelTokens): void {
  storeSecretJsonSync("vercel", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("vercel");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: VercelConnector | null = null;

function resetVercelConnector(): void {
  _instance = null;
}

export function getVercelConnector(): VercelConnector {
  if (!_instance) {
    _instance = new VercelConnector();
  }
  return _instance;
}

export { getVercelConnector as vercel };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/vercel/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/vercel/connect  { accessToken, teamId? }
 */
export async function handleVercelConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let accessToken: string;
  let teamId: string | undefined;

  try {
    const parsed = JSON.parse(body) as {
      accessToken?: unknown;
      teamId?: unknown;
    };
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "accessToken is required" }),
      };
    }
    accessToken = parsed.accessToken;
    if (typeof parsed.teamId === "string" && parsed.teamId) {
      teamId = parsed.teamId;
    }
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
    const res = await fetch(`${BASE_URL}/v2/user${qs}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Vercel (HTTP ${res.status}) — check accessToken`,
        }),
      };
    }
    const user = (await res.json()) as {
      user?: { username?: string; name?: string };
    };
    const username = user.user?.username ?? user.user?.name ?? undefined;

    const tokens: VercelTokens = {
      accessToken,
      teamId,
      username,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetVercelConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        username,
        teamId,
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
 * POST /connections/vercel/test
 */
export async function handleVercelTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Vercel not connected" }),
    };
  }
  try {
    const connector = getVercelConnector();
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
 * DELETE /connections/vercel
 */
export function handleVercelDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetVercelConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
