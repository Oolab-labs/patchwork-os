/**
 * Snowflake connector — read-only SQL access via the official Snowflake SQL
 * REST API v2 (https://docs.snowflake.com/en/developer-guide/sql-api/).
 *
 * Auth: Personal Access Token (PAT, 2024+ feature). Sent as
 *   Authorization: Bearer <pat>
 *   X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN
 * No driver dependency — plain `fetch`.
 *
 * Stored: getSecretJsonSync("snowflake") → SnowflakeTokens
 * Env override (CI/headless):
 *   SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PAT
 *   SNOWFLAKE_WAREHOUSE?, SNOWFLAKE_DATABASE?, SNOWFLAKE_SCHEMA?, SNOWFLAKE_ROLE?
 *
 * Tools (READ-ONLY): executeQuery, listDatabases, listSchemas, listTables,
 *                    describeTable.
 *
 * Defence in depth:
 *   - `isReadOnlySql` accepts only SELECT/SHOW/DESC/DESCRIBE/EXPLAIN/WITH.
 *   - `validateSqlIdentifier` enforces a strict identifier charset for every
 *     parameter that we interpolate into a SHOW/DESCRIBE clause.
 *   - Row-cap of 1000 applied to every execute response.
 *
 * Mirrors the shape of `postgres.ts` (the data-store template).
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

// ── Types ───────────────────────────────────────────────────────────────────

export interface SnowflakeTokens {
  accountIdentifier: string; // e.g. "xy12345.us-east-1"
  user: string;
  pat: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
  connected_at: string;
}

export interface SnowflakeColumnMeta {
  name: string;
  type: string;
  nullable?: boolean;
  length?: number;
  precision?: number;
  scale?: number;
}

export interface SnowflakeQueryResult {
  statementHandle?: string;
  columns: SnowflakeColumnMeta[];
  rows: string[][];
  rowCount: number;
  truncated: boolean;
}

interface SnowflakeStatementResponseColumn {
  name?: string;
  type?: string;
  nullable?: boolean;
  length?: number;
  precision?: number;
  scale?: number;
}

interface SnowflakeStatementResponse {
  statementHandle?: string;
  resultSetMetaData?: {
    numRows?: number;
    rowType?: SnowflakeStatementResponseColumn[];
  };
  data?: unknown[][];
  code?: string;
  message?: string;
  sqlState?: string;
}

interface SnowflakeErrorBody {
  code?: string;
  message?: string;
  sqlState?: string;
}

// ── SQL safety ──────────────────────────────────────────────────────────────

const READ_ONLY_KEYWORDS = new Set([
  "select",
  "show",
  "desc",
  "describe",
  "explain",
  "with",
]);

/**
 * True iff `sql` is a read-only Snowflake statement (SELECT / SHOW / DESC /
 * DESCRIBE / EXPLAIN / WITH). Strips leading comments + whitespace and
 * inspects the first keyword. Rejects semicolon-chained statements (one
 * trailing semicolon is fine).
 */
export function isReadOnlySql(sql: string): boolean {
  if (typeof sql !== "string") return false;
  let s = sql.trim();
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
  const stripped = s.replace(/;\s*$/, "");
  if (stripped.includes(";")) return false;
  return true;
}

const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Enforce a strict identifier charset on values interpolated into SHOW /
 * DESCRIBE clauses. Rejects anything containing quotes, semicolons, spaces,
 * or other punctuation — i.e. blocks SQL-injection at the source. Returns the
 * identifier unchanged on success; throws on failure.
 */
export function validateSqlIdentifier(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("SQL identifier must be a non-empty string");
  }
  if (name.length > 255) {
    throw new Error("SQL identifier too long (max 255 chars)");
  }
  if (!SQL_IDENT_RE.test(name)) {
    throw new Error(
      `Invalid SQL identifier '${name}' — only letters, digits, underscore, and dollar sign permitted`,
    );
  }
  return name;
}

// ── Row cap ─────────────────────────────────────────────────────────────────

const MAX_ROWS = 1000;
const DEFAULT_ROW_LIMIT = 100;

// ── Connector ───────────────────────────────────────────────────────────────

export class SnowflakeConnector extends BaseConnector {
  readonly providerName = "snowflake";
  private tokens: SnowflakeTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Snowflake not connected. Run: patchwork-os connect snowflake (or set SNOWFLAKE_ACCOUNT + SNOWFLAKE_USER + SNOWFLAKE_PAT)",
      );
    }
    this.tokens = tokens;
    return { token: tokens.pat, scopes: ["read"] };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async () => {
        const resp = await this.postStatement({ statement: "SELECT 1" });
        const first = resp.data?.[0]?.[0];
        if (first === undefined || first === null) {
          throw new Error("Snowflake health check returned no rows");
        }
        return true;
      });
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    if (error instanceof Response) {
      return normalizeResponseError(error);
    }
    if (error instanceof SnowflakeHttpError) {
      return normalizeStatusCode(error.status, error.detail);
    }
    if (error instanceof Error) {
      if (
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("ETIMEDOUT")
      ) {
        return {
          code: "network_error",
          message: `Cannot connect to Snowflake: ${error.message}`,
          retryable: true,
        };
      }
      return {
        code: "provider_error",
        message: error.message,
        retryable: false,
      };
    }
    return {
      code: "provider_error",
      message: String(error),
      retryable: false,
    };
  }

  getStatus(): ConnectorStatus {
    const tokens = loadTokens();
    return {
      id: "snowflake",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens
        ? `Snowflake ${tokens.user}@${tokens.accountIdentifier}${
            tokens.database ? `/${tokens.database}` : ""
          }`
        : undefined,
    };
  }

  async disconnect(): Promise<void> {
    this.tokens = null;
  }

  // ── API Methods ───────────────────────────────────────────────────────────

  /**
   * Execute a read-only SQL statement.
   * @param sql       SELECT / SHOW / DESC / DESCRIBE / EXPLAIN / WITH
   * @param params    Optional positional parameters (bound via Snowflake
   *                  `parameters: { N: { type, value } }` — currently passed
   *                  through opaquely as strings).
   * @param rowLimit  Soft cap on returned rows (default 100, hard cap 1000).
   */
  async executeQuery(
    sql: string,
    params: unknown[] = [],
    rowLimit: number = DEFAULT_ROW_LIMIT,
  ): Promise<SnowflakeQueryResult> {
    if (!isReadOnlySql(sql)) {
      throw new Error(
        "Only read-only statements (SELECT / SHOW / DESC / DESCRIBE / EXPLAIN / WITH) are permitted",
      );
    }
    const cap = Math.max(1, Math.min(rowLimit, MAX_ROWS));
    const body: Record<string, unknown> = { statement: sql };
    const tokens = this.tokens ?? loadTokens();
    if (tokens?.warehouse) body.warehouse = tokens.warehouse;
    if (tokens?.database) body.database = tokens.database;
    if (tokens?.schema) body.schema = tokens.schema;
    if (tokens?.role) body.role = tokens.role;
    if (params.length > 0) {
      const parameters: Record<string, { type: string; value: string }> = {};
      for (let i = 0; i < params.length; i++) {
        parameters[String(i + 1)] = {
          type: "TEXT",
          value: String(params[i]),
        };
      }
      body.parameters = parameters;
    }

    const result = await this.apiCall(async () => {
      const resp = await this.postStatement(body);
      return shapeResult(resp, cap);
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async listDatabases(): Promise<SnowflakeQueryResult> {
    return this.executeQuery("SHOW DATABASES");
  }

  async listSchemas(database?: string): Promise<SnowflakeQueryResult> {
    let sql = "SHOW SCHEMAS";
    if (database !== undefined) {
      const db = validateSqlIdentifier(database);
      sql = `SHOW SCHEMAS IN DATABASE ${db}`;
    }
    return this.executeQuery(sql);
  }

  async listTables(
    database?: string,
    schema?: string,
  ): Promise<SnowflakeQueryResult> {
    let sql = "SHOW TABLES";
    if (database !== undefined && schema !== undefined) {
      const db = validateSqlIdentifier(database);
      const sc = validateSqlIdentifier(schema);
      sql = `SHOW TABLES IN ${db}.${sc}`;
    } else if (database !== undefined) {
      const db = validateSqlIdentifier(database);
      sql = `SHOW TABLES IN DATABASE ${db}`;
    } else if (schema !== undefined) {
      const sc = validateSqlIdentifier(schema);
      sql = `SHOW TABLES IN SCHEMA ${sc}`;
    }
    return this.executeQuery(sql);
  }

  async describeTable(
    database: string,
    schema: string,
    table: string,
  ): Promise<SnowflakeQueryResult> {
    const db = validateSqlIdentifier(database);
    const sc = validateSqlIdentifier(schema);
    const tb = validateSqlIdentifier(table);
    return this.executeQuery(`DESCRIBE TABLE ${db}.${sc}.${tb}`);
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  private async postStatement(
    body: Record<string, unknown>,
  ): Promise<SnowflakeStatementResponse> {
    const tokens = this.tokens ?? loadTokens();
    if (!tokens) {
      throw new Error("Snowflake not connected");
    }
    this.tokens = tokens;
    const url = buildStatementsUrl(tokens.accountIdentifier);
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(tokens.pat),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail: SnowflakeErrorBody | undefined;
      try {
        detail = (await res.json()) as SnowflakeErrorBody;
      } catch {
        // ignore — keep status-only error
      }
      throw new SnowflakeHttpError(res.status, detail);
    }
    // HTTP 202 is in the 2xx range (res.ok === true) but carries NO data:
    // the SQL API moved the statement to asynchronous execution because it
    // exceeded the synchronous window. Returning here would silently yield
    // rows:[]. Surface a clear error with the handle so the caller can poll
    // GET /api/v2/statements/<handle> instead of assuming an empty result.
    if (res.status === 202) {
      let handle: string | undefined;
      try {
        const partial = (await res.json()) as SnowflakeStatementResponse;
        handle = partial.statementHandle;
      } catch {
        // ignore — fall back to a handle-less message
      }
      throw new Error(
        handle
          ? `Snowflake statement is still executing asynchronously (statementHandle "${handle}"); it exceeded the synchronous window. Poll GET /api/v2/statements/${handle} for results.`
          : "Snowflake statement is still executing asynchronously; it exceeded the synchronous window. Poll GET /api/v2/statements/<statementHandle> for results.",
      );
    }
    return (await res.json()) as SnowflakeStatementResponse;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

class SnowflakeHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail?: SnowflakeErrorBody,
  ) {
    super(
      detail?.message
        ? `Snowflake API error (HTTP ${status}): ${detail.message}`
        : `Snowflake API error: HTTP ${status}`,
    );
    this.name = "SnowflakeHttpError";
  }
}

export function buildStatementsUrl(accountIdentifier: string): string {
  // Identifier is operator-supplied — keep a defensive sanity check that it
  // looks vaguely host-shaped (no slashes, no whitespace). We trust the
  // operator otherwise; full URL is constructed on our side, never echoed
  // from user input.
  if (!/^[A-Za-z0-9._-]+$/.test(accountIdentifier)) {
    throw new Error(
      `Invalid Snowflake accountIdentifier '${accountIdentifier}'`,
    );
  }
  return `https://${accountIdentifier}.snowflakecomputing.com/api/v2/statements`;
}

function buildHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function shapeResult(
  resp: SnowflakeStatementResponse,
  cap: number,
): SnowflakeQueryResult {
  const rowType = resp.resultSetMetaData?.rowType ?? [];
  const columns: SnowflakeColumnMeta[] = rowType.map((c) => ({
    name: c.name ?? "",
    type: c.type ?? "",
    nullable: c.nullable,
    length: c.length,
    precision: c.precision,
    scale: c.scale,
  }));
  const allRows = (resp.data ?? []) as string[][];
  const truncated = allRows.length > cap;
  return {
    statementHandle: resp.statementHandle,
    columns,
    rows: truncated ? allRows.slice(0, cap) : allRows,
    rowCount: resp.resultSetMetaData?.numRows ?? allRows.length,
    truncated,
  };
}

function normalizeResponseError(res: Response): ConnectorError {
  return normalizeStatusCode(res.status);
}

function normalizeStatusCode(
  status: number,
  detail?: SnowflakeErrorBody,
): ConnectorError {
  const baseMsg = detail?.message
    ? ` — ${detail.message}`
    : detail?.code
      ? ` (${detail.code})`
      : "";
  if (status === 401) {
    return {
      code: "auth_expired",
      message: `Snowflake authentication expired${baseMsg}`,
      retryable: false,
      suggestedAction: "patchwork-os connect snowflake",
    };
  }
  if (status === 403) {
    return {
      code: "permission_denied",
      message: `Insufficient Snowflake permissions${baseMsg}`,
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      code: "not_found",
      message: `Snowflake resource not found${baseMsg}`,
      retryable: false,
    };
  }
  if (status === 408) {
    return {
      code: "provider_error",
      message: `Snowflake statement timeout${baseMsg}`,
      retryable: false,
    };
  }
  if (status === 422) {
    return {
      code: "provider_error",
      message: `Snowflake statement compilation error${baseMsg}`,
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      message: `Snowflake API rate limit exceeded${baseMsg}`,
      retryable: true,
      suggestedAction: "Wait and retry",
    };
  }
  if (status >= 500) {
    return {
      code: "provider_error",
      message: `Snowflake API error: HTTP ${status}${baseMsg}`,
      retryable: true,
    };
  }
  return {
    code: "provider_error",
    message: `Snowflake API error: HTTP ${status}${baseMsg}`,
    retryable: false,
  };
}

// ── Token persistence ───────────────────────────────────────────────────────

export function loadTokens(): SnowflakeTokens | null {
  const account = process.env.SNOWFLAKE_ACCOUNT;
  const user = process.env.SNOWFLAKE_USER;
  const pat = process.env.SNOWFLAKE_PAT;
  if (account && user && pat) {
    return {
      accountIdentifier: account,
      user,
      pat,
      warehouse: process.env.SNOWFLAKE_WAREHOUSE,
      database: process.env.SNOWFLAKE_DATABASE,
      schema: process.env.SNOWFLAKE_SCHEMA,
      role: process.env.SNOWFLAKE_ROLE,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<SnowflakeTokens>("snowflake");
}

export function saveTokens(tokens: SnowflakeTokens): void {
  storeSecretJsonSync("snowflake", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("snowflake");
  } catch {
    // ignore
  }
}

// ── Singleton instance ──────────────────────────────────────────────────────

let _instance: SnowflakeConnector | null = null;

function resetSnowflakeConnector(): void {
  if (_instance) {
    void _instance.disconnect();
  }
  _instance = null;
}

export function getSnowflakeConnector(): SnowflakeConnector {
  if (!_instance) {
    _instance = new SnowflakeConnector();
  }
  return _instance;
}

export { getSnowflakeConnector as snowflake };

// ── HTTP Handlers ───────────────────────────────────────────────────────────
// Wired in src/connectorRoutes.ts under /connections/snowflake/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

interface SnowflakeConnectBody {
  accountIdentifier?: unknown;
  user?: unknown;
  pat?: unknown;
  warehouse?: unknown;
  database?: unknown;
  schema?: unknown;
  role?: unknown;
}

/**
 * POST /connections/snowflake/connect
 *   body: { accountIdentifier, user, pat, warehouse?, database?, schema?, role? }
 *
 * Validates by running `SELECT 1` against the SQL API. Only stores tokens
 * after a successful round-trip.
 */
export async function handleSnowflakeConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let parsed: SnowflakeConnectBody;
  try {
    parsed = JSON.parse(body) as SnowflakeConnectBody;
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  if (
    typeof parsed.accountIdentifier !== "string" ||
    !parsed.accountIdentifier
  ) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: "accountIdentifier is required",
      }),
    };
  }
  if (typeof parsed.user !== "string" || !parsed.user) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "user is required" }),
    };
  }
  if (typeof parsed.pat !== "string" || !parsed.pat) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "pat is required" }),
    };
  }

  const candidate: SnowflakeTokens = {
    accountIdentifier: parsed.accountIdentifier,
    user: parsed.user,
    pat: parsed.pat,
    connected_at: new Date().toISOString(),
  };
  if (typeof parsed.warehouse === "string" && parsed.warehouse) {
    candidate.warehouse = parsed.warehouse;
  }
  if (typeof parsed.database === "string" && parsed.database) {
    candidate.database = parsed.database;
  }
  if (typeof parsed.schema === "string" && parsed.schema) {
    candidate.schema = parsed.schema;
  }
  if (typeof parsed.role === "string" && parsed.role) {
    candidate.role = parsed.role;
  }

  // Validate accountIdentifier shape before we hit the network.
  let url: string;
  try {
    url = buildStatementsUrl(candidate.accountIdentifier);
  } catch (err) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  try {
    const probeBody: Record<string, unknown> = { statement: "SELECT 1" };
    if (candidate.warehouse) probeBody.warehouse = candidate.warehouse;
    if (candidate.database) probeBody.database = candidate.database;
    if (candidate.schema) probeBody.schema = candidate.schema;
    if (candidate.role) probeBody.role = candidate.role;
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(candidate.pat),
      body: JSON.stringify(probeBody),
    });
    if (!res.ok) {
      let detail: SnowflakeErrorBody | undefined;
      try {
        detail = (await res.json()) as SnowflakeErrorBody;
      } catch {
        /* ignore */
      }
      const norm = normalizeStatusCode(res.status, detail);
      const httpStatus =
        norm.code === "auth_expired" || norm.code === "permission_denied"
          ? 401
          : 400;
      return {
        status: httpStatus,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: norm.message }),
      };
    }
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

  saveTokens(candidate);
  resetSnowflakeConnector();

  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      accountIdentifier: candidate.accountIdentifier,
      user: candidate.user,
      database: candidate.database,
      connectedAt: candidate.connected_at,
    }),
  };
}

/**
 * POST /connections/snowflake/test
 */
export async function handleSnowflakeTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Snowflake not connected" }),
    };
  }
  try {
    const connector = getSnowflakeConnector();
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
 * DELETE /connections/snowflake
 */
export async function handleSnowflakeDisconnect(): Promise<ConnectorHandlerResult> {
  if (_instance) {
    await _instance.disconnect();
  }
  clearTokens();
  resetSnowflakeConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
