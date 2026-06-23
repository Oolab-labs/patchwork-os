/**
 * Supabase connector — PostgreSQL-as-a-service via PostgREST REST, Storage,
 * Edge Functions, and RPC APIs.
 *
 * Auth: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars; stored as
 *   getSecretJsonSync("supabase") → SupabaseTokens
 *
 * Tools: select, insert, update, upsert, delete, rpc, getSchema,
 *        uploadFile, downloadFile, listFiles, deleteFiles, invokeEdgeFunction
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 */

import crypto from "node:crypto";
import { isPrivateHost } from "../ssrfGuard.js";
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

// ------------------------------------------------------------------ types

export interface SupabaseTokens {
  url: string;
  serviceRoleKey: string;
  anonKey?: string;
  connected_at: string;
}

export interface SupabaseQueryResult<T = Record<string, unknown>> {
  data: T[];
  count?: number;
}

export interface SupabaseStorageObject {
  name: string;
  bucket_id: string;
  owner: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  metadata: Record<string, unknown> | null;
}

export interface SupabaseRpcResult<T = unknown> {
  data: T;
}

// Supabase REST error shape
interface SupabaseApiError {
  code?: string;
  details?: string | null;
  hint?: string | null;
  message?: string;
}

// ------------------------------------------------------------------ token helpers

export function loadTokens(): SupabaseTokens | null {
  const envUrl = process.env.SUPABASE_URL;
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (envUrl && envKey) {
    return {
      url: envUrl,
      serviceRoleKey: envKey,
      anonKey: process.env.SUPABASE_ANON_KEY,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<SupabaseTokens>("supabase");
}

export function saveTokens(tokens: SupabaseTokens): void {
  storeSecretJsonSync("supabase", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("supabase");
  } catch {
    // already gone
  }
}

// ------------------------------------------------------------------ webhook verification

/**
 * Verify a Supabase database webhook signature.
 * Supabase sends HMAC-SHA256 of the raw body in `x-supabase-webhook-secret`.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifySupabaseWebhook(
  rawBody: string | Buffer,
  signatureHeader: string,
  webhookSecret: string,
): boolean {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(body)
    .digest("hex");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) {
    // Still do a comparison to avoid length-based timing leak
    crypto.timingSafeEqual(
      Buffer.alloc(expectedBuf.length),
      Buffer.alloc(expectedBuf.length),
    );
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// ------------------------------------------------------------------ connector

export class SupabaseConnector extends BaseConnector {
  readonly providerName = "supabase";
  private tokens: SupabaseTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Supabase not connected. Run: patchwork connect supabase or set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
      );
    }
    this.tokens = tokens;
    return { token: tokens.serviceRoleKey };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const tokens = this.tokens ?? loadTokens();
      if (!tokens) {
        return {
          ok: false,
          error: {
            code: "auth_expired",
            message: "Supabase not connected",
            retryable: false,
          },
        };
      }
      this.tokens = tokens;
      const result = await this.apiCall(async () => {
        const res = await fetch(`${tokens.url}/rest/v1/`, {
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
    // Supabase REST error object: { code, details, hint, message }
    if (error && typeof error === "object" && "message" in error) {
      const e = error as SupabaseApiError & { status?: number };
      const code = typeof e.code === "string" ? e.code : "";
      const status = typeof e.status === "number" ? e.status : 0;

      if (code === "PGRST301" || status === 401) {
        return {
          code: "auth_expired",
          message: `Supabase auth expired or invalid: ${e.message ?? ""}`,
          retryable: false,
          suggestedAction: "Reconnect: patchwork connect supabase",
        };
      }
      if (status === 429) {
        return {
          code: "rate_limited",
          message: `Supabase rate limit exceeded: ${e.message ?? ""}`,
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      }
      if (status === 404) {
        return {
          code: "not_found",
          message: `Supabase resource not found: ${e.message ?? ""}`,
          retryable: false,
        };
      }
      if (status === 400) {
        return {
          code: "validation_error",
          message: `Supabase validation error: ${e.message ?? ""}`,
          providerDetail: { details: e.details, hint: e.hint },
          retryable: false,
        };
      }
    }
    if (error instanceof Response) {
      const s = error.status;
      if (s === 401)
        return {
          code: "auth_expired",
          message: "Supabase auth expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork connect supabase",
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Supabase rate limit exceeded",
          retryable: true,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Supabase resource not found",
          retryable: false,
        };
      if (s === 400)
        return {
          code: "validation_error",
          message: `Supabase bad request: HTTP ${s}`,
          retryable: false,
        };
      return {
        code: "provider_error",
        message: `Supabase API error: HTTP ${s}`,
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
          message: `Cannot connect to Supabase: ${error.message}`,
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
      id: "supabase",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.url ? `Supabase: ${tokens.url}` : undefined,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private getTokens(): SupabaseTokens {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) throw new Error("Supabase not connected");
    this.tokens = tokens;
    return tokens;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const key = this.tokens?.serviceRoleKey ?? "";
    return {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async throwOnError(res: Response): Promise<void> {
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as SupabaseApiError;
      throw Object.assign(new Error(body.message ?? `HTTP ${res.status}`), {
        status: res.status,
        code: body.code,
        details: body.details,
        hint: body.hint,
      });
    }
  }

  // ── REST / PostgREST operations ────────────────────────────────────────────

  async select<T = Record<string, unknown>>(
    table: string,
    columns?: string,
    filters?: string,
    limit?: number,
    offset?: number,
    orderBy?: string,
  ): Promise<SupabaseQueryResult<T>> {
    const tokens = this.getTokens();
    const qs = new URLSearchParams();
    qs.set("select", columns ?? "*");
    if (filters) {
      for (const part of filters.split("&")) {
        const eq = part.indexOf("=");
        if (eq !== -1) {
          qs.set(part.slice(0, eq), part.slice(eq + 1));
        }
      }
    }
    if (limit !== undefined) qs.set("limit", String(limit));
    if (offset !== undefined) qs.set("offset", String(offset));
    if (orderBy) qs.set("order", orderBy);

    const result = await this.apiCall(async () => {
      const res = await fetch(`${tokens.url}/rest/v1/${table}?${qs}`, {
        headers: this.buildHeaders({ Prefer: "count=exact" }),
      });
      await this.throwOnError(res);
      const data = (await res.json()) as T[];
      const countHeader = res.headers.get("content-range");
      let count: number | undefined;
      if (countHeader) {
        const m = /\/(\d+)$/.exec(countHeader);
        if (m) count = parseInt(m[1] ?? "0", 10);
      }
      return { data, count } as SupabaseQueryResult<T>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async insert<T = Record<string, unknown>>(
    table: string,
    data: Record<string, unknown> | Record<string, unknown>[],
    returning = true,
  ): Promise<SupabaseQueryResult<T>> {
    const tokens = this.getTokens();
    const result = await this.apiCall(async () => {
      const res = await fetch(`${tokens.url}/rest/v1/${table}`, {
        method: "POST",
        headers: this.buildHeaders({
          Prefer: returning ? "return=representation" : "return=minimal",
        }),
        body: JSON.stringify(data),
      });
      await this.throwOnError(res);
      if (!returning) return { data: [] as T[] };
      const rows = (await res.json()) as T[];
      return {
        data: Array.isArray(rows) ? rows : [rows],
      } as SupabaseQueryResult<T>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async update<T = Record<string, unknown>>(
    table: string,
    data: Record<string, unknown>,
    filters: string,
  ): Promise<SupabaseQueryResult<T>> {
    const tokens = this.getTokens();
    const qs = new URLSearchParams();
    for (const part of filters.split("&")) {
      const eq = part.indexOf("=");
      if (eq !== -1) {
        qs.set(part.slice(0, eq), part.slice(eq + 1));
      }
    }
    const result = await this.apiCall(async () => {
      const res = await fetch(`${tokens.url}/rest/v1/${table}?${qs}`, {
        method: "PATCH",
        headers: this.buildHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify(data),
      });
      await this.throwOnError(res);
      const rows = (await res.json()) as T[];
      return {
        data: Array.isArray(rows) ? rows : [rows],
      } as SupabaseQueryResult<T>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async upsert<T = Record<string, unknown>>(
    table: string,
    data: Record<string, unknown> | Record<string, unknown>[],
    onConflict?: string,
  ): Promise<SupabaseQueryResult<T>> {
    const tokens = this.getTokens();
    const prefer = "resolution=merge-duplicates,return=representation";
    const qs = new URLSearchParams();
    if (onConflict) qs.set("on_conflict", onConflict);

    const result = await this.apiCall(async () => {
      const url = `${tokens.url}/rest/v1/${table}${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders({ Prefer: prefer }),
        body: JSON.stringify(data),
      });
      await this.throwOnError(res);
      const rows = (await res.json()) as T[];
      return {
        data: Array.isArray(rows) ? rows : [rows],
      } as SupabaseQueryResult<T>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async delete<T = Record<string, unknown>>(
    table: string,
    filters: string,
  ): Promise<SupabaseQueryResult<T>> {
    const tokens = this.getTokens();
    const qs = new URLSearchParams();
    for (const part of filters.split("&")) {
      const eq = part.indexOf("=");
      if (eq !== -1) {
        qs.set(part.slice(0, eq), part.slice(eq + 1));
      }
    }
    const result = await this.apiCall(async () => {
      const res = await fetch(`${tokens.url}/rest/v1/${table}?${qs}`, {
        method: "DELETE",
        headers: this.buildHeaders({ Prefer: "return=representation" }),
      });
      await this.throwOnError(res);
      const rows = (await res.json()) as T[];
      return {
        data: Array.isArray(rows) ? rows : [rows],
      } as SupabaseQueryResult<T>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async rpc<T = unknown>(
    functionName: string,
    params?: Record<string, unknown>,
  ): Promise<SupabaseRpcResult<T>> {
    const tokens = this.getTokens();
    const result = await this.apiCall(async () => {
      const res = await fetch(`${tokens.url}/rest/v1/rpc/${functionName}`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(params ?? {}),
      });
      await this.throwOnError(res);
      const data = (await res.json()) as T;
      return { data } as SupabaseRpcResult<T>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async getSchema(): Promise<Record<string, unknown>> {
    const tokens = this.getTokens();
    const result = await this.apiCall(async () => {
      const res = await fetch(`${tokens.url}/rest/v1/`, {
        headers: this.buildHeaders(),
      });
      await this.throwOnError(res);
      return res.json() as Promise<Record<string, unknown>>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  // ── Storage operations ────────────────────────────────────────────────────

  async uploadFile(
    bucket: string,
    path: string,
    file: Buffer | string,
    contentType = "application/octet-stream",
  ): Promise<Record<string, unknown>> {
    const tokens = this.getTokens();
    const body = typeof file === "string" ? Buffer.from(file) : file;
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${tokens.url}/storage/v1/object/${bucket}/${path}`,
        {
          method: "POST",
          headers: {
            apikey: tokens.serviceRoleKey,
            Authorization: `Bearer ${tokens.serviceRoleKey}`,
            "Content-Type": contentType,
          },
          body: body as unknown as BodyInit,
        },
      );
      await this.throwOnError(res);
      return res.json() as Promise<Record<string, unknown>>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async downloadFile(bucket: string, path: string): Promise<Buffer> {
    const tokens = this.getTokens();
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${tokens.url}/storage/v1/object/${bucket}/${path}`,
        {
          headers: {
            apikey: tokens.serviceRoleKey,
            Authorization: `Bearer ${tokens.serviceRoleKey}`,
          },
        },
      );
      await this.throwOnError(res);
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async listFiles(
    bucket: string,
    prefix?: string,
    limit?: number,
  ): Promise<SupabaseStorageObject[]> {
    const tokens = this.getTokens();
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${tokens.url}/storage/v1/object/list/${bucket}`,
        {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify({
            prefix: prefix ?? "",
            limit: limit ?? 100,
            offset: 0,
          }),
        },
      );
      await this.throwOnError(res);
      return res.json() as Promise<SupabaseStorageObject[]>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async deleteFiles(
    bucket: string,
    paths: string[],
  ): Promise<Record<string, unknown>[]> {
    const tokens = this.getTokens();
    const result = await this.apiCall(async () => {
      const res = await fetch(`${tokens.url}/storage/v1/object/${bucket}`, {
        method: "DELETE",
        headers: this.buildHeaders(),
        body: JSON.stringify({ prefixes: paths }),
      });
      await this.throwOnError(res);
      return res.json() as Promise<Record<string, unknown>[]>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  // ── Edge Functions ────────────────────────────────────────────────────────

  async invokeEdgeFunction<T = unknown>(
    functionName: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const tokens = this.getTokens();
    const result = await this.apiCall(async () => {
      const res = await fetch(`${tokens.url}/functions/v1/${functionName}`, {
        method: "POST",
        headers: {
          apikey: tokens.serviceRoleKey,
          Authorization: `Bearer ${tokens.serviceRoleKey}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      await this.throwOnError(res);
      return res.json() as Promise<T>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: SupabaseConnector | null = null;

export function resetSupabaseConnector(): void {
  _instance = null;
}

export function getSupabaseConnector(): SupabaseConnector {
  if (!_instance) _instance = new SupabaseConnector();
  return _instance;
}

export { getSupabaseConnector as supabase };

// ── HTTP Handlers ─────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/supabase/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/supabase/connect  { url, serviceRoleKey, anonKey? }
 * Validates credentials by calling GET {url}/rest/v1/ (OpenAPI endpoint).
 */
export async function handleSupabaseConnect(
  rawBody: string,
): Promise<ConnectorHandlerResult> {
  let url: string;
  let serviceRoleKey: string;
  let anonKey: string | undefined;

  try {
    const parsed = JSON.parse(rawBody) as {
      url?: unknown;
      serviceRoleKey?: unknown;
      anonKey?: unknown;
    };
    if (typeof parsed.url !== "string" || !parsed.url) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "url is required (e.g. https://xyzabc.supabase.co)",
        }),
      };
    }
    if (typeof parsed.serviceRoleKey !== "string" || !parsed.serviceRoleKey) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "serviceRoleKey is required",
        }),
      };
    }
    url = parsed.url.replace(/\/$/, ""); // strip trailing slash
    serviceRoleKey = parsed.serviceRoleKey;
    if (typeof parsed.anonKey === "string" && parsed.anonKey) {
      anonKey = parsed.anonKey;
    }
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  // SSRF guard (audit 2026-06-22 #7): `url` is user-supplied and was accepted
  // verbatim — a caller could point it at cloud IMDS or an internal service and
  // have us send the service-role key there as a Bearer token. Require a
  // parseable https URL with a non-private host, mirroring the DB + Grafana
  // connectors.
  let parsedSupabaseUrl: URL;
  try {
    parsedSupabaseUrl = new URL(url);
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "url is not a valid URL" }),
    };
  }
  if (parsedSupabaseUrl.protocol !== "https:") {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "url must use https://" }),
    };
  }
  if (isPrivateHost(parsedSupabaseUrl.hostname)) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error:
          "url must not point at a private, loopback, or link-local address",
      }),
    };
  }

  try {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Supabase (HTTP ${res.status}) — check your URL and serviceRoleKey`,
        }),
      };
    }

    const tokens: SupabaseTokens = {
      url,
      serviceRoleKey,
      anonKey,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetSupabaseConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        url,
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
 * POST /connections/supabase/test
 */
export async function handleSupabaseTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Supabase not connected" }),
    };
  }
  try {
    const connector = getSupabaseConnector();
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
 * DELETE /connections/supabase
 */
export function handleSupabaseDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetSupabaseConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
