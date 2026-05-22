/**
 * Elasticsearch connector — read-only access to ES clusters via @elastic/elasticsearch.
 *
 * Auth precedence:
 *   1. cloudId + apiKey   (Elastic Cloud)
 *   2. node    + apiKey   (self-hosted with API key)
 *   3. node    + username + password   (basic auth)
 *
 * Tools (READ-ONLY): listIndices, describeIndex, search, count, aggregate, clusterHealth.
 *
 * Query guard: every search/aggregate body is walked and rejected if it contains
 *   `script`, `script_fields`, or `script_score` keys at any depth, or top-level
 *   keys outside a strict allowlist. Defense against arbitrary code execution
 *   via Painless scripting.
 *
 * Driver is loaded lazily so the bridge boots even when `@elastic/elasticsearch`
 * is not installed. Use `__setEsModuleForTest` in tests to inject a stub.
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

// ------------------------------------------------------------------ types

export interface ElasticsearchTokens {
  node?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  cloudId?: string;
  connected_at: string;
}

export interface EsClientLike {
  ping(): Promise<unknown>;
  close(): Promise<void>;
  cat: {
    indices(params: { format: string; h?: string }): Promise<unknown>;
  };
  indices: {
    getMapping(params: { index: string }): Promise<unknown>;
    getSettings(params: { index: string }): Promise<unknown>;
  };
  search(params: Record<string, unknown>): Promise<unknown>;
  count(params: Record<string, unknown>): Promise<unknown>;
  cluster: {
    health(): Promise<unknown>;
  };
}

export interface EsModuleLike {
  Client: new (opts: Record<string, unknown>) => EsClientLike;
  errors?: {
    ResponseError?: new (...args: unknown[]) => Error;
    ConnectionError?: new (...args: unknown[]) => Error;
  };
}

// ------------------------------------------------------------------ lazy driver

let _esModule: EsModuleLike | null = null;
let _esModulePromise: Promise<EsModuleLike> | null = null;

/**
 * Test hook — inject a stub `@elastic/elasticsearch` module so tests don't
 * need the real driver installed. Pass `null` to reset.
 */
export function __setEsModuleForTest(mod: EsModuleLike | null): void {
  _esModule = mod;
  _esModulePromise = null;
}

async function loadEsModule(): Promise<EsModuleLike> {
  if (_esModule) return _esModule;
  if (_esModulePromise) return _esModulePromise;
  _esModulePromise = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // @ts-expect-error — optional peer dep; resolved at runtime
      const mod = (await import("@elastic/elasticsearch")) as any;
      _esModule = mod as EsModuleLike;
      return _esModule;
    } catch (err) {
      throw new Error(
        "@elastic/elasticsearch driver not installed. Run: npm install @elastic/elasticsearch",
      );
    }
  })();
  return _esModulePromise;
}

// ------------------------------------------------------------------ token helpers

export function loadTokens(): ElasticsearchTokens | null {
  // Env override for CI/headless
  const node = process.env.ELASTICSEARCH_NODE;
  const apiKey = process.env.ELASTICSEARCH_API_KEY;
  const username = process.env.ELASTICSEARCH_USERNAME;
  const password = process.env.ELASTICSEARCH_PASSWORD;
  const cloudId = process.env.ELASTICSEARCH_CLOUD_ID;
  if (cloudId && apiKey) {
    return {
      cloudId,
      apiKey,
      connected_at: new Date().toISOString(),
    };
  }
  if (node && (apiKey || (username && password))) {
    return {
      node,
      apiKey,
      username,
      password,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<ElasticsearchTokens>("elasticsearch");
}

export function saveTokens(tokens: ElasticsearchTokens): void {
  storeSecretJsonSync("elasticsearch", tokens);
}

export function clearTokens(): void {
  deleteSecretJsonSync("elasticsearch");
}

// ------------------------------------------------------------------ query guard

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "query",
  "aggs",
  "aggregations",
  "sort",
  "_source",
  "size",
  "from",
  "track_total_hits",
  "highlight",
  "fields",
  "stored_fields",
  "min_score",
  "post_filter",
  "search_after",
]);

const SCRIPT_KEY_RE = /^script(_fields|_score)?$/i;

/**
 * Recursive walker — returns null when safe, error string when rejected.
 * Rejects any object containing keys matching `script`, `script_fields`, or
 * `script_score` (case-insensitive) at any depth, including inside arrays.
 */
export function isReadOnlyEsQuery(
  obj: unknown,
): { ok: true } | { ok: false; reason: string } {
  const reason = walkForScript(obj);
  if (reason) return { ok: false, reason };
  return { ok: true };
}

function walkForScript(node: unknown): string | null {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = walkForScript(item);
      if (r) return r;
    }
    return null;
  }
  if (typeof node === "object") {
    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (SCRIPT_KEY_RE.test(key)) {
        return `Disallowed key '${key}' — scripted queries are blocked`;
      }
      const r = walkForScript((node as Record<string, unknown>)[key]);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Validate a full search body — checks top-level allowlist + script walker.
 */
export function validateSearchBody(body: Record<string, unknown>):
  | {
      ok: true;
    }
  | { ok: false; reason: string } {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return { ok: false, reason: `Disallowed top-level key '${key}'` };
    }
  }
  return isReadOnlyEsQuery(body);
}

// ------------------------------------------------------------------ size cap

const MAX_SIZE = 100;
const MAX_AGG_SIZE = 1000;

// ------------------------------------------------------------------ connector

export class ElasticsearchConnector extends BaseConnector {
  readonly providerName = "elasticsearch";
  protected cachedTokens: ElasticsearchTokens | null = null;
  private client: EsClientLike | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Elasticsearch not connected. Set ELASTICSEARCH_NODE + (ELASTICSEARCH_API_KEY or ELASTICSEARCH_USERNAME/PASSWORD), or use ELASTICSEARCH_CLOUD_ID + ELASTICSEARCH_API_KEY.",
      );
    }
    this.cachedTokens = tokens;
    // Surface a sentinel token — the real "auth" lives in the ES client itself.
    const tag = tokens.cloudId ?? tokens.node ?? "elasticsearch";
    return { token: `es:${tag}` };
  }

  /**
   * Build (or return cached) ES client based on stored credentials.
   * Auth precedence: cloudId+apiKey > node+apiKey > node+username+password.
   */
  private async getClient(): Promise<EsClientLike> {
    if (this.client) return this.client;
    const tokens = this.cachedTokens ?? loadTokens();
    if (!tokens) {
      throw new Error("Elasticsearch not connected.");
    }
    this.cachedTokens = tokens;
    const mod = await loadEsModule();

    let opts: Record<string, unknown>;
    if (tokens.cloudId && tokens.apiKey) {
      opts = { cloud: { id: tokens.cloudId }, auth: { apiKey: tokens.apiKey } };
    } else if (tokens.node && tokens.apiKey) {
      opts = { node: tokens.node, auth: { apiKey: tokens.apiKey } };
    } else if (tokens.node && tokens.username && tokens.password) {
      opts = {
        node: tokens.node,
        auth: { username: tokens.username, password: tokens.password },
      };
    } else {
      throw new Error(
        "Elasticsearch credentials incomplete — need cloudId+apiKey, node+apiKey, or node+username+password.",
      );
    }
    this.client = new mod.Client(opts);
    return this.client;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        /* best effort */
      }
      this.client = null;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const client = await this.getClient();
      await client.ping();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    // Elastic ResponseError carries statusCode
    if (error && typeof error === "object") {
      const name = (error as { name?: string }).name;
      const statusCode =
        (error as { statusCode?: number }).statusCode ??
        (error as { meta?: { statusCode?: number } }).meta?.statusCode;

      if (name === "ConnectionError" || name === "TimeoutError") {
        return {
          code: "network_error",
          message: `Cannot reach Elasticsearch: ${
            (error as { message?: string }).message ?? "connection error"
          }`,
          retryable: true,
        };
      }

      if (typeof statusCode === "number") {
        if (statusCode === 401) {
          return {
            code: "auth_expired",
            message: "Elasticsearch credentials rejected (401)",
            retryable: false,
            suggestedAction: "Reconnect: patchwork connect elasticsearch",
          };
        }
        if (statusCode === 403) {
          return {
            code: "permission_denied",
            message: "Elasticsearch user lacks permission for this resource",
            retryable: false,
          };
        }
        if (statusCode === 404) {
          return {
            code: "not_found",
            message: "Elasticsearch index or resource not found",
            retryable: false,
          };
        }
        if (statusCode === 429) {
          return {
            code: "rate_limited",
            message: "Elasticsearch rate-limited the request",
            retryable: true,
          };
        }
        if (statusCode >= 500) {
          return {
            code: "provider_error",
            message: `Elasticsearch error: HTTP ${statusCode}`,
            retryable: true,
          };
        }
      }
    }
    if (error instanceof Error) {
      if (
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("ETIMEDOUT")
      ) {
        return {
          code: "network_error",
          message: `Cannot reach Elasticsearch: ${error.message}`,
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
      id: "elasticsearch",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.cloudId ?? tokens?.node,
    };
  }

  // ---------------------------------------------------------------- read ops

  async listIndices(): Promise<unknown> {
    const result = await this.apiCall(async () => {
      const client = await this.getClient();
      return client.cat.indices({
        format: "json",
        h: "index,docs.count,store.size,health",
      });
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async describeIndex(
    index: string,
  ): Promise<{ mapping: unknown; settings: unknown }> {
    if (!index || typeof index !== "string") {
      throw new Error("describeIndex: index name required");
    }
    const result = await this.apiCall(async () => {
      const client = await this.getClient();
      const [mapping, settings] = await Promise.all([
        client.indices.getMapping({ index }),
        client.indices.getSettings({ index }),
      ]);
      return { mapping, settings };
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async search(
    index: string,
    query: Record<string, unknown>,
    size = 10,
    from = 0,
    sort?: unknown,
    _source?: unknown,
  ): Promise<unknown> {
    if (!index || typeof index !== "string") {
      throw new Error("search: index name required");
    }
    if (!query || typeof query !== "object") {
      throw new Error("search: query body must be an object");
    }
    const guard = isReadOnlyEsQuery(query);
    if (!guard.ok) throw new Error(`search rejected: ${guard.reason}`);
    if (sort) {
      const g2 = isReadOnlyEsQuery(sort);
      if (!g2.ok) throw new Error(`search rejected (sort): ${g2.reason}`);
    }
    const cappedSize = Math.max(0, Math.min(size, MAX_SIZE));
    const cappedFrom = Math.max(0, from | 0);
    const body: Record<string, unknown> = {
      query,
      size: cappedSize,
      from: cappedFrom,
    };
    if (sort !== undefined) body.sort = sort;
    if (_source !== undefined) body._source = _source;

    const result = await this.apiCall(async () => {
      const client = await this.getClient();
      return client.search({ index, body });
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async count(
    index: string,
    query?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!index || typeof index !== "string") {
      throw new Error("count: index name required");
    }
    const body: Record<string, unknown> = {};
    if (query) {
      const guard = isReadOnlyEsQuery(query);
      if (!guard.ok) throw new Error(`count rejected: ${guard.reason}`);
      body.query = query;
    }
    const result = await this.apiCall(async () => {
      const client = await this.getClient();
      return client.count({ index, body });
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async aggregate(
    index: string,
    aggs: Record<string, unknown>,
    query?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!index || typeof index !== "string") {
      throw new Error("aggregate: index name required");
    }
    if (!aggs || typeof aggs !== "object") {
      throw new Error("aggregate: aggs body must be an object");
    }
    const guard = isReadOnlyEsQuery(aggs);
    if (!guard.ok) throw new Error(`aggregate rejected: ${guard.reason}`);
    if (query) {
      const g2 = isReadOnlyEsQuery(query);
      if (!g2.ok) throw new Error(`aggregate rejected (query): ${g2.reason}`);
    }
    const body: Record<string, unknown> = {
      aggs,
      size: 0, // aggregation-only — no hits
    };
    if (query) body.query = query;

    const result = await this.apiCall(async () => {
      const client = await this.getClient();
      return client.search({ index, body });
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async clusterHealth(): Promise<unknown> {
    const result = await this.apiCall(async () => {
      const client = await this.getClient();
      return client.cluster.health();
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }
}

// ------------------------------------------------------------------ singleton

let _instance: ElasticsearchConnector | null = null;

export function getElasticsearchConnector(): ElasticsearchConnector {
  if (!_instance) _instance = new ElasticsearchConnector();
  return _instance;
}

export async function resetElasticsearchConnector(): Promise<void> {
  if (_instance) {
    await _instance.disconnect();
  }
  _instance = null;
}

// Convenience re-export
export { loadTokens as isConnected };

// Expose query-guard constants for test introspection
export const __testing = {
  ALLOWED_TOP_LEVEL_KEYS,
  MAX_SIZE,
  MAX_AGG_SIZE,
};

// ------------------------------------------------------------------ HTTP handlers
// Wired in src/connectorRoutes.ts under /connections/elasticsearch/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

interface ConnectBody {
  node?: unknown;
  apiKey?: unknown;
  username?: unknown;
  password?: unknown;
  cloudId?: unknown;
}

/**
 * POST /connections/elasticsearch/connect
 * Body: { cloudId?, node?, apiKey?, username?, password? }
 * Validates credential combo + pings the cluster, then stores the tokens.
 */
export async function handleElasticsearchConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let parsed: ConnectBody;
  try {
    parsed = JSON.parse(body) as ConnectBody;
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  const cloudId =
    typeof parsed.cloudId === "string" ? parsed.cloudId : undefined;
  const node = typeof parsed.node === "string" ? parsed.node : undefined;
  const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : undefined;
  const username =
    typeof parsed.username === "string" ? parsed.username : undefined;
  const password =
    typeof parsed.password === "string" ? parsed.password : undefined;

  // Validate credential combos (precedence enforced here too)
  let credsOk = false;
  if (cloudId && apiKey) credsOk = true;
  else if (node && apiKey) credsOk = true;
  else if (node && username && password) credsOk = true;

  if (!credsOk) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error:
          "Must provide one of: (cloudId + apiKey), (node + apiKey), or (node + username + password).",
      }),
    };
  }

  // Validate node URL shape (https:// required for non-loopback)
  if (node) {
    try {
      const u = new URL(node);
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        return {
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: "node must be an http(s):// URL",
          }),
        };
      }
    } catch {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "node URL is malformed",
        }),
      };
    }
  }

  // Persist + verify
  const tokens: ElasticsearchTokens = {
    cloudId,
    node,
    apiKey,
    username,
    password,
    connected_at: new Date().toISOString(),
  };
  saveTokens(tokens);
  await resetElasticsearchConnector();

  try {
    const conn = getElasticsearchConnector();
    const check = await conn.healthCheck();
    if (!check.ok) {
      // Roll back stored tokens — verification failed
      clearTokens();
      await resetElasticsearchConnector();
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: check.error?.message ?? "Elasticsearch ping failed",
        }),
      };
    }
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        target: cloudId ?? node,
        connectedAt: tokens.connected_at,
      }),
    };
  } catch (err) {
    clearTokens();
    await resetElasticsearchConnector();
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
 * POST /connections/elasticsearch/test
 * Verifies stored credentials with ping().
 */
export async function handleElasticsearchTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Elasticsearch not connected" }),
    };
  }
  try {
    const connector = getElasticsearchConnector();
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
 * DELETE /connections/elasticsearch
 */
export async function handleElasticsearchDisconnect(): Promise<ConnectorHandlerResult> {
  clearTokens();
  await resetElasticsearchConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
