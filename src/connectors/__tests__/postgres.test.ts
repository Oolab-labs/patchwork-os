import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Fake pg driver ──────────────────────────────────────────────────────────

type Call = { sql: string; params?: unknown[] };

function makeFakePg(
  opts: { rows?: Record<string, unknown>[]; throwOnQuery?: unknown } = {},
) {
  const calls: Call[] = [];
  let ended = false;
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (opts.throwOnQuery) throw opts.throwOnQuery;
      return {
        rows: opts.rows ?? [],
        rowCount: (opts.rows ?? []).length,
        fields: [],
      };
    }),
    connect: vi.fn(),
    end: vi.fn(async () => {
      ended = true;
    }),
  };
  return {
    pg: {
      Pool: vi.fn().mockImplementation(() => pool),
    },
    pool,
    calls,
    isEnded: () => ended,
  };
}

// ── Test harness ────────────────────────────────────────────────────────────

const tmpDir = join(os.tmpdir(), `patchwork-postgres-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── SELECT-only guard ───────────────────────────────────────────────────────

describe("isReadOnlySql", () => {
  it("accepts SELECT / SHOW / EXPLAIN / WITH", async () => {
    const { isReadOnlySql } = await import("../postgres.js");
    expect(isReadOnlySql("SELECT * FROM users")).toBe(true);
    expect(isReadOnlySql("  select 1")).toBe(true);
    expect(isReadOnlySql("SHOW tables")).toBe(true);
    expect(isReadOnlySql("EXPLAIN SELECT 1")).toBe(true);
    expect(isReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
  });

  it("rejects INSERT / UPDATE / DELETE / DROP / TRUNCATE / ALTER", async () => {
    const { isReadOnlySql } = await import("../postgres.js");
    expect(isReadOnlySql("INSERT INTO users VALUES (1)")).toBe(false);
    expect(isReadOnlySql("UPDATE users SET name='x'")).toBe(false);
    expect(isReadOnlySql("DELETE FROM users")).toBe(false);
    expect(isReadOnlySql("DROP TABLE users")).toBe(false);
    expect(isReadOnlySql("TRUNCATE users")).toBe(false);
    expect(isReadOnlySql("ALTER TABLE users ADD col INT")).toBe(false);
    expect(isReadOnlySql("CREATE TABLE x (id INT)")).toBe(false);
    expect(isReadOnlySql("GRANT SELECT ON x TO y")).toBe(false);
  });

  it("rejects chained statements", async () => {
    const { isReadOnlySql } = await import("../postgres.js");
    expect(isReadOnlySql("SELECT 1; DROP TABLE users")).toBe(false);
    expect(isReadOnlySql("SELECT 1; SELECT 2")).toBe(false);
  });

  it("accepts a single trailing semicolon", async () => {
    const { isReadOnlySql } = await import("../postgres.js");
    expect(isReadOnlySql("SELECT 1;")).toBe(true);
  });

  it("strips leading comments before checking keyword", async () => {
    const { isReadOnlySql } = await import("../postgres.js");
    expect(isReadOnlySql("-- hi\nSELECT 1")).toBe(true);
    expect(isReadOnlySql("/* block */ SELECT 1")).toBe(true);
    expect(isReadOnlySql("-- not a SELECT\nDROP TABLE x")).toBe(false);
  });

  it("rejects non-strings + empty input", async () => {
    const { isReadOnlySql } = await import("../postgres.js");
    expect(isReadOnlySql("")).toBe(false);
    expect(isReadOnlySql("   ")).toBe(false);
    // @ts-expect-error — runtime guard test
    expect(isReadOnlySql(null)).toBe(false);
  });
});

// ── applyRowLimit ───────────────────────────────────────────────────────────

describe("applyRowLimit", () => {
  it("appends LIMIT when none present", async () => {
    const { applyRowLimit } = await import("../postgres.js");
    expect(applyRowLimit("SELECT * FROM users", 100)).toBe(
      "SELECT * FROM users LIMIT 100",
    );
  });

  it("preserves existing LIMIT", async () => {
    const { applyRowLimit } = await import("../postgres.js");
    expect(applyRowLimit("SELECT * FROM users LIMIT 5", 100)).toBe(
      "SELECT * FROM users LIMIT 5",
    );
  });

  it("strips trailing semicolon before appending", async () => {
    const { applyRowLimit } = await import("../postgres.js");
    expect(applyRowLimit("SELECT * FROM users;", 50)).toBe(
      "SELECT * FROM users LIMIT 50",
    );
  });
});

// ── normalizeError SQLSTATE mapping ─────────────────────────────────────────

describe("normalizeError", () => {
  it("maps SQLSTATE codes to ConnectorError shapes", async () => {
    const { PostgresConnector } = await import("../postgres.js");
    const c = new PostgresConnector();
    expect(c.normalizeError({ code: "28P01", message: "auth" }).code).toBe(
      "auth_expired",
    );
    expect(c.normalizeError({ code: "28000", message: "auth" }).code).toBe(
      "auth_expired",
    );
    expect(c.normalizeError({ code: "3D000", message: "no db" }).code).toBe(
      "not_found",
    );
    expect(c.normalizeError({ code: "08006", message: "net" }).code).toBe(
      "network_error",
    );
    expect(c.normalizeError({ code: "08001", message: "net" }).code).toBe(
      "network_error",
    );
    expect(c.normalizeError({ code: "42501", message: "perm" }).code).toBe(
      "permission_denied",
    );
    expect(c.normalizeError({ code: "42P01", message: "rel" }).code).toBe(
      "not_found",
    );
  });

  it("flags network_error retryable", async () => {
    const { PostgresConnector } = await import("../postgres.js");
    const c = new PostgresConnector();
    expect(c.normalizeError({ code: "08006", message: "x" }).retryable).toBe(
      true,
    );
    expect(c.normalizeError({ code: "28P01", message: "x" }).retryable).toBe(
      false,
    );
  });

  it("defaults to provider_error", async () => {
    const { PostgresConnector } = await import("../postgres.js");
    const c = new PostgresConnector();
    expect(c.normalizeError(new Error("boom")).code).toBe("provider_error");
  });

  it("detects ENOTFOUND/ECONNREFUSED as network_error", async () => {
    const { PostgresConnector } = await import("../postgres.js");
    const c = new PostgresConnector();
    expect(c.normalizeError(new Error("getaddrinfo ENOTFOUND db")).code).toBe(
      "network_error",
    );
  });
});

// ── query() integration with fake pg ────────────────────────────────────────

describe("query()", () => {
  it("rejects non-SELECT statements before touching the pool", async () => {
    const { getPostgresConnector, __setPgModuleForTest, saveTokens } =
      await import("../postgres.js");
    const fake = makeFakePg();
    __setPgModuleForTest(fake.pg);
    saveTokens({
      connectionString: "postgres://u:p@localhost/db",
      connected_at: new Date().toISOString(),
    });
    const c = getPostgresConnector();
    await expect(c.query("DELETE FROM users")).rejects.toThrow(/read-only/i);
    await expect(c.query("DROP TABLE users")).rejects.toThrow(/read-only/i);
    expect(fake.pool.query).not.toHaveBeenCalled();
  });

  it("builds correct LIMIT clause and marks truncated", async () => {
    const { getPostgresConnector, __setPgModuleForTest, saveTokens } =
      await import("../postgres.js");
    // Return exactly `cap` rows → truncated should be true.
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const fake = makeFakePg({ rows });
    __setPgModuleForTest(fake.pg);
    saveTokens({
      connectionString: "postgres://u:p@localhost/db",
      connected_at: new Date().toISOString(),
    });
    const c = getPostgresConnector();
    const result = await c.query("SELECT * FROM users", [], 5);
    expect(fake.calls[0]!.sql).toBe("SELECT * FROM users LIMIT 5");
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it("preserves user-supplied LIMIT clause", async () => {
    const { getPostgresConnector, __setPgModuleForTest, saveTokens } =
      await import("../postgres.js");
    const fake = makeFakePg({ rows: [{ id: 1 }] });
    __setPgModuleForTest(fake.pg);
    saveTokens({
      connectionString: "postgres://u:p@localhost/db",
      connected_at: new Date().toISOString(),
    });
    const c = getPostgresConnector();
    await c.query("SELECT * FROM users LIMIT 3");
    expect(fake.calls[0]!.sql).toBe("SELECT * FROM users LIMIT 3");
  });
});

// ── Missing driver path ─────────────────────────────────────────────────────

describe("missing pg driver", () => {
  it("connect handler returns 500 with friendly install message", async () => {
    const mod = await import("../postgres.js");
    mod.__setPgModuleForTest(null);
    // Force the loader to re-resolve from the import map (null → unset)
    // by re-importing fresh module state.
    vi.resetModules();
    vi.doMock("pg", () => {
      throw new Error("Cannot find module 'pg'");
    });
    const fresh = await import("../postgres.js");
    const result = await fresh.handlePostgresConnect(
      JSON.stringify({ connectionString: "postgres://u:p@localhost/db" }),
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body).toMatch(/npm install pg/);
    vi.doUnmock("pg");
  });
});

// ── HTTP connect handler validation ─────────────────────────────────────────

describe("handlePostgresConnect", () => {
  it("rejects invalid JSON", async () => {
    const { handlePostgresConnect } = await import("../postgres.js");
    const r = await handlePostgresConnect("not json");
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid JSON/);
  });

  it("requires connectionString or host+db+user+password", async () => {
    const { handlePostgresConnect } = await import("../postgres.js");
    const r = await handlePostgresConnect(JSON.stringify({}));
    expect(r.status).toBe(400);
  });

  it("validates by SELECT 1 + stores tokens on success", async () => {
    const { handlePostgresConnect, __setPgModuleForTest, loadTokens } =
      await import("../postgres.js");
    const fake = makeFakePg({ rows: [{ "?column?": 1 }] });
    __setPgModuleForTest(fake.pg);
    const r = await handlePostgresConnect(
      JSON.stringify({
        host: "localhost",
        database: "db",
        user: "u",
        password: "p",
      }),
    );
    expect(r.status).toBe(200);
    expect(fake.pool.query).toHaveBeenCalledWith("SELECT 1");
    expect(fake.isEnded()).toBe(true);
    const tokens = loadTokens();
    expect(tokens?.database).toBe("db");
  });

  it("returns 401 on auth failure without storing tokens", async () => {
    const { handlePostgresConnect, __setPgModuleForTest, loadTokens } =
      await import("../postgres.js");
    const fake = makeFakePg({
      throwOnQuery: Object.assign(new Error("auth fail"), { code: "28P01" }),
    });
    __setPgModuleForTest(fake.pg);
    const r = await handlePostgresConnect(
      JSON.stringify({
        host: "localhost",
        database: "db",
        user: "u",
        password: "p",
      }),
    );
    expect(r.status).toBe(401);
    expect(loadTokens()).toBeNull();
  });
});
