/**
 * Grafana connector — dashboards, alerts, annotations, and datasource queries.
 *
 * Auth: API key (Service Account token from Grafana → Administration → Service accounts).
 *   - Env vars: GRAFANA_API_KEY, GRAFANA_BASE_URL
 *   - Stored: getSecretJsonSync("grafana") → GrafanaTokens
 *   - Header: Authorization: Bearer <api_key>
 *
 * Tools: getDashboards, getDashboard, getAlertRules, getAlertRule,
 *        createAnnotation, getAnnotations, deleteAnnotation,
 *        getDataSources, queryDataSource, getFolders
 *
 * Webhook verification: Grafana 12+ HMAC-SHA256 on X-Grafana-Alerting-Signature.
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

export interface GrafanaTokens {
  apiKey: string;
  baseUrl: string; // e.g. "https://grafana.example.com" or "http://localhost:3000"
  orgName?: string;
  connected_at: string;
}

export interface GrafanaDashboard {
  id: number;
  uid: string;
  title: string;
  url: string;
  tags: string[];
  folderTitle?: string;
  folderId?: number;
}

export interface GrafanaAlertRule {
  uid: string;
  title: string;
  condition: string;
  data: unknown[];
  intervalSeconds: number;
  orgId: number;
  namespaceUID: string;
  ruleGroup: string;
}

export interface GrafanaAnnotation {
  id: number;
  dashboardUID?: string;
  panelId?: number;
  time: number;
  timeEnd?: number;
  text: string;
  tags?: string[];
  login?: string;
}

export interface GrafanaDataSource {
  id: number;
  uid: string;
  name: string;
  type: string;
  url: string;
  access: string;
}

export interface GrafanaFolder {
  id: number;
  uid: string;
  title: string;
  url: string;
  created: string;
  updated: string;
}

export class GrafanaConnector extends BaseConnector {
  readonly providerName = "grafana";
  private tokens: GrafanaTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Grafana not connected. Run: patchwork-os connect grafana or set GRAFANA_API_KEY + GRAFANA_BASE_URL",
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
        const res = await fetch(`${this.baseUrl()}/api/org`, {
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
          message: "Grafana authentication failed — check API key",
          retryable: false,
          suggestedAction: "patchwork-os connect grafana",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Grafana permissions for this resource",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Grafana resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Grafana API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Grafana API error: HTTP ${s}`,
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
          message: `Cannot connect to Grafana: ${error.message}`,
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
      id: "grafana",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.orgName ?? tokens?.baseUrl ?? undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async getDashboards(query?: string, limit = 50): Promise<GrafanaDashboard[]> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams({ type: "dash-db", limit: String(limit) });
      if (query) qs.set("query", query);
      const res = await fetch(`${this.baseUrl()}/api/search?${qs}`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<GrafanaDashboard[]>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as GrafanaDashboard[];
  }

  async getDashboard(uid: string): Promise<GrafanaDashboard> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${this.baseUrl()}/api/dashboards/uid/${encodeURIComponent(uid)}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<{
        dashboard: GrafanaDashboard;
        meta: unknown;
      }>;
    });

    if ("error" in result) throw new Error(result.error.message);
    const data = result.data as {
      dashboard: GrafanaDashboard;
      meta: unknown;
    };
    return data.dashboard;
  }

  async getAlertRules(limit = 100): Promise<GrafanaAlertRule[]> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${this.baseUrl()}/api/v1/provisioning/alert-rules`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      const rules = (await res.json()) as GrafanaAlertRule[];
      return rules.slice(0, limit);
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as GrafanaAlertRule[];
  }

  async getAlertRule(uid: string): Promise<GrafanaAlertRule> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${this.baseUrl()}/api/v1/provisioning/alert-rules/${encodeURIComponent(uid)}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<GrafanaAlertRule>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as GrafanaAlertRule;
  }

  async createAnnotation(
    dashboardUid: string,
    panelId: number,
    text: string,
    options: {
      tags?: string[];
      time?: number;
      timeEnd?: number;
    } = {},
  ): Promise<{ id: number }> {
    const result = await this.apiCall(async () => {
      const body: Record<string, unknown> = {
        dashboardUID: dashboardUid,
        panelId,
        text,
      };
      if (options.tags) body.tags = options.tags;
      if (options.time !== undefined) body.time = options.time;
      if (options.timeEnd !== undefined) body.timeEnd = options.timeEnd;

      const res = await fetch(`${this.baseUrl()}/api/annotations`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ id: number; message: string }>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as { id: number };
  }

  async getAnnotations(
    options: {
      dashboardUid?: string;
      limit?: number;
      from?: number;
      to?: number;
    } = {},
  ): Promise<GrafanaAnnotation[]> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (options.dashboardUid) qs.set("dashboardUID", options.dashboardUid);
      if (options.limit) qs.set("limit", String(options.limit));
      if (options.from !== undefined) qs.set("from", String(options.from));
      if (options.to !== undefined) qs.set("to", String(options.to));

      const res = await fetch(
        `${this.baseUrl()}/api/annotations${qs.toString() ? `?${qs}` : ""}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<GrafanaAnnotation[]>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as GrafanaAnnotation[];
  }

  async deleteAnnotation(id: number): Promise<{ message: string }> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${this.baseUrl()}/api/annotations/${id}`, {
        method: "DELETE",
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ message: string }>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as { message: string };
  }

  async getDataSources(): Promise<GrafanaDataSource[]> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${this.baseUrl()}/api/datasources`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<GrafanaDataSource[]>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as GrafanaDataSource[];
  }

  async queryDataSource(
    datasourceUid: string,
    queries: unknown[],
    from = "now-1h",
    to = "now",
  ): Promise<unknown> {
    const result = await this.apiCall(async () => {
      const body = {
        queries: queries.map((q) => ({
          ...(q as Record<string, unknown>),
          datasource: { uid: datasourceUid },
        })),
        from,
        to,
      };
      const res = await fetch(`${this.baseUrl()}/api/ds/query`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw res;
      return res.json();
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async getFolders(): Promise<GrafanaFolder[]> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${this.baseUrl()}/api/folders`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<GrafanaFolder[]>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as GrafanaFolder[];
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private baseUrl(): string {
    return (this.tokens?.baseUrl ?? "").replace(/\/$/, "");
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.tokens?.apiKey ?? ""}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }
}

// ── Webhook verification ─────────────────────────────────────────────────────

/**
 * Verify a Grafana 12+ alerting webhook signature.
 * Grafana signs the raw body with HMAC-SHA256 and sends the hex digest
 * in the X-Grafana-Alerting-Signature header (optionally prefixed "sha256=").
 */
export function verifyGrafanaWebhook(
  rawBody: string | Buffer,
  signatureHeader: string,
  signingSecret: string,
): boolean {
  if (!signatureHeader || !signingSecret) return false;
  const expected = createHmac("sha256", signingSecret)
    .update(rawBody)
    .digest("hex");
  const incoming = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;
  if (expected.length !== incoming.length) return false;
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(incoming, "hex"),
  );
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): GrafanaTokens | null {
  const envApiKey = process.env.GRAFANA_API_KEY;
  const envBaseUrl = process.env.GRAFANA_BASE_URL;
  if (envApiKey && envBaseUrl) {
    return {
      apiKey: envApiKey,
      baseUrl: envBaseUrl,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<GrafanaTokens>("grafana");
}

export function saveTokens(tokens: GrafanaTokens): void {
  storeSecretJsonSync("grafana", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("grafana");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: GrafanaConnector | null = null;

function resetGrafanaConnector(): void {
  _instance = null;
}

export function getGrafanaConnector(): GrafanaConnector {
  if (!_instance) {
    _instance = new GrafanaConnector();
  }
  return _instance;
}

export { getGrafanaConnector as grafana };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/grafana/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/grafana/connect  { apiKey, baseUrl }
 */
export async function handleGrafanaConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let apiKey: string;
  let baseUrl: string;

  try {
    const parsed = JSON.parse(body) as {
      apiKey?: unknown;
      baseUrl?: unknown;
    };
    if (typeof parsed.apiKey !== "string" || !parsed.apiKey) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "apiKey is required" }),
      };
    }
    if (typeof parsed.baseUrl !== "string" || !parsed.baseUrl) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "baseUrl is required" }),
      };
    }
    apiKey = parsed.apiKey;
    baseUrl = parsed.baseUrl.replace(/\/$/, "");

    // Basic SSRF guard: must be http or https scheme
    if (!/^https?:\/\//i.test(baseUrl)) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "baseUrl must start with http:// or https://",
        }),
      };
    }
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const res = await fetch(`${baseUrl}/api/org`, {
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
          error: `Credentials rejected by Grafana (HTTP ${res.status}) — check apiKey`,
        }),
      };
    }
    const detail = (await res.json().catch(() => ({}))) as {
      name?: string;
      id?: number;
    };

    const tokens: GrafanaTokens = {
      apiKey,
      baseUrl,
      orgName: detail.name,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetGrafanaConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        orgName: tokens.orgName,
        baseUrl,
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
 * POST /connections/grafana/test
 */
export async function handleGrafanaTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Grafana not connected" }),
    };
  }
  try {
    const connector = getGrafanaConnector();
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
 * DELETE /connections/grafana
 */
export function handleGrafanaDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetGrafanaConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
