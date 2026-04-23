/**
 * Confluence connector — read/write Confluence pages via Atlassian REST API v2.
 *
 * Auth: API token + email + instance URL (same credential shape as Jira).
 *   - Env vars: CONFLUENCE_API_TOKEN, CONFLUENCE_INSTANCE_URL, CONFLUENCE_EMAIL
 *   - Stored: getSecretJsonSync("confluence") → ConfluenceTokens
 *
 * Tools: getPage, search, createPage, appendToPage, listSpaces
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

// Confluence Cloud REST API v2
const CONFLUENCE_API_V2 = "/wiki/api/v2";

export interface ConfluenceTokens {
  accessToken: string; // API token
  email: string; // Atlassian account email for Basic auth
  instanceUrl: string; // e.g. https://myteam.atlassian.net
  connected_at: string;
}

export interface ConfluencePage {
  id: string;
  title: string;
  status: string;
  spaceId: string;
  parentId?: string;
  version: { number: number; createdAt: string };
  body?: {
    storage?: { value: string; representation: "storage" };
  };
  _links: { webui: string };
}

export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: string;
  status: string;
  _links: { webui: string };
}

export interface ConfluenceSearchResult {
  results: Array<{
    content: {
      id: string;
      type: string;
      title: string;
      _links: { webui: string };
    };
    excerpt: string;
    url: string;
    lastModified: string;
  }>;
  totalSize: number;
  start: number;
  limit: number;
}

export class ConfluenceConnector extends BaseConnector {
  readonly providerName = "confluence";
  private tokens: ConfluenceTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Confluence not connected. Run: patchwork-os connect confluence or set CONFLUENCE_API_TOKEN",
      );
    }
    this.tokens = tokens;
    return {
      token: tokens.accessToken,
      scopes: ["read:confluence-content.all", "write:confluence-content"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async (token) => {
        const url = `${this.tokens?.instanceUrl}${CONFLUENCE_API_V2}/spaces?limit=1`;
        const res = await fetch(url, {
          headers: this.buildHeaders(token),
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
      if (s === 401)
        return {
          code: "auth_expired",
          message: "Confluence authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect confluence",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Confluence permissions",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Confluence page or space not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Confluence API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Confluence API error: HTTP ${s}`,
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
          message: `Cannot connect to Confluence: ${error.message}`,
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
      id: "confluence",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.instanceUrl,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async getPage(
    pageId: string,
    includeBody = true,
  ): Promise<ConfluencePage | null> {
    const result = await this.apiCall(async (token) => {
      const bodyParam = includeBody ? "&body-format=storage" : "";
      const url = `${this.tokens?.instanceUrl}${CONFLUENCE_API_V2}/pages/${pageId}?${bodyParam}`;
      const res = await fetch(url, { headers: this.buildHeaders(token) });

      this.updateRateLimitFromHeaders({
        "x-ratelimit-remaining":
          res.headers.get("x-ratelimit-remaining") ?? undefined,
        "retry-after": res.headers.get("retry-after") ?? undefined,
      });

      if (res.status === 404) return null;
      if (!res.ok) throw res;
      return res.json();
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as ConfluencePage | null;
  }

  async search(query: string, limit = 25): Promise<ConfluenceSearchResult> {
    const result = await this.apiCall(async (token) => {
      // Use legacy v1 search which supports full-text CQL
      const cql = encodeURIComponent(`text ~ "${query}" AND type = page`);
      const url = `${this.tokens?.instanceUrl}/wiki/rest/api/search?cql=${cql}&limit=${limit}&expand=content.space`;
      const res = await fetch(url, { headers: this.buildHeaders(token) });
      if (!res.ok) throw res;
      return res.json();
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as ConfluenceSearchResult;
  }

  async createPage(params: {
    spaceId: string;
    title: string;
    body: string;
    parentId?: string;
  }): Promise<ConfluencePage> {
    const result = await this.apiCall(async (token) => {
      const payload: Record<string, unknown> = {
        spaceId: params.spaceId,
        status: "current",
        title: params.title,
        body: {
          representation: "storage",
          value: params.body,
        },
      };
      if (params.parentId) {
        payload.parentId = params.parentId;
      }

      const url = `${this.tokens?.instanceUrl}${CONFLUENCE_API_V2}/pages`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...this.buildHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw res;
      return res.json();
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as ConfluencePage;
  }

  async appendToPage(pageId: string, content: string): Promise<ConfluencePage> {
    // Fetch current page to get version number and existing body
    const page = await this.getPage(pageId, true);
    if (!page) throw new Error(`Page ${pageId} not found`);

    const existing = page.body?.storage?.value ?? "";
    const newBody = `${existing}\n${content}`;
    const nextVersion = page.version.number + 1;

    const result = await this.apiCall(async (token) => {
      const url = `${this.tokens?.instanceUrl}${CONFLUENCE_API_V2}/pages/${pageId}`;
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          ...this.buildHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: pageId,
          status: "current",
          title: page.title,
          version: { number: nextVersion },
          body: { representation: "storage", value: newBody },
        }),
      });
      if (!res.ok) throw res;
      return res.json();
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as ConfluencePage;
  }

  async listSpaces(limit = 50): Promise<ConfluenceSpace[]> {
    const result = await this.apiCall(async (token) => {
      const url = `${this.tokens?.instanceUrl}${CONFLUENCE_API_V2}/spaces?limit=${limit}&status=current`;
      const res = await fetch(url, { headers: this.buildHeaders(token) });
      if (!res.ok) throw res;
      const data = (await res.json()) as { results: ConfluenceSpace[] };
      return data.results;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as ConfluenceSpace[];
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(token: string): Record<string, string> {
    const email = this.tokens?.email ?? "";
    const basic = Buffer.from(`${email}:${token}`).toString("base64");
    return {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): ConfluenceTokens | null {
  const envToken = process.env.CONFLUENCE_API_TOKEN;
  const envUrl = process.env.CONFLUENCE_INSTANCE_URL;
  const envEmail = process.env.CONFLUENCE_EMAIL;
  if (envToken && envUrl && envEmail) {
    return {
      accessToken: envToken,
      email: envEmail,
      instanceUrl: envUrl.replace(/\/$/, ""),
      connected_at: new Date().toISOString(),
    };
  }

  return getSecretJsonSync<ConfluenceTokens>("confluence");
}

export function saveTokens(tokens: ConfluenceTokens): void {
  storeSecretJsonSync("confluence", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("confluence");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: ConfluenceConnector | null = null;

function resetConfluenceConnector(): void {
  _instance = null;
}

export function getConfluenceConnector(): ConfluenceConnector {
  if (!_instance) {
    _instance = new ConfluenceConnector();
  }
  return _instance;
}

export { getConfluenceConnector as confluence };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/confluence/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/confluence/connect  { token, email, instanceUrl }
 */
export async function handleConfluenceConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let token: string;
  let email: string;
  let instanceUrl: string;

  try {
    const parsed = JSON.parse(body) as {
      token?: unknown;
      email?: unknown;
      instanceUrl?: unknown;
    };
    if (typeof parsed.token !== "string" || !parsed.token) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "token is required" }),
      };
    }
    if (typeof parsed.email !== "string" || !parsed.email) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "email is required" }),
      };
    }
    if (typeof parsed.instanceUrl !== "string" || !parsed.instanceUrl) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "instanceUrl is required (e.g. https://myteam.atlassian.net)",
        }),
      };
    }
    token = parsed.token;
    email = parsed.email;
    instanceUrl = parsed.instanceUrl.replace(/\/$/, "");
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  // Verify credentials by hitting spaces endpoint
  try {
    const basic = Buffer.from(`${email}:${token}`).toString("base64");
    const res = await fetch(
      `${instanceUrl}${CONFLUENCE_API_V2}/spaces?limit=1`,
      {
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Confluence (HTTP ${res.status}) — check token and email`,
        }),
      };
    }

    const tokens: ConfluenceTokens = {
      accessToken: token,
      email,
      instanceUrl,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetConfluenceConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        instanceUrl,
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
 * POST /connections/confluence/test
 */
export async function handleConfluenceTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Confluence not connected" }),
    };
  }
  try {
    const connector = getConfluenceConnector();
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
 * DELETE /connections/confluence
 */
export function handleConfluenceDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetConfluenceConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
