/**
 * Intercom connector — read/write Intercom conversations via the Intercom REST API v2.10.
 *
 * Auth: Bearer access token (single workspace).
 *   - Env var: INTERCOM_ACCESS_TOKEN
 *   - Stored: getSecretJsonSync("intercom") → IntercomTokens
 *   - Header: Authorization: Bearer <token>, Intercom-Version: 2.10
 *
 * Tools: listConversations, getConversation, replyToConversation, closeConversation, listContacts
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

export interface IntercomTokens {
  accessToken: string;
  workspaceName?: string;
  connected_at: string;
}

export interface IntercomConversation {
  id: string;
  type: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  state: "open" | "closed" | "snoozed" | "pending";
  assignee: { type: string; id: string } | null;
  contacts: { contacts: Array<{ type: string; id: string }> };
}

export interface IntercomContact {
  id: string;
  type: string;
  name: string | null;
  email: string | null;
  created_at: number;
  updated_at: number;
}

export interface IntercomListResult<T> {
  conversations?: T[];
  contacts?: T[];
  total_count: number;
  pages: {
    type: string;
    page: number;
    per_page: number;
    total_pages: number;
  };
}

const BASE_URL = "https://api.intercom.io";
const INTERCOM_VERSION = "2.10";

export class IntercomConnector extends BaseConnector {
  readonly providerName = "intercom";

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Intercom not connected. Run: patchwork-os connect intercom or set INTERCOM_ACCESS_TOKEN",
      );
    }
    return {
      token: tokens.accessToken,
      scopes: ["read", "write"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async (token) => {
        const res = await fetch(`${BASE_URL}/me`, {
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
          message: "Intercom authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect intercom",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Intercom permissions",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Intercom resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Intercom API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Intercom API error: HTTP ${s}`,
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
          message: `Cannot connect to Intercom: ${error.message}`,
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
      id: "intercom",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.workspaceName,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async listConversations(
    params: {
      status?: "open" | "closed" | "snoozed" | "pending";
      assigneeId?: string;
      perPage?: number;
    } = {},
  ): Promise<IntercomListResult<IntercomConversation>> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({
        per_page: String(params.perPage ?? 20),
      });
      if (params.status) qs.set("status", params.status);
      if (params.assigneeId) qs.set("assignee_id", params.assigneeId);
      const res = await fetch(`${BASE_URL}/conversations?${qs}`, {
        headers: this.buildHeaders(token),
      });

      this.updateRateLimitFromHeaders({
        "x-ratelimit-remaining":
          res.headers.get("x-ratelimit-remaining") ?? undefined,
        "retry-after": res.headers.get("retry-after") ?? undefined,
      });

      if (!res.ok) throw res;
      return res.json() as Promise<IntercomListResult<IntercomConversation>>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as IntercomListResult<IntercomConversation>;
  }

  async getConversation(conversationId: string): Promise<IntercomConversation> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${BASE_URL}/conversations/${conversationId}`, {
        headers: this.buildHeaders(token),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<IntercomConversation>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as IntercomConversation;
  }

  async replyToConversation(
    conversationId: string,
    body: string,
    type: "comment" | "note" = "comment",
  ): Promise<IntercomConversation> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(
        `${BASE_URL}/conversations/${conversationId}/reply`,
        {
          method: "POST",
          headers: {
            ...this.buildHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ type: "admin", message_type: type, body }),
        },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<IntercomConversation>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as IntercomConversation;
  }

  async closeConversation(
    conversationId: string,
  ): Promise<IntercomConversation> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(
        `${BASE_URL}/conversations/${conversationId}/parts`,
        {
          method: "POST",
          headers: {
            ...this.buildHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ type: "admin", message_type: "close" }),
        },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<IntercomConversation>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as IntercomConversation;
  }

  async listContacts(
    params: { query?: string; perPage?: number } = {},
  ): Promise<IntercomListResult<IntercomContact>> {
    const result = await this.apiCall(async (token) => {
      if (params.query) {
        const res = await fetch(`${BASE_URL}/contacts/search`, {
          method: "POST",
          headers: {
            ...this.buildHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: {
              operator: "AND",
              value: [{ field: "name", operator: "~", value: params.query }],
            },
          }),
        });
        if (!res.ok) throw res;
        return res.json() as Promise<IntercomListResult<IntercomContact>>;
      }
      const qs = new URLSearchParams({
        per_page: String(params.perPage ?? 20),
      });
      const res = await fetch(`${BASE_URL}/contacts?${qs}`, {
        headers: this.buildHeaders(token),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<IntercomListResult<IntercomContact>>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as IntercomListResult<IntercomContact>;
  }

  async searchContacts(
    query: string,
  ): Promise<IntercomListResult<IntercomContact>> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${BASE_URL}/contacts/search`, {
        method: "POST",
        headers: {
          ...this.buildHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: {
            operator: "OR",
            value: [
              { field: "email", operator: "=", value: query },
              { field: "name", operator: "~", value: query },
            ],
          },
        }),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<IntercomListResult<IntercomContact>>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as IntercomListResult<IntercomContact>;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Intercom-Version": INTERCOM_VERSION,
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): IntercomTokens | null {
  const envToken = process.env.INTERCOM_ACCESS_TOKEN;
  if (envToken) {
    return {
      accessToken: envToken,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<IntercomTokens>("intercom");
}

export function saveTokens(tokens: IntercomTokens): void {
  storeSecretJsonSync("intercom", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("intercom");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: IntercomConnector | null = null;

function resetIntercomConnector(): void {
  _instance = null;
}

export function getIntercomConnector(): IntercomConnector {
  if (!_instance) {
    _instance = new IntercomConnector();
  }
  return _instance;
}

export { getIntercomConnector as intercom };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/intercom/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/intercom/connect  { accessToken }
 */
export async function handleIntercomConnect(
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
    const res = await fetch(`${BASE_URL}/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Intercom-Version": INTERCOM_VERSION,
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Intercom (HTTP ${res.status}) — check accessToken`,
        }),
      };
    }
    const me = (await res.json()) as {
      name?: string;
      app?: { name?: string };
    };

    const workspaceName = me.app?.name ?? me.name ?? "unknown";
    const tokens: IntercomTokens = {
      accessToken,
      workspaceName,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetIntercomConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        workspaceName,
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
 * POST /connections/intercom/test
 */
export async function handleIntercomTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Intercom not connected" }),
    };
  }
  try {
    const connector = getIntercomConnector();
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
 * DELETE /connections/intercom
 */
export function handleIntercomDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetIntercomConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
