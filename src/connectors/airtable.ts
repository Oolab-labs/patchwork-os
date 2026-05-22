/**
 * Airtable connector — record access via the Airtable REST API v0.
 *
 * Auth: Personal Access Token (PAT) — `Authorization: Bearer <pat>`. PATs
 *   start with `pat...`.
 *   - Env var: AIRTABLE_ACCESS_TOKEN
 *   - Stored: getSecretJsonSync("airtable") → AirtableTokens
 *
 * Tools: listBases, getBaseSchema, listRecords, getRecord, createRecord,
 *   updateRecord. Write ops (create/update) are intentionally exposed — the
 *   point of the integration is round-trip record manipulation.
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

export interface AirtableTokens {
  accessToken: string; // pat...
  userId?: string;
  email?: string;
  connected_at: string;
}

export interface AirtableBase {
  id: string;
  name: string;
  permissionLevel?: string;
}

export interface AirtableField {
  id: string;
  name: string;
  type: string;
  description?: string;
  options?: Record<string, unknown>;
}

export interface AirtableTable {
  id: string;
  name: string;
  primaryFieldId?: string;
  description?: string;
  fields: AirtableField[];
}

export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface AirtableListBasesResult {
  bases: AirtableBase[];
  offset?: string;
}

export interface AirtableSchemaResult {
  tables: AirtableTable[];
}

export interface AirtableListRecordsResult {
  records: AirtableRecord[];
  offset?: string;
}

export interface AirtableListRecordsParams {
  filterByFormula?: string;
  sort?: Array<{ field: string; direction?: "asc" | "desc" }>;
  view?: string;
  fields?: string[];
  maxRecords?: number;
  pageSize?: number;
}

const BASE_URL = "https://api.airtable.com";
const MAX_RECORDS_HARD_CAP = 1000;

export class AirtableConnector extends BaseConnector {
  readonly providerName = "airtable";
  private tokens: AirtableTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Airtable not connected. Run: patchwork-os connect airtable or set AIRTABLE_ACCESS_TOKEN",
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
      const result = await this.apiCall(async () => {
        const res = await fetch(`${BASE_URL}/v0/meta/whoami`, {
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
          message: "Airtable authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect airtable",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Airtable permissions for this base/table",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Airtable resource not found",
          retryable: false,
        };
      if (s === 422)
        return {
          code: "provider_error",
          message: "Airtable validation error (invalid fields or formula)",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Airtable API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Airtable API error: HTTP ${s}`,
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
          message: `Cannot connect to Airtable: ${error.message}`,
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
      id: "airtable",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.email
        ? `Airtable (${tokens.email})`
        : tokens?.userId
          ? `Airtable user ${tokens.userId}`
          : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async listBases(): Promise<AirtableListBasesResult> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/v0/meta/bases`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<AirtableListBasesResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableListBasesResult;
  }

  async getBaseSchema(baseId: string): Promise<AirtableSchemaResult> {
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/v0/meta/bases/${encodeURIComponent(baseId)}/tables`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<AirtableSchemaResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableSchemaResult;
  }

  async listRecords(
    baseId: string,
    tableIdOrName: string,
    params: AirtableListRecordsParams = {},
  ): Promise<AirtableListRecordsResult> {
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      if (params.filterByFormula)
        qs.set("filterByFormula", params.filterByFormula);
      if (params.view) qs.set("view", params.view);
      if (params.pageSize) qs.set("pageSize", String(params.pageSize));

      // Cap maxRecords at Airtable's 1000 hard limit. Default 100.
      const maxRecords = Math.min(
        params.maxRecords ?? 100,
        MAX_RECORDS_HARD_CAP,
      );
      qs.set("maxRecords", String(maxRecords));

      if (params.sort) {
        params.sort.forEach((s, i) => {
          qs.set(`sort[${i}][field]`, s.field);
          if (s.direction) qs.set(`sort[${i}][direction]`, s.direction);
        });
      }
      if (params.fields) {
        for (const f of params.fields) qs.append("fields[]", f);
      }

      const url = `${BASE_URL}/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}?${qs}`;
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      return res.json() as Promise<AirtableListRecordsResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableListRecordsResult;
  }

  async getRecord(
    baseId: string,
    tableIdOrName: string,
    recordId: string,
  ): Promise<AirtableRecord> {
    const result = await this.apiCall(async () => {
      const url = `${BASE_URL}/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}/${encodeURIComponent(recordId)}`;
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      return res.json() as Promise<AirtableRecord>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableRecord;
  }

  async createRecord(
    baseId: string,
    tableIdOrName: string,
    fields: Record<string, unknown>,
  ): Promise<AirtableRecord> {
    const result = await this.apiCall(async () => {
      const url = `${BASE_URL}/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...this.buildHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: [{ fields }] }),
      });
      if (!res.ok) throw res;
      const json = (await res.json()) as { records: AirtableRecord[] };
      const first = json.records?.[0];
      if (!first) throw new Error("Airtable returned no record in response");
      return first;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableRecord;
  }

  async updateRecord(
    baseId: string,
    tableIdOrName: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<AirtableRecord> {
    const result = await this.apiCall(async () => {
      const url = `${BASE_URL}/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}/${encodeURIComponent(recordId)}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          ...this.buildHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<AirtableRecord>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as AirtableRecord;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const token = this.tokens?.accessToken ?? loadTokens()?.accessToken ?? "";
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): AirtableTokens | null {
  const envKey = process.env.AIRTABLE_ACCESS_TOKEN;
  if (envKey) {
    return {
      accessToken: envKey,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<AirtableTokens>("airtable");
}

export function saveTokens(tokens: AirtableTokens): void {
  storeSecretJsonSync("airtable", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("airtable");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: AirtableConnector | null = null;

function resetAirtableConnector(): void {
  _instance = null;
}

export function getAirtableConnector(): AirtableConnector {
  if (!_instance) {
    _instance = new AirtableConnector();
  }
  return _instance;
}

export { getAirtableConnector as airtable };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/airtable/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/airtable/connect  { accessToken }
 */
export async function handleAirtableConnect(
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
    const res = await fetch(`${BASE_URL}/v0/meta/whoami`, {
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
          error: `Credentials rejected by Airtable (HTTP ${res.status}) — check accessToken`,
        }),
      };
    }
    const who = (await res.json()) as { id?: string; email?: string };

    const userId = who.id ?? undefined;
    const email = who.email ?? undefined;

    const tokens: AirtableTokens = {
      accessToken,
      userId,
      email,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetAirtableConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        userId,
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
 * POST /connections/airtable/test
 */
export async function handleAirtableTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Airtable not connected" }),
    };
  }
  try {
    const connector = getAirtableConnector();
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
 * DELETE /connections/airtable
 */
export function handleAirtableDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetAirtableConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
