/**
 * Postgres recipe-step tool tests.
 *
 * Mocks the postgres connector module so each tool's `execute` can be driven
 * without a live database or stored credentials, then fetches each registered
 * tool from the recipe tool registry by id and asserts:
 *   - the correct connector method is called with faithfully-mirrored args,
 *   - the JSON-stringified connector result is returned verbatim,
 *   - read/write + risk metadata is what the registry advertises.
 *
 * The tool modules `await import("../../connectors/postgres.js")` lazily, so the
 * mock target is resolved from THIS test file (three levels up to src/) and
 * vi.mock is hoisted automatically.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Connector mock ────────────────────────────────────────────────────────────

const listTables = vi.fn();
const describeTable = vi.fn();
const query = vi.fn();
const explain = vi.fn();

vi.mock("../../../connectors/postgres.js", () => ({
  getPostgresConnector: () => ({
    listTables,
    describeTable,
    query,
    explain,
  }),
}));

// Import AFTER the mock is declared so the self-registering module picks it up.
import "../postgres.js";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

/** Minimal ToolContext factory — tools only read `params`. */
function ctx(params: Record<string, unknown>) {
  return {
    params,
    step: {} as Record<string, unknown>,
    ctx: {} as RunContext,
    deps: {} as StepDeps,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("postgres recipe-step tools", () => {
  // ── postgres.list_tables ─────────────────────────────────────────────────────

  describe("postgres.list_tables", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("postgres.list_tables");
      expect(tool).toBeDefined();
      expect(tool?.namespace).toBe("postgres");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    });

    it("calls listTables(schema) and returns its JSON", async () => {
      const tables = [
        { table_schema: "public", table_name: "users" },
        { table_schema: "public", table_name: "orders" },
      ];
      listTables.mockResolvedValue(tables);

      const tool = getTool("postgres.list_tables");
      const out = await tool?.execute(ctx({ schema: "public" }));

      expect(listTables).toHaveBeenCalledWith("public");
      expect(out).toBe(JSON.stringify(tables));
    });

    it("passes undefined when schema is omitted / wrong-typed", async () => {
      listTables.mockResolvedValue([]);

      const tool = getTool("postgres.list_tables");
      await tool?.execute(ctx({ schema: 123 }));

      expect(listTables).toHaveBeenCalledWith(undefined);
    });
  });

  // ── postgres.describe_table ──────────────────────────────────────────────────

  describe("postgres.describe_table", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("postgres.describe_table");
      expect(tool).toBeDefined();
      expect(tool?.namespace).toBe("postgres");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    });

    it("calls describeTable(table, schema) and returns its JSON", async () => {
      const columns = [
        {
          column_name: "id",
          data_type: "integer",
          is_nullable: "NO",
          column_default: "nextval('users_id_seq')",
        },
      ];
      describeTable.mockResolvedValue(columns);

      const tool = getTool("postgres.describe_table");
      const out = await tool?.execute(
        ctx({ table: "users", schema: "analytics" }),
      );

      expect(describeTable).toHaveBeenCalledWith("users", "analytics");
      expect(out).toBe(JSON.stringify(columns));
    });

    it("passes undefined schema when omitted / wrong-typed", async () => {
      describeTable.mockResolvedValue([]);

      const tool = getTool("postgres.describe_table");
      await tool?.execute(ctx({ table: "users", schema: 7 }));

      expect(describeTable).toHaveBeenCalledWith("users", undefined);
    });
  });

  // ── postgres.query ───────────────────────────────────────────────────────────

  describe("postgres.query", () => {
    it("is registered as a write / medium risk / connector tool", () => {
      const tool = getTool("postgres.query");
      expect(tool).toBeDefined();
      expect(tool?.namespace).toBe("postgres");
      expect(tool?.isWrite).toBe(true);
      expect(tool?.riskDefault).toBe("medium");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    });

    it("calls query(sql, params, rowLimit) and returns its JSON", async () => {
      const result = {
        rows: [{ id: 1 }],
        rowCount: 1,
        fields: [{ name: "id", dataTypeID: 23 }],
        truncated: false,
      };
      query.mockResolvedValue(result);

      const tool = getTool("postgres.query");
      const out = await tool?.execute(
        ctx({
          sql: "SELECT id FROM users WHERE id = $1",
          params: [1],
          rowLimit: 50,
        }),
      );

      expect(query).toHaveBeenCalledWith(
        "SELECT id FROM users WHERE id = $1",
        [1],
        50,
      );
      expect(out).toBe(JSON.stringify(result));
    });

    it("passes undefined for omitted / wrong-typed params and rowLimit", async () => {
      query.mockResolvedValue({
        rows: [],
        rowCount: 0,
        fields: [],
        truncated: false,
      });

      const tool = getTool("postgres.query");
      await tool?.execute(
        ctx({ sql: "SELECT 1", params: "not-an-array", rowLimit: "nope" }),
      );

      expect(query).toHaveBeenCalledWith("SELECT 1", undefined, undefined);
    });
  });

  // ── postgres.explain ─────────────────────────────────────────────────────────

  describe("postgres.explain", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("postgres.explain");
      expect(tool).toBeDefined();
      expect(tool?.namespace).toBe("postgres");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    });

    it("calls explain(sql) and returns its JSON", async () => {
      const plan = [{ Plan: { "Node Type": "Seq Scan", "Total Cost": 1.05 } }];
      explain.mockResolvedValue(plan);

      const tool = getTool("postgres.explain");
      const out = await tool?.execute(ctx({ sql: "SELECT * FROM users" }));

      expect(explain).toHaveBeenCalledWith("SELECT * FROM users");
      expect(out).toBe(JSON.stringify(plan));
    });
  });
});
