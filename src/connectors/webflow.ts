/**
 * Webflow connector — read-only access to Webflow CMS via the Webflow v2 API.
 *
 * Auth: Site API Token via `Authorization: Bearer <token>` + `accept-version: 2.0.0`.
 *   - Env var: WEBFLOW_API_TOKEN (+ optional WEBFLOW_SITE_ID)
 *   - Stored: getSecretJsonSync("webflow") → WebflowTokens
 *
 * Tools: listSites, getSite, listCollections, getCollection, listCollectionItems,
 *        getCollectionItem, listForms, listFormSubmissions
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

export interface WebflowTokens {
  accessToken: string;
  siteId?: string;
  siteName?: string;
  connected_at: string;
}

export interface WebflowSite {
  id: string;
  displayName?: string;
  shortName?: string;
  workspaceId?: string;
  createdOn?: string;
  lastPublished?: string;
}

export interface WebflowCollection {
  id: string;
  displayName?: string;
  singularName?: string;
  slug?: string;
  createdOn?: string;
  lastUpdated?: string;
}

export interface WebflowCollectionItem {
  id: string;
  cmsLocaleId?: string;
  lastPublished?: string | null;
  lastUpdated?: string;
  createdOn?: string;
  isArchived?: boolean;
  isDraft?: boolean;
  fieldData?: Record<string, unknown>;
}

export interface WebflowForm {
  id: string;
  displayName?: string;
  createdOn?: string;
  lastUpdated?: string;
  fields?: Record<string, unknown>;
}

export interface WebflowFormSubmission {
  id: string;
  displayName?: string;
  siteId?: string;
  formId?: string;
  dateSubmitted?: string;
  formResponse?: Record<string, unknown>;
}

export interface WebflowListResult<T> {
  items: T[];
  pagination?: {
    limit?: number;
    offset?: number;
    total?: number;
  };
}

const BASE_URL = "https://api.webflow.com/v2";
const MAX_LIMIT = 100;

export class WebflowConnector extends BaseConnector {
  readonly providerName = "webflow";
  private tokens: WebflowTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Webflow not connected. Run: patchwork-os connect webflow or set WEBFLOW_API_TOKEN",
      );
    }
    this.tokens = tokens;
    return {
      token: tokens.accessToken,
      scopes: ["read"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async () => {
        const res = await fetch(`${BASE_URL}/token/authorized_by`, {
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
      if (s === 400)
        return {
          code: "provider_error",
          message: `Webflow API bad request (HTTP 400)`,
          retryable: false,
        };
      if (s === 401)
        return {
          code: "auth_expired",
          message: "Webflow authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect webflow",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Webflow permissions",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Webflow resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Webflow API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Webflow API error: HTTP ${s}`,
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
          message: `Cannot connect to Webflow: ${error.message}`,
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
      id: "webflow",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.siteName
        ? `Webflow site ${tokens.siteName}`
        : tokens?.siteId
          ? `Webflow site ${tokens.siteId}`
          : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async listSites(): Promise<WebflowListResult<WebflowSite>> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/sites`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<{ sites?: WebflowSite[] }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    const data = result.data as { sites?: WebflowSite[] };
    return { items: data.sites ?? [] };
  }

  async getSite(siteId: string): Promise<WebflowSite> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/sites/${encodeURIComponent(siteId)}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<WebflowSite>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as WebflowSite;
  }

  async listCollections(
    siteId: string,
  ): Promise<WebflowListResult<WebflowCollection>> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/sites/${encodeURIComponent(siteId)}/collections`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<{ collections?: WebflowCollection[] }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    const data = result.data as { collections?: WebflowCollection[] };
    return { items: data.collections ?? [] };
  }

  async getCollection(collectionId: string): Promise<WebflowCollection> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/collections/${encodeURIComponent(collectionId)}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<WebflowCollection>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as WebflowCollection;
  }

  async listCollectionItems(
    collectionId: string,
    params: { limit?: number; offset?: number } = {},
  ): Promise<WebflowListResult<WebflowCollectionItem>> {
    const limit = Math.min(params.limit ?? MAX_LIMIT, MAX_LIMIT);
    const offset = params.offset ?? 0;
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      qs.set("offset", String(offset));
      const res = await fetch(
        `${BASE_URL}/collections/${encodeURIComponent(collectionId)}/items?${qs}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<{
        items?: WebflowCollectionItem[];
        pagination?: WebflowListResult<WebflowCollectionItem>["pagination"];
      }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    const data = result.data as {
      items?: WebflowCollectionItem[];
      pagination?: WebflowListResult<WebflowCollectionItem>["pagination"];
    };
    return { items: data.items ?? [], pagination: data.pagination };
  }

  async getCollectionItem(
    collectionId: string,
    itemId: string,
  ): Promise<WebflowCollectionItem> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/collections/${encodeURIComponent(
          collectionId,
        )}/items/${encodeURIComponent(itemId)}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<WebflowCollectionItem>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as WebflowCollectionItem;
  }

  async listForms(siteId: string): Promise<WebflowListResult<WebflowForm>> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/sites/${encodeURIComponent(siteId)}/forms`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<{ forms?: WebflowForm[] }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    const data = result.data as { forms?: WebflowForm[] };
    return { items: data.forms ?? [] };
  }

  async listFormSubmissions(
    formId: string,
    params: { limit?: number; offset?: number } = {},
  ): Promise<WebflowListResult<WebflowFormSubmission>> {
    const limit = Math.min(params.limit ?? MAX_LIMIT, MAX_LIMIT);
    const offset = params.offset ?? 0;
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      qs.set("offset", String(offset));
      const res = await fetch(
        `${BASE_URL}/forms/${encodeURIComponent(formId)}/submissions?${qs}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<{
        formSubmissions?: WebflowFormSubmission[];
        pagination?: WebflowListResult<WebflowFormSubmission>["pagination"];
      }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    const data = result.data as {
      formSubmissions?: WebflowFormSubmission[];
      pagination?: WebflowListResult<WebflowFormSubmission>["pagination"];
    };
    return { items: data.formSubmissions ?? [], pagination: data.pagination };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const token = this.tokens?.accessToken ?? "";
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "accept-version": "2.0.0",
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): WebflowTokens | null {
  const envToken = process.env.WEBFLOW_API_TOKEN;
  if (envToken) {
    return {
      accessToken: envToken,
      siteId: process.env.WEBFLOW_SITE_ID,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<WebflowTokens>("webflow");
}

export function saveTokens(tokens: WebflowTokens): void {
  storeSecretJsonSync("webflow", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("webflow");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: WebflowConnector | null = null;

function resetWebflowConnector(): void {
  _instance = null;
}

export function getWebflowConnector(): WebflowConnector {
  if (!_instance) {
    _instance = new WebflowConnector();
  }
  return _instance;
}

export { getWebflowConnector as webflow };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/webflow/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/webflow/connect  { accessToken }
 * Validates by GET /v2/sites; captures first site's id + displayName.
 */
export async function handleWebflowConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let accessToken: string;

  try {
    const parsed = JSON.parse(body) as { accessToken?: unknown };
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "accessToken is required" }),
      };
    }
    accessToken = parsed.accessToken;
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const res = await fetch(`${BASE_URL}/sites`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "accept-version": "2.0.0",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Webflow (HTTP ${res.status}) — check accessToken`,
        }),
      };
    }
    const data = (await res.json()) as { sites?: WebflowSite[] };
    const firstSite = data.sites?.[0];
    const siteId = firstSite?.id;
    const siteName = firstSite?.displayName;

    const tokens: WebflowTokens = {
      accessToken,
      siteId,
      siteName,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetWebflowConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        siteId,
        siteName,
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
 * POST /connections/webflow/test
 */
export async function handleWebflowTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Webflow not connected" }),
    };
  }
  try {
    const connector = getWebflowConnector();
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
 * DELETE /connections/webflow
 */
export function handleWebflowDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetWebflowConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
