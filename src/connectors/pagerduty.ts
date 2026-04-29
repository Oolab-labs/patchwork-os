/**
 * PagerDuty connector — read incidents, services, and on-call rotations.
 *
 * Auth: API key (paste from PagerDuty Console → Integrations → API Access Keys).
 *   - Env var: PAGERDUTY_TOKEN
 *   - Stored: getSecretJsonSync("pagerduty") → PagerDutyTokens
 *   - Header: Authorization: Token token=<key>   (PagerDuty's specific format —
 *     not Bearer.)
 *
 * Tools (read-only this PR): listIncidents, getIncident, listServices, listOnCalls.
 * Write methods (createIncident / ack / resolve) deferred to a follow-up PR.
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

const PAGERDUTY_BASE = "https://api.pagerduty.com";
const PAGERDUTY_ACCEPT = "application/vnd.pagerduty+json;version=2";

export interface PagerDutyTokens {
  token: string;
  userEmail?: string;
  userName?: string;
  connected_at: string;
}

export interface PagerDutyIncident {
  id: string;
  incident_number: number;
  title: string;
  status: string;
  urgency: string;
  created_at: string;
  updated_at: string;
  service?: { id: string; summary: string; type: string };
  assignments?: Array<{
    at: string;
    assignee: { id: string; summary: string; type: string };
  }>;
  html_url: string;
}

export interface PagerDutyService {
  id: string;
  name: string;
  description?: string;
  status: string;
  created_at: string;
  html_url: string;
}

export interface PagerDutyOnCall {
  user: { id: string; summary: string; type: string };
  schedule?: { id: string; summary: string; type: string };
  escalation_policy?: { id: string; summary: string; type: string };
  escalation_level: number;
  start?: string;
  end?: string;
}

export class PagerDutyConnector extends BaseConnector {
  readonly providerName = "pagerduty";

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "PagerDuty not connected. Run: patchwork-os connect pagerduty or set PAGERDUTY_TOKEN",
      );
    }
    return {
      token: tokens.token,
      scopes: ["read"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async (token) => {
        const res = await fetch(`${PAGERDUTY_BASE}/users/me`, {
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
          message: "PagerDuty authentication failed — check API key",
          retryable: false,
          suggestedAction: "patchwork-os connect pagerduty",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient PagerDuty permissions for this resource",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "PagerDuty resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "PagerDuty API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `PagerDuty API error: HTTP ${s}`,
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
          message: `Cannot connect to PagerDuty: ${error.message}`,
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
      id: "pagerduty",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.userName ?? tokens?.userEmail ?? undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async listIncidents(
    params: {
      statuses?: string[];
      urgencies?: string[];
      since?: string;
      until?: string;
      limit?: number;
    } = {},
  ): Promise<{ incidents: PagerDutyIncident[] }> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams();
      qs.set("limit", String(params.limit ?? 25));
      if (params.statuses?.length)
        for (const s of params.statuses) qs.append("statuses[]", s);
      if (params.urgencies?.length)
        for (const u of params.urgencies) qs.append("urgencies[]", u);
      if (params.since) qs.set("since", params.since);
      if (params.until) qs.set("until", params.until);

      const res = await fetch(`${PAGERDUTY_BASE}/incidents?${qs}`, {
        headers: this.buildHeaders(token),
      });
      this.updateRateLimitFromHeaders({
        "x-ratelimit-remaining":
          res.headers.get("x-ratelimit-remaining") ?? undefined,
        "retry-after": res.headers.get("retry-after") ?? undefined,
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ incidents: PagerDutyIncident[] }>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as { incidents: PagerDutyIncident[] };
  }

  async getIncident(id: string): Promise<PagerDutyIncident> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${PAGERDUTY_BASE}/incidents/${id}`, {
        headers: this.buildHeaders(token),
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as { incident: PagerDutyIncident };
      return data.incident;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as PagerDutyIncident;
  }

  async listServices(
    params: { limit?: number } = {},
  ): Promise<{ services: PagerDutyService[] }> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({ limit: String(params.limit ?? 25) });
      const res = await fetch(`${PAGERDUTY_BASE}/services?${qs}`, {
        headers: this.buildHeaders(token),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ services: PagerDutyService[] }>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as { services: PagerDutyService[] };
  }

  async listOnCalls(
    params: { scheduleIds?: string[]; limit?: number } = {},
  ): Promise<{ oncalls: PagerDutyOnCall[] }> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({ limit: String(params.limit ?? 25) });
      if (params.scheduleIds?.length)
        for (const id of params.scheduleIds) qs.append("schedule_ids[]", id);
      const res = await fetch(`${PAGERDUTY_BASE}/oncalls?${qs}`, {
        headers: this.buildHeaders(token),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ oncalls: PagerDutyOnCall[] }>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as { oncalls: PagerDutyOnCall[] };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Token token=${token}`,
      Accept: PAGERDUTY_ACCEPT,
      "Content-Type": "application/json",
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): PagerDutyTokens | null {
  const envToken = process.env.PAGERDUTY_TOKEN;
  if (envToken) {
    return {
      token: envToken,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<PagerDutyTokens>("pagerduty");
}

export function saveTokens(tokens: PagerDutyTokens): void {
  storeSecretJsonSync("pagerduty", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("pagerduty");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: PagerDutyConnector | null = null;

function resetPagerDutyConnector(): void {
  _instance = null;
}

export function getPagerDutyConnector(): PagerDutyConnector {
  if (!_instance) {
    _instance = new PagerDutyConnector();
  }
  return _instance;
}

export { getPagerDutyConnector as pagerduty };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/pagerduty/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/pagerduty/connect  { token }
 */
export async function handlePagerDutyConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let token: string;

  try {
    const parsed = JSON.parse(body) as { token?: unknown };
    if (typeof parsed.token !== "string" || !parsed.token) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "token is required" }),
      };
    }
    token = parsed.token;
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const res = await fetch(`${PAGERDUTY_BASE}/users/me`, {
      headers: {
        Authorization: `Token token=${token}`,
        Accept: PAGERDUTY_ACCEPT,
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by PagerDuty (HTTP ${res.status}) — check API key`,
        }),
      };
    }
    const detail = (await res.json().catch(() => ({}))) as {
      user?: { name?: string; email?: string };
    };

    const tokens: PagerDutyTokens = {
      token,
      userEmail: detail.user?.email,
      userName: detail.user?.name,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetPagerDutyConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        userEmail: tokens.userEmail,
        userName: tokens.userName,
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
 * POST /connections/pagerduty/test
 */
export async function handlePagerDutyTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "PagerDuty not connected" }),
    };
  }
  try {
    const connector = getPagerDutyConnector();
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
 * DELETE /connections/pagerduty
 */
export function handlePagerDutyDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetPagerDutyConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
