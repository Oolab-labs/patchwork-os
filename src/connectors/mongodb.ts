/**
 * MongoDB connector — direct-connection-string database connector.
 *
 * Stores a MongoDB connection URI ("mongodb://" or "mongodb+srv://") in
 * secure token storage and exposes a small read-only query surface:
 * listDatabases, listCollections, describeCollection, find, aggregate,
 * count.
 *
 * The `mongodb` driver is loaded lazily via dynamic import so callers
 * without the package installed see a friendly message instead of a
 * module-resolution crash at startup. Tests inject a fake module via
 * `__setMongoModuleForTest`.
 *
 * HTTP routes (wired centrally in src/connectorRoutes.ts):
 *   POST   /connections/mongodb/connect    — body: { connectionString, database? }
 *   POST   /connections/mongodb/test       — ping admin
 *   DELETE /connections/mongodb            — disconnect + delete token
 */

import { isPrivateHost } from "../ssrfGuard.js";
import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
  type OAuthConfig,
} from "./baseConnector.js";
import { escHtml } from "./htmlEscape.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

// ── Persisted token shape ────────────────────────────────────────────────────

export interface MongoTokens {
  connectionString: string;
  database?: string;
  connected_at: string;
}

// ── Lazy driver loader ───────────────────────────────────────────────────────

/**
 * Minimal subset of the `mongodb` driver API we depend on. Declared
 * structurally so tests can supply a hand-rolled fake without pulling the
 * real package into the test runtime.
 */
export interface MongoDriverLike {
  MongoClient: new (uri: string, options?: unknown) => MongoClientLike;
  // Real driver exposes MongoNetworkError; we only need the constructor for
  // instanceof checks in normalizeError. Optional for fakes.
  MongoNetworkError?: new (
    ...args: unknown[]
  ) => Error;
}

export interface MongoClientLike {
  connect(): Promise<unknown>;
  close(): Promise<unknown>;
  db(name?: string): MongoDbLike;
}

export interface MongoDbLike {
  admin(): MongoAdminLike;
  command(cmd: Record<string, unknown>): Promise<unknown>;
  listCollections(
    filter?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): { toArray(): Promise<Array<{ name: string }>> };
  collection(name: string): MongoCollectionLike;
}

export interface MongoAdminLike {
  listDatabases(): Promise<{ databases: Array<{ name: string }> }>;
  command(cmd: Record<string, unknown>): Promise<unknown>;
}

export interface MongoCollectionLike {
  indexes(): Promise<unknown[]>;
  findOne(filter?: Record<string, unknown>): Promise<unknown>;
  find(
    filter?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): { toArray(): Promise<unknown[]> };
  aggregate(
    pipeline: Array<Record<string, unknown>>,
    options?: Record<string, unknown>,
  ): { toArray(): Promise<unknown[]> };
  estimatedDocumentCount(): Promise<number>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
}

let _injectedModule: MongoDriverLike | null = null;
let _modulePromise: Promise<MongoDriverLike> | null = null;

/** Inject a fake `mongodb` module for hermetic tests. */
export function __setMongoModuleForTest(mod: MongoDriverLike | null): void {
  _injectedModule = mod;
  _modulePromise = null;
  // Reset the singleton client so a re-injected fake takes effect.
  if (_client) {
    void _client.close().catch(() => undefined);
    _client = null;
  }
}

async function loadMongoModule(): Promise<MongoDriverLike> {
  if (_injectedModule) return _injectedModule;
  if (_modulePromise) return _modulePromise;
  _modulePromise = (async () => {
    try {
      // @ts-expect-error optional peer dep; resolved at runtime
      const mod = (await import("mongodb")) as unknown as MongoDriverLike;
      return mod;
    } catch {
      throw new Error("MongoDB driver not installed. Run: npm install mongodb");
    }
  })();
  return _modulePromise;
}

// ── Singleton client ─────────────────────────────────────────────────────────

let _client: MongoClientLike | null = null;
let _clientUri: string | null = null;

async function getClient(uri: string): Promise<MongoClientLike> {
  if (_client && _clientUri === uri) return _client;
  if (_client && _clientUri !== uri) {
    try {
      await _client.close();
    } catch {
      // Best-effort close
    }
    _client = null;
  }
  const mod = await loadMongoModule();
  const client = new mod.MongoClient(uri);
  await client.connect();
  _client = client;
  _clientUri = uri;
  return client;
}

async function disconnectClient(): Promise<void> {
  if (!_client) return;
  try {
    await _client.close();
  } catch {
    // Best-effort
  }
  _client = null;
  _clientUri = null;
}

// ── Token persistence ────────────────────────────────────────────────────────

const PROVIDER = "mongodb";

export function loadTokens(): MongoTokens | null {
  const envUri = process.env.MONGODB_URI;
  if (envUri) {
    return {
      connectionString: envUri,
      database: process.env.MONGODB_DATABASE,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<MongoTokens>(PROVIDER);
}

export function saveTokens(tokens: MongoTokens): void {
  storeSecretJsonSync(PROVIDER, tokens);
}

export function clearTokens(): void {
  deleteSecretJsonSync(PROVIDER);
}

// ── Connection string validation ─────────────────────────────────────────────

function validateConnectionString(uri: unknown): string {
  if (typeof uri !== "string" || uri.length === 0) {
    throw new Error("connectionString must be a non-empty string");
  }
  if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
    throw new Error(
      "connectionString must start with mongodb:// or mongodb+srv://",
    );
  }
  // Catch obvious tampering up front (control chars, newlines).
  if (/[\x00-\x1f]/.test(uri)) {
    throw new Error("connectionString contains control characters");
  }
  return uri;
}

// ── Read-only operation guard ────────────────────────────────────────────────

const FORBIDDEN_KEY_RE = /^\$(where|function|accumulator|out|merge)$/i;

/**
 * Walk a filter/projection/pipeline value and reject any object key that
 * matches dangerous Mongo operators at any depth:
 *
 *   $where       — server-side JS evaluation
 *   $function    — server-side JS in aggregation
 *   $accumulator — server-side JS accumulator
 *   $out         — pipeline stage that writes a collection
 *   $merge       — pipeline stage that writes/upserts into a collection
 *
 * Returns true when the input is safe; throws otherwise so callers don't
 * have to remember to check a boolean.
 */
export function isReadOnlyMongoOp(value: unknown): true {
  walk(value, 0);
  return true;
}

function walk(value: unknown, depth: number): void {
  if (depth > 64) {
    throw new Error("MongoDB filter/pipeline nested too deeply");
  }
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_RE.test(key)) {
      throw new Error(`MongoDB operator not allowed (read-only guard): ${key}`);
    }
    walk((value as Record<string, unknown>)[key], depth + 1);
  }
}

// ── Connector class ──────────────────────────────────────────────────────────

export class MongoConnector extends BaseConnector {
  readonly providerName = "mongodb";

  protected getOAuthConfig(): OAuthConfig | null {
    return null; // Direct connection string, no OAuth.
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "MongoDB not connected. POST /connections/mongodb/connect first.",
      );
    }
    return { token: tokens.connectionString };
  }

  getStatus(): ConnectorStatus {
    const tokens = loadTokens();
    return {
      id: PROVIDER,
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.database,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    const tokens = loadTokens();
    if (!tokens) {
      return {
        ok: false,
        error: {
          code: "auth_expired",
          message: "MongoDB not connected",
          retryable: false,
        },
      };
    }
    try {
      const client = await getClient(tokens.connectionString);
      await client.db("admin").command({ ping: 1 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    const message = error instanceof Error ? error.message : String(error);
    const codeRaw = (error as { code?: unknown })?.code;
    const code = typeof codeRaw === "number" ? codeRaw : undefined;
    const name = (error as { name?: unknown })?.name;

    // Network errors — check name first since some have no numeric code.
    if (
      name === "MongoNetworkError" ||
      name === "MongoServerSelectionError" ||
      name === "MongoNetworkTimeoutError" ||
      /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(message)
    ) {
      return {
        code: "network_error",
        message,
        providerDetail: error,
        retryable: true,
      };
    }

    switch (code) {
      case 18: // AuthenticationFailed
        return {
          code: "auth_expired",
          message,
          providerDetail: error,
          retryable: false,
          suggestedAction:
            "Re-connect MongoDB via POST /connections/mongodb/connect",
        };
      case 13: // Unauthorized
        return {
          code: "permission_denied",
          message,
          providerDetail: error,
          retryable: false,
        };
      case 11: // UserNotFound
      case 26: // NamespaceNotFound
        return {
          code: "not_found",
          message,
          providerDetail: error,
          retryable: false,
        };
      default:
        return {
          code: "provider_error",
          message,
          providerDetail: error,
          retryable: false,
        };
    }
  }

  async disconnect(): Promise<void> {
    await disconnectClient();
    clearTokens();
    this.auth = null;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _connector: MongoConnector | null = null;
export function mongoConnector(): MongoConnector {
  if (!_connector) _connector = new MongoConnector();
  return _connector;
}

// ── Read-only tool surface ───────────────────────────────────────────────────

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function clampLimit(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(n), MAX_LIMIT);
}

async function activeDb(name: string): Promise<MongoDbLike> {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error(
      "MongoDB not connected. POST /connections/mongodb/connect first.",
    );
  }
  const client = await getClient(tokens.connectionString);
  return client.db(name);
}

export async function listDatabases(): Promise<string[]> {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error("MongoDB not connected");
  }
  const client = await getClient(tokens.connectionString);
  const res = await client.db().admin().listDatabases();
  return (res.databases ?? []).map((d) => d.name);
}

export async function listCollections(database: string): Promise<string[]> {
  if (!database) throw new Error("database is required");
  const db = await activeDb(database);
  const rows = await db.listCollections({}, { nameOnly: true }).toArray();
  return rows.map((r) => r.name);
}

export async function describeCollection(
  database: string,
  collection: string,
): Promise<{ sample: unknown; indexes: unknown[] }> {
  if (!database) throw new Error("database is required");
  if (!collection) throw new Error("collection is required");
  const db = await activeDb(database);
  const col = db.collection(collection);
  const [sample, indexes] = await Promise.all([col.findOne({}), col.indexes()]);
  return { sample, indexes };
}

export interface FindOptions {
  projection?: Record<string, unknown>;
  limit?: number;
}

export async function find(
  database: string,
  collection: string,
  filter: Record<string, unknown> = {},
  options: FindOptions = {},
): Promise<unknown[]> {
  if (!database) throw new Error("database is required");
  if (!collection) throw new Error("collection is required");
  isReadOnlyMongoOp(filter);
  if (options.projection) isReadOnlyMongoOp(options.projection);
  const db = await activeDb(database);
  const cursor = db.collection(collection).find(filter, {
    projection: options.projection,
    limit: clampLimit(options.limit),
  });
  return cursor.toArray();
}

const FORBIDDEN_STAGE_RE = /^\$(out|merge|function|where|accumulator)$/i;

function rejectForbiddenStages(pipeline: Array<Record<string, unknown>>): void {
  for (const stage of pipeline) {
    if (!stage || typeof stage !== "object") continue;
    for (const key of Object.keys(stage)) {
      if (FORBIDDEN_STAGE_RE.test(key)) {
        throw new Error(
          `MongoDB aggregation stage not allowed (read-only guard): ${key}`,
        );
      }
    }
  }
}

export async function aggregate(
  database: string,
  collection: string,
  pipeline: Array<Record<string, unknown>>,
  limit = DEFAULT_LIMIT,
): Promise<unknown[]> {
  if (!database) throw new Error("database is required");
  if (!collection) throw new Error("collection is required");
  if (!Array.isArray(pipeline)) throw new Error("pipeline must be an array");
  rejectForbiddenStages(pipeline);
  isReadOnlyMongoOp(pipeline);
  const cappedLimit = clampLimit(limit);
  const capped = [...pipeline, { $limit: cappedLimit }];
  const db = await activeDb(database);
  return db.collection(collection).aggregate(capped).toArray();
}

export async function count(
  database: string,
  collection: string,
  filter?: Record<string, unknown>,
): Promise<number> {
  if (!database) throw new Error("database is required");
  if (!collection) throw new Error("collection is required");
  const db = await activeDb(database);
  const col = db.collection(collection);
  if (!filter || Object.keys(filter).length === 0) {
    return col.estimatedDocumentCount();
  }
  isReadOnlyMongoOp(filter);
  return col.countDocuments(filter);
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
  redirect?: string;
}

function jsonResult(status: number, payload: unknown): ConnectorHandlerResult {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  };
}

/**
 * POST /connections/mongodb/connect
 * Body: { connectionString: string, database?: string }
 *
 * Validates by issuing a ping. On success persists the credential.
 */
export async function handleMongoConnect(
  body: unknown,
): Promise<ConnectorHandlerResult> {
  let connectionString: string;
  let database: string | undefined;
  try {
    const parsed = (body ?? {}) as {
      connectionString?: unknown;
      database?: unknown;
    };
    connectionString = validateConnectionString(parsed.connectionString);
    // SSRF guard: extract the first hostname from the connection string and
    // reject non-loopback private/reserved ranges (H1, audit 2026-06-19).
    try {
      const csUrl = new URL(
        connectionString.replace(/^mongodb(\+srv)?:\/\//, "https://"),
      );
      const h = csUrl.hostname.toLowerCase();
      const isLoopback =
        h === "localhost" || h.endsWith(".localhost") || /^127\./.test(h);
      if (!isLoopback && isPrivateHost(csUrl.hostname)) {
        throw new Error("Private or reserved hostname not allowed");
      }
    } catch (e) {
      if (
        e instanceof Error &&
        e.message === "Private or reserved hostname not allowed"
      ) {
        throw e;
      }
      // URL parse failure on exotic connection strings — fall through, the
      // driver will reject them at connect time.
    }
    if (parsed.database !== undefined) {
      if (typeof parsed.database !== "string") {
        throw new Error("database must be a string");
      }
      database = parsed.database;
    }
  } catch (err) {
    return jsonResult(400, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Verify by pinging admin before persisting.
  try {
    const client = await getClient(connectionString);
    await client.db("admin").command({ ping: 1 });
  } catch (err) {
    // Close the failed client so a retry uses fresh state.
    await disconnectClient();
    return jsonResult(400, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const tokens: MongoTokens = {
    connectionString,
    database,
    connected_at: new Date().toISOString(),
  };
  saveTokens(tokens);
  return jsonResult(200, {
    ok: true,
    status: mongoConnector().getStatus(),
  });
}

/**
 * POST /connections/mongodb/test — re-ping the stored connection.
 */
export async function handleMongoTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return jsonResult(400, { ok: false, error: "MongoDB not connected" });
  }
  try {
    const client = await getClient(tokens.connectionString);
    await client.db("admin").command({ ping: 1 });
    return jsonResult(200, { ok: true, message: "connected" });
  } catch (err) {
    return jsonResult(400, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * DELETE /connections/mongodb — close client, drop token.
 */
export async function handleMongoDisconnect(): Promise<ConnectorHandlerResult> {
  await mongoConnector().disconnect();
  return jsonResult(200, { ok: true });
}

/**
 * Optional HTML status page parity with other connectors. Not wired by
 * default — exported for symmetry should the router need it.
 */
export function renderMongoStatusHtml(): ConnectorHandlerResult {
  const status = mongoConnector().getStatus();
  return {
    status: 200,
    contentType: "text/html",
    body: `<html><body><h2>MongoDB</h2><pre>${escHtml(
      JSON.stringify(status, null, 2),
    )}</pre></body></html>`,
  };
}
