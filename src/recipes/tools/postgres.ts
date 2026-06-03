/**
 * Postgres tools — read-only schema introspection plus an arbitrary-SQL query
 * step.
 *
 * Self-registering tool module for the recipe tool registry. Wraps the Postgres
 * connector's `listTables` / `describeTable` schema reads, the `query` SQL
 * runner, and the `explain` query-plan endpoint.
 *
 * The connector enforces a read-only-statement guard (SELECT / SHOW / EXPLAIN /
 * WITH) at runtime, but `postgres.query` runs ARBITRARY SQL supplied by the
 * recipe author, so it is declared `isWrite: true` so the approval queue gates
 * it appropriately. The schema-introspection reads (`list_tables`,
 * `describe_table`) and `explain` are non-mutating, so they are `isWrite: false`.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// postgres.list_tables
// ============================================================================

registerTool({
  id: "postgres.list_tables",
  namespace: "postgres",
  description:
    "List Postgres tables, optionally restricted to a single schema. Excludes the pg_catalog / information_schema system schemas.",
  paramsSchema: {
    type: "object",
    properties: {
      schema: {
        type: "string",
        description: "Optional schema name to restrict results to",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        table_schema: { type: "string" },
        table_name: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPostgresConnector } = await import(
      "../../connectors/postgres.js"
    );
    const connector = getPostgresConnector();
    const result = await connector.listTables(
      typeof params.schema === "string" ? params.schema : undefined,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// postgres.describe_table
// ============================================================================

registerTool({
  id: "postgres.describe_table",
  namespace: "postgres",
  description:
    "Describe the columns of a Postgres table (name, data type, nullability, default). Defaults to the public schema.",
  paramsSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Table name to describe",
      },
      schema: {
        type: "string",
        description: "Schema the table lives in (default public)",
      },
      into: CommonSchemas.into,
    },
    required: ["table"],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        column_name: { type: "string" },
        data_type: { type: "string" },
        is_nullable: { type: "string" },
        column_default: { type: ["string", "null"] },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPostgresConnector } = await import(
      "../../connectors/postgres.js"
    );
    const connector = getPostgresConnector();
    const result = await connector.describeTable(
      params.table as string,
      typeof params.schema === "string" ? params.schema : undefined,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// postgres.query  (write-gated)
// ============================================================================

registerTool({
  id: "postgres.query",
  namespace: "postgres",
  description:
    "Run an ARBITRARY SQL statement against Postgres. The connector enforces a read-only guard (SELECT / SHOW / EXPLAIN / WITH) at runtime, but because the SQL is author-supplied this step is treated as a write and is gated by the approval queue. Supports positional bind parameters and a row-count cap.",
  paramsSchema: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description: "SQL statement to execute (read-only statements only)",
      },
      params: {
        type: "array",
        description: "Positional bind parameters for the statement ($1, $2, …)",
        items: {},
      },
      rowLimit: {
        type: "number",
        description:
          "Maximum number of rows to return (default 100, max 10000)",
        default: 100,
      },
      into: CommonSchemas.into,
    },
    required: ["sql"],
  },
  outputSchema: {
    type: "object",
    properties: {
      rows: { type: "array", items: { type: "object" } },
      rowCount: { type: "number" },
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            dataTypeID: { type: "number" },
          },
        },
      },
      truncated: { type: "boolean" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPostgresConnector } = await import(
      "../../connectors/postgres.js"
    );
    const connector = getPostgresConnector();
    const result = await connector.query(
      params.sql as string,
      Array.isArray(params.params) ? params.params : undefined,
      typeof params.rowLimit === "number" ? params.rowLimit : undefined,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// postgres.explain
// ============================================================================

registerTool({
  id: "postgres.explain",
  namespace: "postgres",
  description:
    "Return the JSON query plan for a read-only SQL statement via EXPLAIN (FORMAT JSON). Does not execute the statement's effects.",
  paramsSchema: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description: "SQL statement to explain (read-only statements only)",
      },
      into: CommonSchemas.into,
    },
    required: ["sql"],
  },
  outputSchema: {
    type: "object",
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPostgresConnector } = await import(
      "../../connectors/postgres.js"
    );
    const connector = getPostgresConnector();
    const result = await connector.explain(params.sql as string);
    return JSON.stringify(result);
  },
});
