/**
 * Airtable tools — record access via the Airtable REST API v0.
 *
 * Self-registering tool module for the recipe tool registry. Read tools
 * (list_records, get_record, list_bases) declare `isWrite: false`; the write
 * tool (create_record) declares `isWrite: true` so the approval queue and
 * kill-switch gate it appropriately.
 *
 * Mirrors the `AirtableConnector` method signatures exactly:
 *   - listRecords(baseId, tableIdOrName, params?)
 *   - getRecord(baseId, tableIdOrName, recordId)
 *   - createRecord(baseId, tableIdOrName, fields)
 *   - listBases()
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { wrapConnectorExecute } from "./wrapConnectorExecute.js";

// ============================================================================
// airtable.list_records
// ============================================================================

registerTool({
  id: "airtable.list_records",
  namespace: "airtable",
  description:
    "List records from an Airtable table, with optional filter formula, view, sort, field selection, and paging.",
  paramsSchema: {
    type: "object",
    properties: {
      baseId: {
        type: "string",
        description: "Airtable base id (app...)",
      },
      tableIdOrName: {
        type: "string",
        description: "Airtable table id (tbl...) or table name",
      },
      filterByFormula: {
        type: "string",
        description: "Airtable formula to filter records server-side",
      },
      view: {
        type: "string",
        description: "Restrict results to a named view",
      },
      maxRecords: {
        type: "number",
        description: "Max records to return (default 100, hard cap 1000)",
      },
      pageSize: {
        type: "number",
        description: "Records per page (max 100)",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Restrict returned fields to this list",
      },
      sort: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["field"],
        },
        description: "Sort directives, applied in order",
      },
      into: CommonSchemas.into,
    },
    required: ["baseId", "tableIdOrName"],
  },
  outputSchema: {
    type: "object",
    properties: {
      records: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            createdTime: { type: "string" },
            fields: { type: "object" },
          },
        },
      },
      offset: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getAirtableConnector } = await import(
      "../../connectors/airtable.js"
    );
    const connector = getAirtableConnector();
    const result = await connector.listRecords(
      params.baseId as string,
      params.tableIdOrName as string,
      {
        filterByFormula:
          typeof params.filterByFormula === "string"
            ? params.filterByFormula
            : undefined,
        view: typeof params.view === "string" ? params.view : undefined,
        maxRecords:
          typeof params.maxRecords === "number" ? params.maxRecords : undefined,
        pageSize:
          typeof params.pageSize === "number" ? params.pageSize : undefined,
        fields: Array.isArray(params.fields)
          ? (params.fields as string[])
          : undefined,
        sort: Array.isArray(params.sort)
          ? (params.sort as Array<{
              field: string;
              direction?: "asc" | "desc";
            }>)
          : undefined,
      },
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// airtable.get_record
// ============================================================================

registerTool({
  id: "airtable.get_record",
  namespace: "airtable",
  description: "Fetch a single Airtable record by id.",
  paramsSchema: {
    type: "object",
    properties: {
      baseId: {
        type: "string",
        description: "Airtable base id (app...)",
      },
      tableIdOrName: {
        type: "string",
        description: "Airtable table id (tbl...) or table name",
      },
      recordId: {
        type: "string",
        description: "Airtable record id (rec...)",
      },
      into: CommonSchemas.into,
    },
    required: ["baseId", "tableIdOrName", "recordId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      createdTime: { type: "string" },
      fields: { type: "object" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getAirtableConnector } = await import(
      "../../connectors/airtable.js"
    );
    const connector = getAirtableConnector();
    const result = await connector.getRecord(
      params.baseId as string,
      params.tableIdOrName as string,
      params.recordId as string,
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// airtable.create_record  (write-gated)
// ============================================================================

registerTool({
  id: "airtable.create_record",
  namespace: "airtable",
  description: "Create a single record in an Airtable table.",
  paramsSchema: {
    type: "object",
    properties: {
      baseId: {
        type: "string",
        description: "Airtable base id (app...)",
      },
      tableIdOrName: {
        type: "string",
        description: "Airtable table id (tbl...) or table name",
      },
      fields: {
        type: "object",
        description:
          "Field values for the new record, keyed by Airtable field name or id",
      },
      into: CommonSchemas.into,
    },
    required: ["baseId", "tableIdOrName", "fields"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      createdTime: { type: "string" },
      fields: { type: "object" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getAirtableConnector } = await import(
      "../../connectors/airtable.js"
    );
    const connector = getAirtableConnector();
    const result = await connector.createRecord(
      params.baseId as string,
      params.tableIdOrName as string,
      (params.fields as Record<string, unknown>) ?? {},
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// airtable.list_bases
// ============================================================================

registerTool({
  id: "airtable.list_bases",
  namespace: "airtable",
  description: "List Airtable bases the authenticated token can access.",
  paramsSchema: {
    type: "object",
    properties: {
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      bases: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            permissionLevel: { type: "string" },
          },
        },
      },
      offset: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async () => {
    const { getAirtableConnector } = await import(
      "../../connectors/airtable.js"
    );
    const connector = getAirtableConnector();
    const result = await connector.listBases();
    return JSON.stringify(result);
  }),
});
