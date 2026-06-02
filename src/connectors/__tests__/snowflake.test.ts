import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Fake fetch helpers ──────────────────────────────────────────────────────

type FetchCall = { url: string; init?: RequestInit };

function mockFetchResponse(opts: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}): Response {
  const status = opts.status ?? 200;
  const headers = new Headers(opts.headers ?? {});
  const bodyStr =
    opts.body === undefined
      ? ""
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
  return new Response(bodyStr, { status, headers });
}

function installFetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fn as unknown as typeof fetch;
  return { calls };
}

// ── Test harness ────────────────────────────────────────────────────────────

const tmpDir = join(os.tmpdir(), `patchwork-snowflake-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

const originalFetch = globalThis.fetch;

const SNOWFLAKE_ENV_VARS = [
  "SNOWFLAKE_ACCOUNT",
  "SNOWFLAKE_USER",
  "SNOWFLAKE_PAT",
  "SNOWFLAKE_WAREHOUSE",
  "SNOWFLAKE_DATABASE",
  "SNOWFLAKE_SCHEMA",
  "SNOWFLAKE_ROLE",
];

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  for (const v of SNOWFLAKE_ENV_VARS) delete process.env[v];
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  for (const v of SNOWFLAKE_ENV_VARS) delete process.env[v];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── isReadOnlySql ───────────────────────────────────────────────────────────

describe("isReadOnlySql", () => {
  it("accepts SELECT / SHOW / DESC / DESCRIBE / EXPLAIN / WITH", async () => {
    const { isReadOnlySql } = await import("../snowflake.js");
    expect(isReadOnlySql("SELECT * FROM t")).toBe(true);
    expect(isReadOnlySql("  select 1")).toBe(true);
    expect(isReadOnlySql("SHOW DATABASES")).toBe(true);
    expect(isReadOnlySql("DESC TABLE t")).toBe(true);
    expect(isReadOnlySql("DESCRIBE TABLE t")).toBe(true);
    expect(isReadOnlySql("EXPLAIN SELECT 1")).toBe(true);
    expect(isReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
  });

  it("rejects mutating statements", async () => {
    const { isReadOnlySql } = await import("../snowflake.js");
    expect(isReadOnlySql("INSERT INTO t VALUES (1)")).toBe(false);
    expect(isReadOnlySql("UPDATE t SET a=1")).toBe(false);
    expect(isReadOnlySql("DELETE FROM t")).toBe(false);
    expect(isReadOnlySql("DROP TABLE t")).toBe(false);
    expect(isReadOnlySql("CREATE TABLE t (id INT)")).toBe(false);
    expect(isReadOnlySql("MERGE INTO t USING s ON ...")).toBe(false);
    expect(isReadOnlySql("ALTER TABLE t ADD COLUMN c INT")).toBe(false);
    expect(isReadOnlySql("TRUNCATE TABLE t")).toBe(false);
    expect(isReadOnlySql("GRANT SELECT ON t TO ROLE r")).toBe(false);
  });

  it("rejects chained statements but accepts a single trailing semicolon", async () => {
    const { isReadOnlySql } = await import("../snowflake.js");
    expect(isReadOnlySql("SELECT 1; DROP TABLE t")).toBe(false);
    expect(isReadOnlySql("SELECT 1; SELECT 2")).toBe(false);
    expect(isReadOnlySql("SELECT 1;")).toBe(true);
  });

  it("strips leading comments", async () => {
    const { isReadOnlySql } = await import("../snowflake.js");
    expect(isReadOnlySql("-- hello\nSELECT 1")).toBe(true);
    expect(isReadOnlySql("/* block */ SELECT 1")).toBe(true);
    expect(isReadOnlySql("-- comment\nDROP TABLE x")).toBe(false);
  });

  it("rejects non-strings and empty input", async () => {
    const { isReadOnlySql } = await import("../snowflake.js");
    expect(isReadOnlySql("")).toBe(false);
    expect(isReadOnlySql("   ")).toBe(false);
    // @ts-expect-error — runtime guard test
    expect(isReadOnlySql(null)).toBe(false);
  });
});

// ── validateSqlIdentifier ───────────────────────────────────────────────────

describe("validateSqlIdentifier", () => {
  it("accepts safe identifiers", async () => {
    const { validateSqlIdentifier } = await import("../snowflake.js");
    expect(validateSqlIdentifier("my_db")).toBe("my_db");
    expect(validateSqlIdentifier("_underscore")).toBe("_underscore");
    expect(validateSqlIdentifier("MY_TABLE_1")).toBe("MY_TABLE_1");
    expect(validateSqlIdentifier("tbl$ext")).toBe("tbl$ext");
  });

  it("rejects names with quotes / semicolons / spaces / dashes", async () => {
    const { validateSqlIdentifier } = await import("../snowflake.js");
    expect(() => validateSqlIdentifier('a"b')).toThrow(
      /Invalid SQL identifier/,
    );
    expect(() => validateSqlIdentifier("a;b")).toThrow(
      /Invalid SQL identifier/,
    );
    expect(() => validateSqlIdentifier("a b")).toThrow(
      /Invalid SQL identifier/,
    );
    expect(() => validateSqlIdentifier("a-b")).toThrow(
      /Invalid SQL identifier/,
    );
    expect(() => validateSqlIdentifier("a'b")).toThrow(
      /Invalid SQL identifier/,
    );
    expect(() => validateSqlIdentifier("'; DROP TABLE x; --")).toThrow(
      /Invalid SQL identifier/,
    );
  });

  it("rejects leading digit, empty string, oversized names", async () => {
    const { validateSqlIdentifier } = await import("../snowflake.js");
    expect(() => validateSqlIdentifier("1abc")).toThrow(
      /Invalid SQL identifier/,
    );
    expect(() => validateSqlIdentifier("")).toThrow(/non-empty/);
    expect(() => validateSqlIdentifier("a".repeat(300))).toThrow(/too long/);
  });
});

// ── normalizeError ──────────────────────────────────────────────────────────

describe("normalizeError", () => {
  it("maps 401 → auth_expired (not retryable)", async () => {
    const { SnowflakeConnector } = await import("../snowflake.js");
    const c = new SnowflakeConnector();
    const err = c.normalizeError(new Response("", { status: 401 }));
    expect(err.code).toBe("auth_expired");
    expect(err.retryable).toBe(false);
  });

  it("maps 403 → permission_denied", async () => {
    const { SnowflakeConnector } = await import("../snowflake.js");
    const c = new SnowflakeConnector();
    expect(c.normalizeError(new Response("", { status: 403 })).code).toBe(
      "permission_denied",
    );
  });

  it("maps 404 → not_found", async () => {
    const { SnowflakeConnector } = await import("../snowflake.js");
    const c = new SnowflakeConnector();
    expect(c.normalizeError(new Response("", { status: 404 })).code).toBe(
      "not_found",
    );
  });

  it("maps 408 → provider_error with statement timeout text", async () => {
    const { SnowflakeConnector } = await import("../snowflake.js");
    const c = new SnowflakeConnector();
    const err = c.normalizeError(new Response("", { status: 408 }));
    expect(err.code).toBe("provider_error");
    expect(err.message).toMatch(/timeout/i);
    expect(err.retryable).toBe(false);
  });

  it("maps 422 → provider_error with compilation error text", async () => {
    const { SnowflakeConnector } = await import("../snowflake.js");
    const c = new SnowflakeConnector();
    const err = c.normalizeError(new Response("", { status: 422 }));
    expect(err.code).toBe("provider_error");
    expect(err.message).toMatch(/compilation/i);
  });

  it("maps 429 → rate_limited (retryable)", async () => {
    const { SnowflakeConnector } = await import("../snowflake.js");
    const c = new SnowflakeConnector();
    const err = c.normalizeError(new Response("", { status: 429 }));
    expect(err.code).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });

  it("maps 5xx → provider_error (retryable)", async () => {
    const { SnowflakeConnector } = await import("../snowflake.js");
    const c = new SnowflakeConnector();
    const err = c.normalizeError(new Response("", { status: 503 }));
    expect(err.code).toBe("provider_error");
    expect(err.retryable).toBe(true);
  });

  it("detects ENOTFOUND/ECONNREFUSED as network_error", async () => {
    const { SnowflakeConnector } = await import("../snowflake.js");
    const c = new SnowflakeConnector();
    expect(
      c.normalizeError(new Error("getaddrinfo ENOTFOUND snowflake")).code,
    ).toBe("network_error");
    expect(c.normalizeError(new Error("ECONNREFUSED")).code).toBe(
      "network_error",
    );
  });

  it("defaults unknown to provider_error", async () => {
    const { SnowflakeConnector } = await import("../snowflake.js");
    const c = new SnowflakeConnector();
    expect(c.normalizeError(new Error("boom")).code).toBe("provider_error");
    expect(c.normalizeError("not an error").code).toBe("provider_error");
  });
});

// ── Env override ────────────────────────────────────────────────────────────

describe("env override", () => {
  it("loadTokens picks up SNOWFLAKE_* env vars", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "xy12345.us-east-1";
    process.env.SNOWFLAKE_USER = "alice";
    process.env.SNOWFLAKE_PAT = "pat_secret";
    process.env.SNOWFLAKE_WAREHOUSE = "COMPUTE_WH";
    process.env.SNOWFLAKE_DATABASE = "ANALYTICS";
    const { loadTokens } = await import("../snowflake.js");
    const t = loadTokens();
    expect(t).not.toBeNull();
    expect(t?.accountIdentifier).toBe("xy12345.us-east-1");
    expect(t?.user).toBe("alice");
    expect(t?.pat).toBe("pat_secret");
    expect(t?.warehouse).toBe("COMPUTE_WH");
    expect(t?.database).toBe("ANALYTICS");
  });

  it("loadTokens returns null without env + no stored tokens", async () => {
    const { loadTokens } = await import("../snowflake.js");
    expect(loadTokens()).toBeNull();
  });

  it("partial env (missing PAT) falls through to stored tokens (null here)", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "xy12345";
    process.env.SNOWFLAKE_USER = "alice";
    const { loadTokens } = await import("../snowflake.js");
    expect(loadTokens()).toBeNull();
  });
});

// ── executeQuery / SHOW family ─────────────────────────────────────────────

describe("executeQuery", () => {
  it("rejects mutating SQL before touching the network", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "xy12345";
    process.env.SNOWFLAKE_USER = "alice";
    process.env.SNOWFLAKE_PAT = "pat";
    const mock = installFetchMock(() =>
      mockFetchResponse({ body: { data: [["1"]] } }),
    );
    const { getSnowflakeConnector } = await import("../snowflake.js");
    const c = getSnowflakeConnector();
    await expect(c.executeQuery("DELETE FROM t")).rejects.toThrow(/read-only/i);
    await expect(c.executeQuery("DROP TABLE t")).rejects.toThrow(/read-only/i);
    await expect(c.executeQuery("INSERT INTO t VALUES (1)")).rejects.toThrow(
      /read-only/i,
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("posts to the Snowflake SQL API with proper headers", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "xy12345.us-east-1";
    process.env.SNOWFLAKE_USER = "alice";
    process.env.SNOWFLAKE_PAT = "pat_secret";
    process.env.SNOWFLAKE_WAREHOUSE = "COMPUTE_WH";
    const mock = installFetchMock(() =>
      mockFetchResponse({
        body: {
          statementHandle: "h1",
          resultSetMetaData: {
            numRows: 1,
            rowType: [{ name: "C1", type: "NUMBER" }],
          },
          data: [["1"]],
        },
      }),
    );
    const { getSnowflakeConnector } = await import("../snowflake.js");
    const c = getSnowflakeConnector();
    const result = await c.executeQuery("SELECT 1");
    expect(result.rows).toEqual([["1"]]);
    expect(result.columns[0]?.name).toBe("C1");
    expect(result.truncated).toBe(false);

    const call = mock.calls[0] as unknown as { url: string; init: RequestInit };
    const { url, init } = call;
    expect(url).toBe(
      "https://xy12345.us-east-1.snowflakecomputing.com/api/v2/statements",
    );
    expect(init?.method).toBe("POST");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer pat_secret");
    expect(headers["X-Snowflake-Authorization-Token-Type"]).toBe(
      "PROGRAMMATIC_ACCESS_TOKEN",
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.statement).toBe("SELECT 1");
    expect(body.warehouse).toBe("COMPUTE_WH");
  });

  // Regression: SQL API v2 returns HTTP 202 (still in 2xx) with a
  // statementHandle and no data when a query exceeds the sync window.
  // postStatement only checked res.ok, so it silently returned rows:[].
  it("throws (not silent empty) when the statement is still executing async (202)", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "xy12345";
    process.env.SNOWFLAKE_USER = "alice";
    process.env.SNOWFLAKE_PAT = "pat";
    installFetchMock(() =>
      mockFetchResponse({
        status: 202,
        body: {
          statementHandle: "01b2-async-handle",
          message: "Asynchronous execution in progress.",
        },
      }),
    );
    const { getSnowflakeConnector } = await import("../snowflake.js");
    const c = getSnowflakeConnector();
    await expect(c.executeQuery("SELECT 1")).rejects.toThrow(
      /still (executing|running)|async/i,
    );
  });

  it("async 202 error mentions the statementHandle so the user can poll", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "xy12345";
    process.env.SNOWFLAKE_USER = "alice";
    process.env.SNOWFLAKE_PAT = "pat";
    installFetchMock(() =>
      mockFetchResponse({
        status: 202,
        body: { statementHandle: "handle-xyz-123" },
      }),
    );
    const { getSnowflakeConnector } = await import("../snowflake.js");
    const c = getSnowflakeConnector();
    await expect(c.executeQuery("SELECT 1")).rejects.toThrow(/handle-xyz-123/);
  });

  it("truncates result rows above the row limit", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "xy12345";
    process.env.SNOWFLAKE_USER = "alice";
    process.env.SNOWFLAKE_PAT = "pat";
    const rows = Array.from({ length: 50 }, (_, i) => [String(i)]);
    installFetchMock(() =>
      mockFetchResponse({
        body: {
          statementHandle: "h",
          resultSetMetaData: {
            numRows: 50,
            rowType: [{ name: "n", type: "NUMBER" }],
          },
          data: rows,
        },
      }),
    );
    const { getSnowflakeConnector } = await import("../snowflake.js");
    const c = getSnowflakeConnector();
    const result = await c.executeQuery("SELECT n FROM t", [], 10);
    expect(result.rows).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(50);
  });
});

describe("listTables identifier interpolation", () => {
  it("rejects unsafe database/schema names without making a request", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "xy12345";
    process.env.SNOWFLAKE_USER = "alice";
    process.env.SNOWFLAKE_PAT = "pat";
    const mock = installFetchMock(() =>
      mockFetchResponse({ body: { data: [] } }),
    );
    const { getSnowflakeConnector } = await import("../snowflake.js");
    const c = getSnowflakeConnector();
    await expect(c.listTables("good_db", "bad;schema")).rejects.toThrow(
      /Invalid SQL identifier/,
    );
    await expect(c.listSchemas("'; DROP DATABASE x; --")).rejects.toThrow(
      /Invalid SQL identifier/,
    );
    await expect(
      c.describeTable("db", "schema", "tbl with space"),
    ).rejects.toThrow(/Invalid SQL identifier/);
    expect(mock.calls).toHaveLength(0);
  });

  it("builds a safe `SHOW TABLES IN db.schema` statement when both args are valid", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "xy12345";
    process.env.SNOWFLAKE_USER = "alice";
    process.env.SNOWFLAKE_PAT = "pat";
    const mock = installFetchMock(() =>
      mockFetchResponse({
        body: {
          resultSetMetaData: { numRows: 0, rowType: [] },
          data: [],
        },
      }),
    );
    const { getSnowflakeConnector } = await import("../snowflake.js");
    const c = getSnowflakeConnector();
    await c.listTables("MY_DB", "PUBLIC");
    const call = mock.calls[0] as unknown as { url: string; init: RequestInit };
    const body = JSON.parse(String(call.init?.body)) as { statement: string };
    expect(body.statement).toBe("SHOW TABLES IN MY_DB.PUBLIC");
  });

  it("describeTable builds DESCRIBE TABLE db.schema.table", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "xy12345";
    process.env.SNOWFLAKE_USER = "alice";
    process.env.SNOWFLAKE_PAT = "pat";
    const mock = installFetchMock(() =>
      mockFetchResponse({
        body: { resultSetMetaData: { numRows: 0, rowType: [] }, data: [] },
      }),
    );
    const { getSnowflakeConnector } = await import("../snowflake.js");
    const c = getSnowflakeConnector();
    await c.describeTable("MY_DB", "PUBLIC", "USERS");
    const call = mock.calls[0] as unknown as { url: string; init: RequestInit };
    const body = JSON.parse(String(call.init?.body)) as { statement: string };
    expect(body.statement).toBe("DESCRIBE TABLE MY_DB.PUBLIC.USERS");
  });
});

// ── healthCheck ─────────────────────────────────────────────────────────────

describe("healthCheck", () => {
  it("returns ok=true on SELECT 1 success", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "xy12345";
    process.env.SNOWFLAKE_USER = "alice";
    process.env.SNOWFLAKE_PAT = "pat";
    installFetchMock(() =>
      mockFetchResponse({
        body: {
          resultSetMetaData: {
            numRows: 1,
            rowType: [{ name: "C1", type: "NUMBER" }],
          },
          data: [["1"]],
        },
      }),
    );
    const { getSnowflakeConnector } = await import("../snowflake.js");
    const c = getSnowflakeConnector();
    const out = await c.healthCheck();
    expect(out.ok).toBe(true);
  });

  it("returns ok=false on 401", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "xy12345";
    process.env.SNOWFLAKE_USER = "alice";
    process.env.SNOWFLAKE_PAT = "pat";
    installFetchMock(() =>
      mockFetchResponse({ status: 401, body: { message: "bad token" } }),
    );
    const { getSnowflakeConnector } = await import("../snowflake.js");
    const c = getSnowflakeConnector();
    const out = await c.healthCheck();
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("auth_expired");
  });
});

// ── HTTP connect handler ────────────────────────────────────────────────────

describe("handleSnowflakeConnect", () => {
  it("rejects invalid JSON", async () => {
    const { handleSnowflakeConnect } = await import("../snowflake.js");
    const r = await handleSnowflakeConnect("not json");
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid JSON/);
  });

  it("requires accountIdentifier + user + pat", async () => {
    const { handleSnowflakeConnect } = await import("../snowflake.js");
    const r = await handleSnowflakeConnect(JSON.stringify({}));
    expect(r.status).toBe(400);
  });

  it("rejects malformed accountIdentifier", async () => {
    const { handleSnowflakeConnect } = await import("../snowflake.js");
    const r = await handleSnowflakeConnect(
      JSON.stringify({
        accountIdentifier: "bad host with spaces",
        user: "alice",
        pat: "pat",
      }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid Snowflake accountIdentifier/);
  });

  it("validates via SELECT 1 + stores tokens on success", async () => {
    installFetchMock(() =>
      mockFetchResponse({
        body: {
          resultSetMetaData: { numRows: 1, rowType: [] },
          data: [["1"]],
        },
      }),
    );
    const { handleSnowflakeConnect, loadTokens } = await import(
      "../snowflake.js"
    );
    const r = await handleSnowflakeConnect(
      JSON.stringify({
        accountIdentifier: "xy12345.us-east-1",
        user: "alice",
        pat: "pat",
        database: "ANALYTICS",
      }),
    );
    expect(r.status).toBe(200);
    const tokens = loadTokens();
    expect(tokens?.accountIdentifier).toBe("xy12345.us-east-1");
    expect(tokens?.database).toBe("ANALYTICS");
  });

  it("returns 401 on auth failure without storing tokens", async () => {
    installFetchMock(() =>
      mockFetchResponse({ status: 401, body: { message: "bad token" } }),
    );
    const { handleSnowflakeConnect, loadTokens } = await import(
      "../snowflake.js"
    );
    const r = await handleSnowflakeConnect(
      JSON.stringify({
        accountIdentifier: "xy12345",
        user: "alice",
        pat: "bad",
      }),
    );
    expect(r.status).toBe(401);
    expect(loadTokens()).toBeNull();
  });
});
