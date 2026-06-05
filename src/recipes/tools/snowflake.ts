/**
 * Snowflake tools — read wrappers (list_tables, describe_table, list_databases)
 * plus a write-gated execute_query.
 *
 * Self-registering tool module for the recipe tool registry. Wraps the
 * Snowflake connector's SQL REST API methods. Every method resolves to a
 * `SnowflakeQueryResult` (`{ statementHandle?, columns, rows, rowCount,
 * truncated }`), which is JSON-stringified back out.
 *
 * `execute_query` runs an ARBITRARY SQL statement supplied by the recipe
 * author. The connector enforces read-only SQL at runtime (SELECT / SHOW /
 * DESC / DESCRIBE / EXPLAIN / WITH only), but because the statement is
 * caller-controlled and could in principle mutate state, the tool is declared
 * `isWrite: true` so the approval queue gates it.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { wrapConnectorExecute } from "./wrapConnectorExecute.js";

// Shared output schema — every Snowflake connector method resolves to a
// SnowflakeQueryResult (see src/connectors/snowflake.ts).
const queryResultSchema = {
  type: "object",
  properties: {
    statementHandle: { type: "string" },
    columns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          nullable: { type: "boolean" },
          length: { type: "number" },
          precision: { type: "number" },
          scale: { type: "number" },
        },
      },
    },
    rows: {
      type: "array",
      items: { type: "array", items: { type: "string" } },
    },
    rowCount: { type: "number" },
    truncated: { type: "boolean" },
  },
} as const;

// ============================================================================
// snowflake.list_tables
// ============================================================================

registerTool({
  id: "snowflake.list_tables",
  namespace: "snowflake",
  description:
    "List tables in Snowflake (SHOW TABLES), optionally scoped to a database and/or schema.",
  paramsSchema: {
    type: "object",
    properties: {
      database: {
        type: "string",
        description: "Optional database to scope the listing to",
      },
      schema: {
        type: "string",
        description: "Optional schema to scope the listing to",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: queryResultSchema,
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getSnowflakeConnector } = await import(
      "../../connectors/snowflake.js"
    );
    const connector = getSnowflakeConnector();
    const result = await connector.listTables(
      typeof params.database === "string" ? params.database : undefined,
      typeof params.schema === "string" ? params.schema : undefined,
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// snowflake.describe_table
// ============================================================================

registerTool({
  id: "snowflake.describe_table",
  namespace: "snowflake",
  description:
    "Describe a Snowflake table's columns (DESCRIBE TABLE database.schema.table).",
  paramsSchema: {
    type: "object",
    properties: {
      database: { type: "string", description: "Database name" },
      schema: { type: "string", description: "Schema name" },
      table: { type: "string", description: "Table name" },
      into: CommonSchemas.into,
    },
    required: ["database", "schema", "table"],
  },
  outputSchema: queryResultSchema,
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getSnowflakeConnector } = await import(
      "../../connectors/snowflake.js"
    );
    const connector = getSnowflakeConnector();
    const result = await connector.describeTable(
      params.database as string,
      params.schema as string,
      params.table as string,
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// snowflake.list_databases
// ============================================================================

registerTool({
  id: "snowflake.list_databases",
  namespace: "snowflake",
  description:
    "List databases accessible to the connected Snowflake role (SHOW DATABASES).",
  paramsSchema: {
    type: "object",
    properties: {
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: queryResultSchema,
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async () => {
    const { getSnowflakeConnector } = await import(
      "../../connectors/snowflake.js"
    );
    const connector = getSnowflakeConnector();
    const result = await connector.listDatabases();
    return JSON.stringify(result);
  }),
});

// ============================================================================
// snowflake.execute_query  (write-gated)
// ============================================================================

registerTool({
  id: "snowflake.execute_query",
  namespace: "snowflake",
  description:
    "Execute an ARBITRARY SQL statement against Snowflake (read or write). " +
    "The statement is caller-supplied, so this tool is treated as a write and " +
    "gated by the approval queue. Optional positional parameters bind to '?' " +
    "placeholders; rowLimit caps returned rows (default 100, hard cap 1000).",
  paramsSchema: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description: "The SQL statement to execute",
      },
      params: {
        type: "array",
        description: "Optional positional parameters bound to '?' placeholders",
        items: {},
      },
      rowLimit: {
        type: "number",
        description: "Soft cap on returned rows (default 100, hard cap 1000)",
      },
      into: CommonSchemas.into,
    },
    required: ["sql"],
  },
  outputSchema: queryResultSchema,
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getSnowflakeConnector } = await import(
      "../../connectors/snowflake.js"
    );
    const connector = getSnowflakeConnector();
    const result = await connector.executeQuery(
      params.sql as string,
      Array.isArray(params.params) ? params.params : undefined,
      typeof params.rowLimit === "number" ? params.rowLimit : undefined,
    );
    return JSON.stringify(result);
  }),
});
