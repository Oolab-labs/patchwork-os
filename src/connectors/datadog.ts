/**
 * Datadog connector — query metrics, monitors, alerts, and incidents.
 *
 * Auth: API key + Application key.
 *   - Env vars: DATADOG_API_KEY, DATADOG_APP_KEY, DATADOG_SITE (optional)
 *   - Stored: getSecretJsonSync("datadog") → DatadogTokens
 *   - Headers: DD-API-KEY + DD-APPLICATION-KEY
 *
 * Tools: queryMetrics, listMonitors, getMonitor, listActiveAlerts, muteMonitor, listIncidents
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

export interface DatadogTokens {
  apiKey: string;
  appKey: string;
  site?: string; // e.g. "datadoghq.com" (default), "datadoghq.eu", "us3.datadoghq.com"
  orgName?: string;
  connected_at: string;
}

export interface DatadogSeries {
  metric: string;
  display_name: string;
  unit: Array<{ family: string; name: string; short_name: string }> | null;
  pointlist: Array<[number, number | null]>;
  start: number;
  end: number;
  interval: number;
  length: number;
  aggr: string | null;
  scope: string;
}

export interface DatadogMonitor {
  id: number;
  name: string;
  type: string;
  query: string;
  message: string;
  status: string;
  state: string;
  tags: string[];
  created: string;
  modified: string;
  overall_state: string;
}

export interface DatadogIncident {
  id: string;
  type: string;
  attributes: {
    title: string;
    status: string;
    severity: string;
    created: string;
    modified: string;
    customer_impact_scope?: string;
    customer_impacted: boolean;
  };
}

export class DatadogConnector extends BaseConnector {
  readonly providerName = "datadog";
  private tokens: DatadogTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Datadog not connected. Run: patchwork-os connect datadog or set DATADOG_API_KEY",
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
        const res = await fetch(`${this.baseUrl()}/api/v1/validate`, {
          headers: this.buildHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      if (s === 401 || s === 403)
        return {
          code: "auth_expired",
          message: "Datadog authentication failed — check API key and App key",
          retryable: false,
          suggestedAction: "patchwork-os connect datadog",
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Datadog resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Datadog API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Datadog API error: HTTP ${s}`,
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
          message: `Cannot connect to Datadog: ${error.message}`,
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
      id: "datadog",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.orgName ?? tokens?.site ?? undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async queryMetrics(
    query: string,
    from: number,
    to: number,
  ): Promise<{ series: DatadogSeries[] }> {
    const result = await this.apiCall(async () => {
      const q = encodeURIComponent(query);
      const url = `${this.baseUrl()}/api/v1/query?query=${q}&from=${from}&to=${to}`;
      const res = await fetch(url, { headers: this.buildHeaders() });

      this.updateRateLimitFromHeaders({
        "x-ratelimit-remaining":
          res.headers.get("x-ratelimit-remaining") ?? undefined,
        "retry-after": res.headers.get("retry-after") ?? undefined,
      });

      if (!res.ok) throw res;
      return res.json() as Promise<{ series: DatadogSeries[] }>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as { series: DatadogSeries[] };
  }

  async listMonitors(
    params: { groupStates?: string[]; tags?: string[]; perPage?: number } = {},
  ): Promise<DatadogMonitor[]> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams({ group_states: "all" });
      if (params.tags?.length) qs.set("tags", params.tags.join(","));
      if (params.perPage) qs.set("per_page", String(params.perPage));
      const res = await fetch(`${this.baseUrl()}/api/v1/monitor?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<DatadogMonitor[]>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as DatadogMonitor[];
  }

  async getMonitor(monitorId: number): Promise<DatadogMonitor> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${this.baseUrl()}/api/v1/monitor/${monitorId}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<DatadogMonitor>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as DatadogMonitor;
  }

  async listActiveAlerts(
    params: { priority?: number } = {},
  ): Promise<DatadogMonitor[]> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams({
        monitor_tags: "*",
        group_states: "Alert,Warn",
        with_downtimes: "false",
      });
      if (params.priority !== undefined)
        qs.set("priority", String(params.priority));
      const res = await fetch(`${this.baseUrl()}/api/v1/monitor?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      const monitors = (await res.json()) as DatadogMonitor[];
      return monitors.filter(
        (m) => m.overall_state === "Alert" || m.overall_state === "Warn",
      );
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as DatadogMonitor[];
  }

  async muteMonitor(monitorId: number, end?: number): Promise<DatadogMonitor> {
    const result = await this.apiCall(async () => {
      const body: Record<string, unknown> = {};
      if (end !== undefined) body.end = end;
      const res = await fetch(
        `${this.baseUrl()}/api/v1/monitor/${monitorId}/mute`,
        {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<DatadogMonitor>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as DatadogMonitor;
  }

  async listIncidents(
    params: { perPage?: number } = {},
  ): Promise<{ data: DatadogIncident[] }> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (params.perPage) qs.set("page[size]", String(params.perPage));
      const url = `${this.baseUrl()}/api/v2/incidents${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      return res.json() as Promise<{ data: DatadogIncident[] }>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as { data: DatadogIncident[] };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private baseUrl(): string {
    return `https://api.${this.tokens?.site ?? "datadoghq.com"}`;
  }

  private buildHeaders(): Record<string, string> {
    return {
      "DD-API-KEY": this.tokens?.apiKey ?? "",
      "DD-APPLICATION-KEY": this.tokens?.appKey ?? "",
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): DatadogTokens | null {
  const envApiKey = process.env.DATADOG_API_KEY;
  const envAppKey = process.env.DATADOG_APP_KEY;
  if (envApiKey && envAppKey) {
    return {
      apiKey: envApiKey,
      appKey: envAppKey,
      site: process.env.DATADOG_SITE ?? "datadoghq.com",
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<DatadogTokens>("datadog");
}

export function saveTokens(tokens: DatadogTokens): void {
  storeSecretJsonSync("datadog", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("datadog");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: DatadogConnector | null = null;

function resetDatadogConnector(): void {
  _instance = null;
}

export function getDatadogConnector(): DatadogConnector {
  if (!_instance) {
    _instance = new DatadogConnector();
  }
  return _instance;
}

export { getDatadogConnector as datadog };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/datadog/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/datadog/connect  { apiKey, appKey, site? }
 */
export async function handleDatadogConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let apiKey: string;
  let appKey: string;
  let site: string | undefined;

  try {
    const parsed = JSON.parse(body) as {
      apiKey?: unknown;
      appKey?: unknown;
      site?: unknown;
    };
    if (typeof parsed.apiKey !== "string" || !parsed.apiKey) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "apiKey is required" }),
      };
    }
    if (typeof parsed.appKey !== "string" || !parsed.appKey) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "appKey is required" }),
      };
    }
    apiKey = parsed.apiKey;
    appKey = parsed.appKey;
    site =
      typeof parsed.site === "string" && parsed.site
        ? parsed.site
        : "datadoghq.com";
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const res = await fetch(`https://api.${site}/api/v1/validate`, {
      headers: {
        "DD-API-KEY": apiKey,
        "DD-APPLICATION-KEY": appKey,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Datadog (HTTP ${res.status}) — check apiKey and appKey`,
        }),
      };
    }

    const tokens: DatadogTokens = {
      apiKey,
      appKey,
      site,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetDatadogConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        site,
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
 * POST /connections/datadog/test
 */
export async function handleDatadogTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Datadog not connected" }),
    };
  }
  try {
    const connector = getDatadogConnector();
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
 * DELETE /connections/datadog
 */
export function handleDatadogDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetDatadogConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
