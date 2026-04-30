/**
 * Zendesk connector — read/write Zendesk tickets via the Zendesk REST API v2.
 *
 * Auth: API token + email + subdomain.
 *   - Env vars: ZENDESK_API_TOKEN, ZENDESK_EMAIL, ZENDESK_SUBDOMAIN
 *   - Stored: getSecretJsonSync("zendesk") → ZendeskTokens
 *   - Basic auth: `email/token:api_token` (Zendesk token auth convention)
 *
 * Tools: listTickets, getTicket, addComment, updateStatus, listUsers
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

export interface ZendeskTokens {
  apiToken: string;
  email: string;
  subdomain: string; // e.g. "acme" → https://acme.zendesk.com
  connected_at: string;
}

export interface ZendeskTicket {
  id: number;
  subject: string;
  description: string;
  status: "new" | "open" | "pending" | "hold" | "solved" | "closed";
  priority: "urgent" | "high" | "normal" | "low" | null;
  type: "problem" | "incident" | "question" | "task" | null;
  requester_id: number;
  assignee_id: number | null;
  group_id: number | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  url: string;
}

export interface ZendeskComment {
  id: number;
  type: "Comment" | "VoiceComment";
  author_id: number;
  body: string;
  html_body: string;
  public: boolean;
  created_at: string;
}

export interface ZendeskUser {
  id: number;
  name: string;
  email: string;
  role: "end-user" | "agent" | "admin";
  active: boolean;
  created_at: string;
}

export interface ZendeskListResult<T> {
  results: T[];
  count: number;
  next_page: string | null;
  previous_page: string | null;
}

export class ZendeskConnector extends BaseConnector {
  readonly providerName = "zendesk";
  private tokens: ZendeskTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Zendesk not connected. Run: patchwork-os connect zendesk or set ZENDESK_API_TOKEN",
      );
    }
    this.tokens = tokens;
    return {
      token: tokens.apiToken,
      scopes: ["read", "write"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async (token) => {
        const res = await fetch(`${this.baseUrl()}/api/v2/users/me`, {
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
          message: "Zendesk authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect zendesk",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Zendesk permissions",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Zendesk ticket or resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Zendesk API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Zendesk API error: HTTP ${s}`,
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
          message: `Cannot connect to Zendesk: ${error.message}`,
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
      id: "zendesk",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens ? `https://${tokens.subdomain}.zendesk.com` : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async listTickets(
    params: {
      status?: ZendeskTicket["status"];
      assigneeId?: number;
      query?: string;
      perPage?: number;
    } = {},
  ): Promise<ZendeskListResult<ZendeskTicket>> {
    const result = await this.apiCall(async (token) => {
      let url: string;
      if (params.query) {
        const q = encodeURIComponent(`type:ticket ${params.query}`);
        url = `${this.baseUrl()}/api/v2/search.json?query=${q}&per_page=${params.perPage ?? 25}`;
      } else {
        const qs = new URLSearchParams({
          per_page: String(params.perPage ?? 25),
        });
        if (params.status) qs.set("status", params.status);
        if (params.assigneeId) qs.set("assignee_id", String(params.assigneeId));
        url = `${this.baseUrl()}/api/v2/tickets.json?${qs}`;
      }
      const res = await fetch(url, { headers: this.buildHeaders(token) });

      this.updateRateLimitFromHeaders({
        "x-ratelimit-remaining":
          res.headers.get("x-ratelimit-remaining") ?? undefined,
        "retry-after": res.headers.get("retry-after") ?? undefined,
      });

      if (!res.ok) throw res;
      const data = (await res.json()) as {
        tickets?: ZendeskTicket[];
        results?: ZendeskTicket[];
        count?: number;
        next_page?: string | null;
        previous_page?: string | null;
      };
      const items = data.tickets ?? data.results ?? [];
      return {
        results: items,
        count: data.count ?? items.length,
        next_page: data.next_page ?? null,
        previous_page: data.previous_page ?? null,
      };
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as ZendeskListResult<ZendeskTicket>;
  }

  async getTicket(ticketId: number): Promise<ZendeskTicket | null> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(
        `${this.baseUrl()}/api/v2/tickets/${ticketId}.json`,
        {
          headers: this.buildHeaders(token),
        },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw res;
      const data = (await res.json()) as { ticket: ZendeskTicket };
      return data.ticket;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as ZendeskTicket | null;
  }

  async getTicketComments(ticketId: number): Promise<ZendeskComment[]> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(
        `${this.baseUrl()}/api/v2/tickets/${ticketId}/comments.json`,
        { headers: this.buildHeaders(token) },
      );
      if (!res.ok) throw res;
      const data = (await res.json()) as { comments: ZendeskComment[] };
      return data.comments;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as ZendeskComment[];
  }

  async addComment(
    ticketId: number,
    body: string,
    isPublic = true,
  ): Promise<ZendeskTicket> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(
        `${this.baseUrl()}/api/v2/tickets/${ticketId}.json`,
        {
          method: "PUT",
          headers: {
            ...this.buildHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ticket: {
              comment: { body, public: isPublic },
            },
          }),
        },
      );
      if (!res.ok) throw res;
      const data = (await res.json()) as { ticket: ZendeskTicket };
      return data.ticket;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as ZendeskTicket;
  }

  async updateStatus(
    ticketId: number,
    status: ZendeskTicket["status"],
  ): Promise<ZendeskTicket> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(
        `${this.baseUrl()}/api/v2/tickets/${ticketId}.json`,
        {
          method: "PUT",
          headers: {
            ...this.buildHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ticket: { status } }),
        },
      );
      if (!res.ok) throw res;
      const data = (await res.json()) as { ticket: ZendeskTicket };
      return data.ticket;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as ZendeskTicket;
  }

  async listUsers(
    role?: ZendeskUser["role"],
    perPage = 50,
  ): Promise<ZendeskUser[]> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({ per_page: String(perPage) });
      if (role) qs.set("role", role);
      const res = await fetch(`${this.baseUrl()}/api/v2/users.json?${qs}`, {
        headers: this.buildHeaders(token),
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as { users: ZendeskUser[] };
      return data.users;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as ZendeskUser[];
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private baseUrl(): string {
    const sub = this.tokens?.subdomain;
    if (!sub) throw new Error("Zendesk not connected");
    if (!/^[a-z0-9-]{1,63}$/i.test(sub)) {
      throw new Error("Zendesk subdomain has invalid format");
    }
    return `https://${sub}.zendesk.com`;
  }

  private buildHeaders(token: string): Record<string, string> {
    const email = this.tokens?.email ?? "";
    // Zendesk token auth: email/token:api_token
    const basic = Buffer.from(`${email}/token:${token}`).toString("base64");
    return {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): ZendeskTokens | null {
  const envToken = process.env.ZENDESK_API_TOKEN;
  const envEmail = process.env.ZENDESK_EMAIL;
  const envSubdomain = process.env.ZENDESK_SUBDOMAIN;
  if (envToken && envEmail && envSubdomain) {
    return {
      apiToken: envToken,
      email: envEmail,
      subdomain: envSubdomain,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<ZendeskTokens>("zendesk");
}

export function saveTokens(tokens: ZendeskTokens): void {
  storeSecretJsonSync("zendesk", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("zendesk");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: ZendeskConnector | null = null;

function resetZendeskConnector(): void {
  _instance = null;
}

export function getZendeskConnector(): ZendeskConnector {
  if (!_instance) {
    _instance = new ZendeskConnector();
  }
  return _instance;
}

export { getZendeskConnector as zendesk };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/zendesk/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/zendesk/connect  { apiToken, email, subdomain }
 */
export async function handleZendeskConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let apiToken: string;
  let email: string;
  let subdomain: string;

  try {
    const parsed = JSON.parse(body) as {
      apiToken?: unknown;
      email?: unknown;
      subdomain?: unknown;
    };
    if (typeof parsed.apiToken !== "string" || !parsed.apiToken) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "apiToken is required" }),
      };
    }
    if (typeof parsed.email !== "string" || !parsed.email) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "email is required" }),
      };
    }
    if (typeof parsed.subdomain !== "string" || !parsed.subdomain) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: 'subdomain is required (e.g. "acme" for acme.zendesk.com)',
        }),
      };
    }
    apiToken = parsed.apiToken;
    email = parsed.email;
    subdomain = parsed.subdomain.replace(/\.zendesk\.com$/, ""); // strip if full domain given
    // Validate subdomain shape after suffix strip — prevents URL injection /
    // SSRF via `https://${subdomain}.zendesk.com` interpolation in baseUrl().
    if (!/^[a-z0-9-]{1,63}$/i.test(subdomain)) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error:
            "subdomain must be 1-63 alphanumeric/hyphen characters (no dots, slashes, or special chars)",
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
    const basic = Buffer.from(`${email}/token:${apiToken}`).toString("base64");
    const res = await fetch(
      `https://${subdomain}.zendesk.com/api/v2/users/me.json`,
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
          error: `Credentials rejected by Zendesk (HTTP ${res.status}) — check apiToken, email, and subdomain`,
        }),
      };
    }
    const me = (await res.json()) as {
      user?: { name?: string; email?: string };
    };

    const tokens: ZendeskTokens = {
      apiToken,
      email,
      subdomain,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetZendeskConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        subdomain,
        user: me.user?.name ?? me.user?.email ?? "unknown",
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
 * POST /connections/zendesk/test
 */
export async function handleZendeskTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Zendesk not connected" }),
    };
  }
  try {
    const connector = getZendeskConnector();
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
 * DELETE /connections/zendesk
 */
export function handleZendeskDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetZendeskConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
