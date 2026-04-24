/**
 * HubSpot connector — read/write HubSpot CRM via the HubSpot REST API v3.
 *
 * Auth: Private App access token (Bearer).
 *   - Env var: HUBSPOT_ACCESS_TOKEN
 *   - Stored: getSecretJsonSync("hubspot") → HubSpotTokens
 *
 * Tools: listContacts, getContact, listDeals, getDeal, createNote, searchContacts
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

const HUBSPOT_BASE = "https://api.hubapi.com";

export interface HubSpotTokens {
  accessToken: string;
  hubId?: number;
  portalName?: string;
  connected_at: string;
}

export interface HubSpotContact {
  id: string;
  properties: {
    firstname?: string;
    lastname?: string;
    email?: string;
    phone?: string;
    company?: string;
    lifecyclestage?: string;
    [key: string]: string | undefined;
  };
  createdAt: string;
  updatedAt: string;
}

export interface HubSpotDeal {
  id: string;
  properties: {
    dealname?: string;
    amount?: string;
    dealstage?: string;
    closedate?: string;
    pipeline?: string;
    hs_deal_stage_probability?: string;
    [key: string]: string | undefined;
  };
  createdAt: string;
  updatedAt: string;
}

export interface HubSpotNote {
  id: string;
  properties: {
    hs_note_body?: string;
    hs_timestamp?: string;
    [key: string]: string | undefined;
  };
  createdAt: string;
  updatedAt: string;
}

export interface HubSpotPaging {
  next?: { after: string; link?: string };
}

export interface HubSpotListResult<T> {
  results: T[];
  paging?: HubSpotPaging;
}

export class HubSpotConnector extends BaseConnector {
  readonly providerName = "hubspot";

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "HubSpot not connected. Run: patchwork-os connect hubspot or set HUBSPOT_ACCESS_TOKEN",
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
        const res = await fetch(`${HUBSPOT_BASE}/account-info/v3/details`, {
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
          message: "HubSpot authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect hubspot",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient HubSpot permissions",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "HubSpot resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "HubSpot API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `HubSpot API error: HTTP ${s}`,
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
          message: `Cannot connect to HubSpot: ${error.message}`,
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
      id: "hubspot",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.portalName ?? (tokens ? "HubSpot" : undefined),
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async listContacts(
    params: { limit?: number; after?: string } = {},
  ): Promise<HubSpotListResult<HubSpotContact>> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({
        limit: String(params.limit ?? 25),
        properties: "firstname,lastname,email,phone,company",
      });
      if (params.after) qs.set("after", params.after);
      const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts?${qs}`, {
        headers: this.buildHeaders(token),
      });
      this.updateRateLimitFromHeaders({
        "x-ratelimit-remaining":
          res.headers.get("x-ratelimit-remaining") ?? undefined,
        "retry-after": res.headers.get("retry-after") ?? undefined,
      });
      if (!res.ok) throw res;
      return res.json() as Promise<HubSpotListResult<HubSpotContact>>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as HubSpotListResult<HubSpotContact>;
  }

  async getContact(contactId: string): Promise<HubSpotContact | null> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({
        properties: "firstname,lastname,email,phone,company,lifecyclestage",
      });
      const res = await fetch(
        `${HUBSPOT_BASE}/crm/v3/objects/contacts/${contactId}?${qs}`,
        { headers: this.buildHeaders(token) },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw res;
      return res.json() as Promise<HubSpotContact>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as HubSpotContact | null;
  }

  async listDeals(
    params: { limit?: number; stage?: string } = {},
  ): Promise<HubSpotListResult<HubSpotDeal>> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({
        limit: String(params.limit ?? 25),
        properties: "dealname,amount,dealstage,closedate,pipeline",
      });
      const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals?${qs}`, {
        headers: this.buildHeaders(token),
      });
      this.updateRateLimitFromHeaders({
        "x-ratelimit-remaining":
          res.headers.get("x-ratelimit-remaining") ?? undefined,
        "retry-after": res.headers.get("retry-after") ?? undefined,
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as HubSpotListResult<HubSpotDeal>;
      // Client-side filter by stage if requested
      if (params.stage) {
        data.results = data.results.filter(
          (d) => d.properties.dealstage === params.stage,
        );
      }
      return data;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as HubSpotListResult<HubSpotDeal>;
  }

  async getDeal(dealId: string): Promise<HubSpotDeal | null> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({
        properties:
          "dealname,amount,dealstage,closedate,pipeline,hs_deal_stage_probability",
      });
      const res = await fetch(
        `${HUBSPOT_BASE}/crm/v3/objects/deals/${dealId}?${qs}`,
        { headers: this.buildHeaders(token) },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw res;
      return res.json() as Promise<HubSpotDeal>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as HubSpotDeal | null;
  }

  async createNote(
    body: string,
    contactId?: string,
    dealId?: string,
  ): Promise<HubSpotNote> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes`, {
        method: "POST",
        headers: {
          ...this.buildHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          properties: {
            hs_note_body: body,
            hs_timestamp: String(Date.now()),
          },
        }),
      });
      if (!res.ok) throw res;
      const note = (await res.json()) as HubSpotNote;

      // Associate with contact if provided
      if (contactId) {
        await fetch(
          `${HUBSPOT_BASE}/crm/v3/objects/notes/${note.id}/associations/contacts/${contactId}/note_to_contact`,
          {
            method: "PUT",
            headers: this.buildHeaders(token),
          },
        );
      }

      // Associate with deal if provided
      if (dealId) {
        await fetch(
          `${HUBSPOT_BASE}/crm/v3/objects/notes/${note.id}/associations/deals/${dealId}/note_to_deal`,
          {
            method: "PUT",
            headers: this.buildHeaders(token),
          },
        );
      }

      return note;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as HubSpotNote;
  }

  async searchContacts(query: string): Promise<HubSpotContact[]> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(
        `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
        {
          method: "POST",
          headers: {
            ...this.buildHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            properties: ["firstname", "lastname", "email", "company"],
            limit: 10,
          }),
        },
      );
      if (!res.ok) throw res;
      const data = (await res.json()) as HubSpotListResult<HubSpotContact>;
      return data.results;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as HubSpotContact[];
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): HubSpotTokens | null {
  const envToken = process.env.HUBSPOT_ACCESS_TOKEN;
  if (envToken) {
    return {
      accessToken: envToken,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<HubSpotTokens>("hubspot");
}

export function saveTokens(tokens: HubSpotTokens): void {
  storeSecretJsonSync("hubspot", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("hubspot");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: HubSpotConnector | null = null;

function resetHubSpotConnector(): void {
  _instance = null;
}

export function getHubSpotConnector(): HubSpotConnector {
  if (!_instance) {
    _instance = new HubSpotConnector();
  }
  return _instance;
}

export { getHubSpotConnector as hubspot };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/hubspot/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/hubspot/connect  { accessToken }
 */
export async function handleHubSpotConnect(
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
    const res = await fetch(`${HUBSPOT_BASE}/account-info/v3/details`, {
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
          error: `Credentials rejected by HubSpot (HTTP ${res.status}) — check accessToken`,
        }),
      };
    }
    const details = (await res.json()) as {
      portalId?: number;
      uiDomain?: string;
      companyCurrency?: string;
    };

    const tokens: HubSpotTokens = {
      accessToken,
      hubId: details.portalId,
      portalName: details.uiDomain,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetHubSpotConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        hubId: tokens.hubId,
        portalName: tokens.portalName,
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
 * POST /connections/hubspot/test
 */
export async function handleHubSpotTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "HubSpot not connected" }),
    };
  }
  try {
    const connector = getHubSpotConnector();
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
 * DELETE /connections/hubspot
 */
export function handleHubSpotDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetHubSpotConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
