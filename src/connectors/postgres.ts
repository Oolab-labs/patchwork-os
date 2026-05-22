/**
 * Postgres connector — read-only SQL access via the `pg` driver.
 *
 * Auth: connection string OR discrete host/port/database/user/password.
 *   - Stored: getSecretJsonSync("postgres") → PostgresTokens
 *
 * Tools: listTables, describeTable, query (SELECT-only), explain (SELECT-only)
 *
 * Driver: `pg` is loaded lazily via dynamic import. It is NOT a project
 * dependency — operators must `npm install pg` in their workspace before
 * using this connector.
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 *
 * This file is the canonical template for the other data-store connectors
 * (MongoDB, Redis, Elasticsearch). Keep the shape consistent.
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

export interface PostgresTokens {
  /** Full DSN: postgres://user:pass@host:port/db */
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  connected_at: string;
}

export interface PostgresTable {
  table_schema: string;
  table_name: string;
}

export interface PostgresColumn {
  column_name: string;
  data_type: string;
  is_nullable: string; // "YES" | "NO"
  column_default: string | null;
}

export interface PostgresQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields: { name: string; dataTypeID: number }[];
  truncated: boolean;
}

// ── pg driver shape (minimal — we type-define rather than depend on @types/pg) ─

type PgPoolClient = {
  query: (text: string, values?: unknown[]) => Promise<PgQueryResultRaw>;
  release: () => void;
};
type PgQueryResultRaw = {
  rows: Record<string, unknown>[];
  rowCount: number | null;
  fields?: { name: string; dataTypeID: number }[];
};
type PgPool = {
  query: (text: string, values?: unknown[]) => Promise<PgQueryResultRaw>;
  connect: () => Promise<PgPoolClient>;
  end: () => Promise<void>;
};
type PgModule = {
  Pool: new (config: Record<string, unknown>) => PgPool;
};

let _pgModulePromise: Promise<PgModule | null> | null = null;
async function loadPgDriver(): Promise<PgModule> {
  if (!_pgModulePromise) {
    // @ts-expect-error — `pg` is an optional peer dependency, not in package.json
    _pgModulePromise = import("pg").then(
      (m) =>
        (m as unknown as { default?: PgModule }).default ??
        (m as unknown as PgModule),
      () => null,
    );
  }
  const mod = await _pgModulePromise;
  if (!mod) {
    throw new Error("Postgres driver not installed. Run: npm install pg");
  }
  return mod;
}

// Test seam — lets the test file inject a fake pg module without touching disk.
export function __setPgModuleForTest(mod: PgModule | null): void {
  _pgModulePromise = mod ? Promise.resolve(mod) : null;
}

// ── SQL safety guard ────────────────────────────────────────────────────────

const READ_ONLY_KEYWORDS = new Set(["select", "show", "explain", "with"]);

/**
 * True iff `sql` is a read-only statement (SELECT / SHOW / EXPLAIN / WITH).
 * Strips leading comments + whitespace and inspects the first keyword.
 * Defence in depth: pair with role-level read-only grants on the DB side.
 */
export function isReadOnlySql(sql: string): boolean {
  if (typeof sql !== "string") return false;
  let s = sql.trim();
  // Strip leading -- line comments and /* */ block comments
  while (s.length > 0) {
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1).trim();
      continue;
    }
    if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2).trim();
      continue;
    }
    break;
  }
  const match = s.match(/^([a-zA-Z]+)/);
  if (!match) return false;
  const kw = match[1]!.toLowerCase();
  if (!READ_ONLY_KEYWORDS.has(kw)) return false;
  // Reject semicolon-chained statements (cheap heuristic — rejects trailing
  // ";" too, accept that). Allows a single trailing semicolon.
  const stripped = s.replace(/;\s*$/, "");
  if (stripped.includes(";")) return false;
  return true;
}

/**
 * Wrap a SELECT-style statement with `LIMIT n` if it does not already cap
 * rows. Cheap heuristic: case-insensitive "limit" word search. The runtime
 * row-count cap in `query()` is the real safety net.
 */
export function applyRowLimit(sql: string, limit: number): string {
  const trimmed = sql.replace(/;\s*$/, "").trim();
  if (/\blimit\s+\d+/i.test(trimmed)) return trimmed;
  return `${trimmed} LIMIT ${limit}`;
}

// ── Connector ───────────────────────────────────────────────────────────────

export class PostgresConnector extends BaseConnector {
  readonly providerName = "postgres";
  private tokens: PostgresTokens | null = null;
  private pool: PgPool | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Postgres not connected. Run: patchwork-os connect postgres",
      );
    }
    this.tokens = tokens;
    return {
      token: tokens.connectionString ?? "postgres",
      scopes: ["read"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const pool = await this.getPool();
      await pool.query("SELECT 1");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    const message = error instanceof Error ? error.message : String(error);

    if (code === "28P01" || code === "28000") {
      return {
        code: "auth_expired",
        message: `Postgres authentication failed: ${message}`,
        retryable: false,
        suggestedAction: "patchwork-os connect postgres",
      };
    }
    if (code === "3D000") {
      return {
        code: "not_found",
        message: `Postgres database does not exist: ${message}`,
        retryable: false,
      };
    }
    if (
      code === "08006" ||
      code === "08001" ||
      code === "08000" ||
      code === "08003" ||
      code === "08004"
    ) {
      return {
        code: "network_error",
        message: `Postgres connection error: ${message}`,
        retryable: true,
      };
    }
    if (code === "42501") {
      return {
        code: "permission_denied",
        message: `Postgres permission denied: ${message}`,
        retryable: false,
      };
    }
    if (code === "42P01") {
      return {
        code: "not_found",
        message: `Postgres table not found: ${message}`,
        retryable: false,
      };
    }
    if (
      error instanceof Error &&
      (message.includes("ENOTFOUND") ||
        message.includes("ECONNREFUSED") ||
        message.includes("ETIMEDOUT"))
    ) {
      return {
        code: "network_error",
        message: `Cannot connect to Postgres: ${message}`,
        retryable: true,
      };
    }
    return {
      code: "provider_error",
      message,
      retryable: false,
    };
  }

  getStatus(): ConnectorStatus {
    const tokens = loadTokens();
    return {
      id: "postgres",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace:
        tokens?.database && tokens?.host
          ? `Postgres ${tokens.database}@${tokens.host}`
          : tokens?.database
            ? `Postgres ${tokens.database}`
            : undefined,
    };
  }

  // ── Pool management ───────────────────────────────────────────────────────

  private async getPool(): Promise<PgPool> {
    if (this.pool) return this.pool;
    if (!this.tokens) {
      const loaded = loadTokens();
      if (!loaded) {
        throw new Error("Postgres not connected");
      }
      this.tokens = loaded;
    }
    const pg = await loadPgDriver();
    this.pool = new pg.Pool(buildPgConfig(this.tokens));
    return this.pool;
  }

  /** Close the pool. Called by the HTTP disconnect handler. */
  async disconnect(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.end();
      } catch {
        // ignore — pool may already be closed
      }
      this.pool = null;
    }
    this.tokens = null;
  }

  // ── API Methods ───────────────────────────────────────────────────────────

  async listTables(schema?: string): Promise<PostgresTable[]> {
    const result = await this.apiCall(async () => {
      const pool = await this.getPool();
      const params: unknown[] = [];
      let sql =
        "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')";
      if (schema) {
        params.push(schema);
        sql += " AND table_schema = $1";
      }
      sql += " ORDER BY table_schema, table_name";
      const r = await pool.query(sql, params);
      return r.rows as unknown as PostgresTable[];
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PostgresTable[];
  }

  async describeTable(
    table: string,
    schema = "public",
  ): Promise<PostgresColumn[]> {
    const result = await this.apiCall(async () => {
      const pool = await this.getPool();
      const r = await pool.query(
        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
        [schema, table],
      );
      return r.rows as unknown as PostgresColumn[];
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PostgresColumn[];
  }

  async query(
    sql: string,
    params: unknown[] = [],
    rowLimit = 100,
  ): Promise<PostgresQueryResult> {
    if (!isReadOnlySql(sql)) {
      throw new Error(
        "Only read-only statements (SELECT / SHOW / EXPLAIN / WITH) are permitted",
      );
    }
    const cap = Math.max(1, Math.min(rowLimit, 10_000));
    const bounded = applyRowLimit(sql, cap);
    const result = await this.apiCall(async () => {
      const pool = await this.getPool();
      const r = await pool.query(bounded, params);
      const rows = r.rows ?? [];
      const truncated = rows.length >= cap;
      return {
        rows: rows.slice(0, cap),
        rowCount: r.rowCount ?? rows.length,
        fields: r.fields ?? [],
        truncated,
      } satisfies PostgresQueryResult;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PostgresQueryResult;
  }

  async explain(sql: string): Promise<unknown> {
    if (!isReadOnlySql(sql)) {
      throw new Error(
        "Only read-only statements (SELECT / SHOW / EXPLAIN / WITH) are permitted",
      );
    }
    const stripped = sql.replace(/;\s*$/, "").trim();
    const wrapped = `EXPLAIN (FORMAT JSON) ${stripped}`;
    const result = await this.apiCall(async () => {
      const pool = await this.getPool();
      const r = await pool.query(wrapped);
      // pg returns a single-row, single-column JSON array
      const first = r.rows[0] as Record<string, unknown> | undefined;
      if (!first) return null;
      const key = Object.keys(first)[0];
      return key ? first[key] : first;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }
}

// ── Config builder ──────────────────────────────────────────────────────────

function buildPgConfig(tokens: PostgresTokens): Record<string, unknown> {
  const config: Record<string, unknown> = {
    // Single-client pool — datasource workloads are short-lived; keep
    // connections cheap.
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
  if (tokens.connectionString) {
    config.connectionString = tokens.connectionString;
  } else {
    if (tokens.host) config.host = tokens.host;
    if (tokens.port) config.port = tokens.port;
    if (tokens.database) config.database = tokens.database;
    if (tokens.user) config.user = tokens.user;
    if (tokens.password) config.password = tokens.password;
  }
  if (tokens.ssl) config.ssl = { rejectUnauthorized: false };
  return config;
}

// ── Token persistence ───────────────────────────────────────────────────────

export function loadTokens(): PostgresTokens | null {
  return getSecretJsonSync<PostgresTokens>("postgres");
}

export function saveTokens(tokens: PostgresTokens): void {
  storeSecretJsonSync("postgres", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("postgres");
  } catch {
    // ignore
  }
}

// ── Singleton instance ──────────────────────────────────────────────────────

let _instance: PostgresConnector | null = null;

function resetPostgresConnector(): void {
  if (_instance) {
    // Best-effort pool teardown — don't block.
    void _instance.disconnect();
  }
  _instance = null;
}

export function getPostgresConnector(): PostgresConnector {
  if (!_instance) {
    _instance = new PostgresConnector();
  }
  return _instance;
}

export { getPostgresConnector as postgres };

// ── HTTP Handlers ───────────────────────────────────────────────────────────
// Wired in src/connectorRoutes.ts under /connections/postgres/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

interface PostgresConnectBody {
  connectionString?: unknown;
  host?: unknown;
  port?: unknown;
  database?: unknown;
  user?: unknown;
  password?: unknown;
  ssl?: unknown;
}

/**
 * POST /connections/postgres/connect
 *   body: { connectionString } OR { host, port?, database, user, password, ssl? }
 *
 * Validates by opening a connection, running `SELECT 1`, then closing.
 * Only stores tokens after a successful round-trip.
 */
export async function handlePostgresConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let parsed: PostgresConnectBody;
  try {
    parsed = JSON.parse(body) as PostgresConnectBody;
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  const candidate: PostgresTokens = { connected_at: new Date().toISOString() };
  if (typeof parsed.connectionString === "string" && parsed.connectionString) {
    candidate.connectionString = parsed.connectionString;
  } else {
    if (typeof parsed.host !== "string" || !parsed.host) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "Provide connectionString OR host+database+user+password",
        }),
      };
    }
    if (typeof parsed.database !== "string" || !parsed.database) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "database is required" }),
      };
    }
    if (typeof parsed.user !== "string" || !parsed.user) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "user is required" }),
      };
    }
    if (typeof parsed.password !== "string") {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "password is required" }),
      };
    }
    candidate.host = parsed.host;
    candidate.database = parsed.database;
    candidate.user = parsed.user;
    candidate.password = parsed.password;
    if (typeof parsed.port === "number") candidate.port = parsed.port;
    if (typeof parsed.ssl === "boolean") candidate.ssl = parsed.ssl;
  }

  // Validate by opening a pool + SELECT 1.
  let pg: PgModule;
  try {
    pg = await loadPgDriver();
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

  const pool = new pg.Pool(buildPgConfig(candidate));
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    const norm = getPostgresConnector().normalizeError(err);
    return {
      status:
        norm.code === "auth_expired" || norm.code === "permission_denied"
          ? 401
          : 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: norm.message }),
    };
  }
  try {
    await pool.end();
  } catch {
    /* ignore */
  }

  saveTokens(candidate);
  resetPostgresConnector();

  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      database: candidate.database,
      host: candidate.host,
      connectedAt: candidate.connected_at,
    }),
  };
}

/**
 * POST /connections/postgres/test
 */
export async function handlePostgresTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Postgres not connected" }),
    };
  }
  try {
    const connector = getPostgresConnector();
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
 * DELETE /connections/postgres
 */
export async function handlePostgresDisconnect(): Promise<ConnectorHandlerResult> {
  if (_instance) {
    await _instance.disconnect();
  }
  clearTokens();
  resetPostgresConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
