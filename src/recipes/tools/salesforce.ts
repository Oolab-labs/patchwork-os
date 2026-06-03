/**
 * Salesforce recipe-step tools — read wrappers (query, search, get_object)
 * plus a write-gated create_record.
 *
 * Self-registering tool module for the recipe tool registry. Unlike the
 * class-plus-accessor connectors, src/connectors/salesforce.ts exports a set
 * of standalone async functions (module-function pattern) — there is no
 * getSalesforceConnector(). Each tool dynamically imports the function it wraps
 * and JSON-stringifies the raw connector return value back out.
 *
 * Read tools (`query`, `searchSosl`, `getObject`) declare `isWrite: false`;
 * `create_record` declares `isWrite: true` so the approval queue gates the
 * mutation. The connector itself enforces SELECT-only SOQL and FIND-only SOSL,
 * and validates sObject / record-id shapes before issuing the call.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// salesforce.query  (SOQL — read)
// ============================================================================

registerTool({
  id: "salesforce.query",
  namespace: "salesforce",
  description:
    "Execute a SOQL SELECT query against Salesforce. The statement must start " +
    "with SELECT (enforced by the connector). An optional limit caps the page " +
    "size (default 200, hard cap 200).",
  paramsSchema: {
    type: "object",
    properties: {
      soql: {
        type: "string",
        description: "SOQL SELECT query (must start with SELECT)",
      },
      limit: {
        type: "number",
        description: "Optional page-size cap (default 200, hard cap 200)",
      },
      into: CommonSchemas.into,
    },
    required: ["soql"],
  },
  // SoqlQueryResult — see src/connectors/salesforce.ts.
  outputSchema: {
    type: "object",
    properties: {
      totalSize: { type: "number" },
      done: { type: "boolean" },
      records: {
        type: "array",
        items: { type: "object" },
      },
      nextRecordsUrl: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { query } = await import("../../connectors/salesforce.js");
    const result = await query(
      params.soql as string,
      typeof params.limit === "number" ? { limit: params.limit } : undefined,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// salesforce.search  (SOSL — read)
// ============================================================================

registerTool({
  id: "salesforce.search",
  namespace: "salesforce",
  description:
    "Execute a SOSL search against Salesforce. The statement must start with " +
    "FIND (enforced by the connector).",
  paramsSchema: {
    type: "object",
    properties: {
      sosl: {
        type: "string",
        description: "SOSL search expression (must start with FIND)",
      },
      into: CommonSchemas.into,
    },
    required: ["sosl"],
  },
  // SoslSearchResult — see src/connectors/salesforce.ts.
  outputSchema: {
    type: "object",
    properties: {
      searchRecords: {
        type: "array",
        items: { type: "object" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { searchSosl } = await import("../../connectors/salesforce.js");
    const result = await searchSosl(params.sosl as string);
    return JSON.stringify(result);
  },
});

// ============================================================================
// salesforce.get_object  (read)
// ============================================================================

registerTool({
  id: "salesforce.get_object",
  namespace: "salesforce",
  description:
    "Fetch a single Salesforce sObject record by its API name and record id " +
    "(e.g. object_name: 'Account', record_id: '001...').",
  paramsSchema: {
    type: "object",
    properties: {
      object_name: {
        type: "string",
        description: "sObject API name (e.g. 'Account', 'Contact')",
      },
      record_id: {
        type: "string",
        description: "Salesforce record id (15 or 18 chars)",
      },
      into: CommonSchemas.into,
    },
    required: ["object_name", "record_id"],
  },
  // getObject resolves to the raw sObject record (Record<string, unknown>).
  outputSchema: {
    type: "object",
    additionalProperties: true,
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getObject } = await import("../../connectors/salesforce.js");
    const result = await getObject(
      params.object_name as string,
      params.record_id as string,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// salesforce.create_record  (write-gated)
// ============================================================================

registerTool({
  id: "salesforce.create_record",
  namespace: "salesforce",
  description:
    "Create a new Salesforce sObject record. Supply the sObject API name and a " +
    "fields object mapping field API names to values.",
  paramsSchema: {
    type: "object",
    properties: {
      object_name: {
        type: "string",
        description: "sObject API name (e.g. 'Account', 'Contact', 'Lead')",
      },
      fields: {
        type: "object",
        description:
          "Field API names mapped to values (e.g. { Name: 'Acme', Industry: 'Tech' })",
        additionalProperties: true,
      },
      into: CommonSchemas.into,
    },
    required: ["object_name", "fields"],
  },
  // CreateRecordResult — see src/connectors/salesforce.ts.
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      success: { type: "boolean" },
      errors: { type: "array", items: {} },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { createRecord } = await import("../../connectors/salesforce.js");
    const fields =
      params.fields && typeof params.fields === "object"
        ? (params.fields as Record<string, unknown>)
        : {};
    const result = await createRecord(params.object_name as string, fields);
    return JSON.stringify(result);
  },
});
