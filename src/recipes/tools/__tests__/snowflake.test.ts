/**
 * Snowflake recipe-step tools — read wrappers (list_tables, describe_table,
 * list_databases) plus a write-gated execute_query that runs an arbitrary
 * (read-or-write) SQL statement.
 *
 * Mocks the Snowflake connector module so the self-registering tool module can
 * be imported and each tool exercised through the registry without network or
 * stored credentials. Asserts faithful param mapping into the connector calls
 * (mirroring the EXACT method signatures in src/connectors/snowflake.ts) and
 * that the raw `SnowflakeQueryResult` is JSON-stringified back out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

// ── Connector mock ───────────────────────────────────────────────────────────
// One shared connector object with spy methods. getSnowflakeConnector returns it.

const listTables = vi.fn();
const describeTable = vi.fn();
const listDatabases = vi.fn();
const executeQuery = vi.fn();

vi.mock("../../../connectors/snowflake.js", () => ({
  getSnowflakeConnector: () => ({
    listTables,
    describeTable,
    listDatabases,
    executeQuery,
  }),
}));

// Importing the module self-registers the tools into the shared registry.
import "../snowflake.js";

function makeContext(params: Record<string, unknown>) {
  return {
    params,
    step: {},
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    deps: {} as StepDeps,
  };
}

// A representative SnowflakeQueryResult — what every connector method resolves to.
const sampleResult = {
  statementHandle: "01ab-cdef",
  columns: [
    { name: "NAME", type: "TEXT", nullable: false },
    { name: "ROWS", type: "FIXED", nullable: true, precision: 38, scale: 0 },
  ],
  rows: [
    ["CUSTOMERS", "1024"],
    ["ORDERS", "8192"],
  ],
  rowCount: 2,
  truncated: false,
};

describe("snowflake recipe-step tools", () => {
  beforeEach(() => {
    listTables.mockReset();
    describeTable.mockReset();
    listDatabases.mockReset();
    executeQuery.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── registration metadata ──────────────────────────────────────────────────

  it("registers read tools as low risk / non-write", () => {
    for (const id of [
      "snowflake.list_tables",
      "snowflake.describe_table",
      "snowflake.list_databases",
    ]) {
      const tool = getTool(id);
      expect(tool, `tool ${id} should be registered`).toBeDefined();
      expect(tool?.namespace).toBe("snowflake");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    }
  });

  it("registers execute_query as a medium-risk write tool", () => {
    const tool = getTool("snowflake.execute_query");
    expect(tool).toBeDefined();
    expect(tool?.namespace).toBe("snowflake");
    expect(tool?.isWrite).toBe(true);
    expect(tool?.riskDefault).toBe("medium");
    expect(tool?.isConnector).toBe(true);
    expect(tool?.outputSchema).toBeDefined();
  });

  // ── snowflake.list_tables ───────────────────────────────────────────────────

  it("list_tables forwards database/schema and stringifies the result", async () => {
    listTables.mockResolvedValue(sampleResult);

    const tool = getTool("snowflake.list_tables");
    const out = await tool?.execute(
      makeContext({ database: "ANALYTICS", schema: "PUBLIC" }),
    );

    expect(listTables).toHaveBeenCalledWith("ANALYTICS", "PUBLIC");
    expect(out).toBe(JSON.stringify(sampleResult));
  });

  it("list_tables passes undefined for omitted / wrong-typed database and schema", async () => {
    listTables.mockResolvedValue(sampleResult);

    const tool = getTool("snowflake.list_tables");
    await tool?.execute(makeContext({ database: 123 }));

    expect(listTables).toHaveBeenCalledWith(undefined, undefined);
  });

  // ── snowflake.describe_table ────────────────────────────────────────────────

  it("describe_table forwards database/schema/table and stringifies the result", async () => {
    describeTable.mockResolvedValue(sampleResult);

    const tool = getTool("snowflake.describe_table");
    const out = await tool?.execute(
      makeContext({
        database: "ANALYTICS",
        schema: "PUBLIC",
        table: "CUSTOMERS",
      }),
    );

    expect(describeTable).toHaveBeenCalledWith(
      "ANALYTICS",
      "PUBLIC",
      "CUSTOMERS",
    );
    expect(out).toBe(JSON.stringify(sampleResult));
  });

  // ── snowflake.list_databases ────────────────────────────────────────────────

  it("list_databases calls the connector with no args and stringifies the result", async () => {
    listDatabases.mockResolvedValue(sampleResult);

    const tool = getTool("snowflake.list_databases");
    const out = await tool?.execute(makeContext({}));

    expect(listDatabases).toHaveBeenCalledWith();
    expect(out).toBe(JSON.stringify(sampleResult));
  });

  // ── snowflake.execute_query ─────────────────────────────────────────────────

  it("execute_query forwards sql/params/rowLimit and stringifies the result", async () => {
    executeQuery.mockResolvedValue(sampleResult);

    const tool = getTool("snowflake.execute_query");
    const out = await tool?.execute(
      makeContext({
        sql: "SELECT * FROM CUSTOMERS WHERE id = ?",
        params: ["42"],
        rowLimit: 50,
      }),
    );

    expect(executeQuery).toHaveBeenCalledWith(
      "SELECT * FROM CUSTOMERS WHERE id = ?",
      ["42"],
      50,
    );
    expect(out).toBe(JSON.stringify(sampleResult));
  });

  it("execute_query passes undefined for omitted / wrong-typed params and rowLimit", async () => {
    executeQuery.mockResolvedValue(sampleResult);

    const tool = getTool("snowflake.execute_query");
    await tool?.execute(
      makeContext({ sql: "SHOW DATABASES", params: "nope", rowLimit: "big" }),
    );

    expect(executeQuery).toHaveBeenCalledWith(
      "SHOW DATABASES",
      undefined,
      undefined,
    );
  });
});
