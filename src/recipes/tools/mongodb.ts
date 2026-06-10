/**
 * MongoDB recipe-step tools — read-only query surface.
 *
 * Self-registering tool module for the recipe tool registry. Like the other
 * module-function connectors (salesforce/monday/google-docs), src/connectors/
 * mongodb.ts exports standalone async functions rather than a getXConnector()
 * accessor, so each tool dynamically imports the function it wraps and
 * JSON-stringifies the raw return value.
 *
 * Every tool is read-only (`isWrite: false`): the connector enforces a
 * read-only-operation guard (`isReadOnlyMongoOp`) on filters/pipelines and
 * rejects mutating aggregation stages ($out/$merge/$function/$where), and the
 * result sets are limit-capped (default 100, hard cap 1000). There is no
 * insert/update/delete surface by design.
 *
 * Completes connector-step parity: mongodb was the last entry in
 * connector-step-parity-allowlist.json.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { wrapConnectorExecute } from "./wrapConnectorExecute.js";

// ============================================================================
// mongodb.list_databases
// ============================================================================

registerTool({
  id: "mongodb.list_databases",
  namespace: "mongodb",
  description: "List the database names available on the connected MongoDB.",
  paramsSchema: {
    type: "object",
    properties: {
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "array",
    items: { type: "string" },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async () => {
    const { listDatabases } = await import("../../connectors/mongodb.js");
    return JSON.stringify(await listDatabases());
  }),
});

// ============================================================================
// mongodb.list_collections
// ============================================================================

registerTool({
  id: "mongodb.list_collections",
  namespace: "mongodb",
  description: "List the collection names in a MongoDB database.",
  paramsSchema: {
    type: "object",
    properties: {
      database: {
        type: "string",
        description: "Database name to list collections from",
      },
      into: CommonSchemas.into,
    },
    required: ["database"],
  },
  outputSchema: {
    type: "array",
    items: { type: "string" },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { listCollections } = await import("../../connectors/mongodb.js");
    return JSON.stringify(await listCollections(params.database as string));
  }),
});

// ============================================================================
// mongodb.describe_collection
// ============================================================================

registerTool({
  id: "mongodb.describe_collection",
  namespace: "mongodb",
  description:
    "Describe a MongoDB collection: a sample document plus its index list.",
  paramsSchema: {
    type: "object",
    properties: {
      database: { type: "string", description: "Database name" },
      collection: { type: "string", description: "Collection name" },
      into: CommonSchemas.into,
    },
    required: ["database", "collection"],
  },
  outputSchema: {
    type: "object",
    properties: {
      sample: {},
      indexes: { type: "array" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { describeCollection } = await import("../../connectors/mongodb.js");
    return JSON.stringify(
      await describeCollection(
        params.database as string,
        params.collection as string,
      ),
    );
  }),
});

// ============================================================================
// mongodb.find
// ============================================================================

registerTool({
  id: "mongodb.find",
  namespace: "mongodb",
  description:
    "Run a read-only find() against a MongoDB collection. The filter and " +
    "projection are guarded against query operators that execute server-side " +
    "code; results are limit-capped (default 100, hard cap 1000).",
  paramsSchema: {
    type: "object",
    properties: {
      database: { type: "string", description: "Database name" },
      collection: { type: "string", description: "Collection name" },
      filter: {
        type: "object",
        description: "MongoDB query filter (read-only operators only)",
      },
      projection: {
        type: "object",
        description: "Optional field projection",
      },
      limit: {
        type: "number",
        description: "Max documents (default 100, hard cap 1000)",
      },
      into: CommonSchemas.into,
    },
    required: ["database", "collection"],
  },
  outputSchema: {
    type: "array",
    items: { type: "object" },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { find } = await import("../../connectors/mongodb.js");
    const result = await find(
      params.database as string,
      params.collection as string,
      (params.filter as Record<string, unknown>) ?? {},
      {
        projection: params.projection as Record<string, unknown> | undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      },
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// mongodb.aggregate
// ============================================================================

registerTool({
  id: "mongodb.aggregate",
  namespace: "mongodb",
  description:
    "Run a read-only aggregation pipeline against a MongoDB collection. " +
    "Mutating stages ($out/$merge/$function/$where/$accumulator) are rejected " +
    "and a $limit stage is appended (default 100, hard cap 1000).",
  paramsSchema: {
    type: "object",
    properties: {
      database: { type: "string", description: "Database name" },
      collection: { type: "string", description: "Collection name" },
      pipeline: {
        type: "array",
        items: { type: "object" },
        description: "Aggregation pipeline stages (read-only)",
      },
      limit: {
        type: "number",
        description: "Max documents (default 100, hard cap 1000)",
      },
      into: CommonSchemas.into,
    },
    required: ["database", "collection", "pipeline"],
  },
  outputSchema: {
    type: "array",
    items: { type: "object" },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { aggregate } = await import("../../connectors/mongodb.js");
    const result = await aggregate(
      params.database as string,
      params.collection as string,
      params.pipeline as Array<Record<string, unknown>>,
      typeof params.limit === "number" ? params.limit : undefined,
    );
    return JSON.stringify(result);
  }),
});
