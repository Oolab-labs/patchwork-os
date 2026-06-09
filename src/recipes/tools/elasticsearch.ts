/**
 * Elasticsearch tools — read-only access to ES clusters via the elasticsearch
 * connector (search, count, list indices, cluster health).
 *
 * Self-registering tool module for the recipe tool registry. Every tool is a
 * faithful pass-through to the connector method: positional params mapped from
 * the rendered step params, and the raw connector return type JSON-stringified
 * back out. All four tools are read-only (`isWrite: false`) — the connector
 * itself rejects scripted queries at any depth (see `isReadOnlyEsQuery`).
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { wrapConnectorExecute } from "./wrapConnectorExecute.js";

// ============================================================================
// elasticsearch.search
// ============================================================================

registerTool({
  id: "elasticsearch.search",
  namespace: "elasticsearch",
  description:
    "Run a read-only Elasticsearch search against an index. The query body is a standard ES query DSL object; scripted queries are rejected by the connector.",
  paramsSchema: {
    type: "object",
    properties: {
      index: {
        type: "string",
        description: "Index name (or comma-separated indices / pattern)",
      },
      query: {
        type: "object",
        description: "Elasticsearch query DSL body (e.g. { match_all: {} })",
      },
      size: {
        type: "number",
        description: "Max hits to return (default 10, capped at 100)",
        default: 10,
      },
      from: {
        type: "number",
        description: "Offset of the first hit to return (default 0)",
        default: 0,
      },
      sort: {
        description: "Optional sort clause (ES sort syntax)",
      },
      _source: {
        description: "Optional _source filtering (field list or boolean)",
      },
      into: CommonSchemas.into,
    },
    required: ["index", "query"],
  },
  outputSchema: {
    type: "object",
    description: "Raw Elasticsearch search response",
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getElasticsearchConnector } = await import(
      "../../connectors/elasticsearch.js"
    );
    const connector = getElasticsearchConnector();
    const result = await connector.search(
      params.index as string,
      params.query as Record<string, unknown>,
      typeof params.size === "number" ? params.size : undefined,
      typeof params.from === "number" ? params.from : undefined,
      params.sort,
      params._source,
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// elasticsearch.count
// ============================================================================

registerTool({
  id: "elasticsearch.count",
  namespace: "elasticsearch",
  description:
    "Count documents in an Elasticsearch index, optionally filtered by a query DSL body. Scripted queries are rejected by the connector.",
  paramsSchema: {
    type: "object",
    properties: {
      index: {
        type: "string",
        description: "Index name (or comma-separated indices / pattern)",
      },
      query: {
        type: "object",
        description:
          "Optional Elasticsearch query DSL body to filter the count",
      },
      into: CommonSchemas.into,
    },
    required: ["index"],
  },
  outputSchema: {
    type: "object",
    description: "Raw Elasticsearch count response (includes `count`)",
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getElasticsearchConnector } = await import(
      "../../connectors/elasticsearch.js"
    );
    const connector = getElasticsearchConnector();
    const result = await connector.count(
      params.index as string,
      params.query as Record<string, unknown> | undefined,
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// elasticsearch.list_indices
// ============================================================================

registerTool({
  id: "elasticsearch.list_indices",
  namespace: "elasticsearch",
  description:
    "List Elasticsearch indices with doc count, store size, and health (cat indices, JSON format).",
  paramsSchema: {
    type: "object",
    properties: {
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    description: "Raw cat-indices response (array of index summaries)",
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async () => {
    const { getElasticsearchConnector } = await import(
      "../../connectors/elasticsearch.js"
    );
    const connector = getElasticsearchConnector();
    const result = await connector.listIndices();
    return JSON.stringify(result);
  }),
});

// ============================================================================
// elasticsearch.cluster_health
// ============================================================================

registerTool({
  id: "elasticsearch.cluster_health",
  namespace: "elasticsearch",
  description:
    "Fetch Elasticsearch cluster health (status, node counts, shard stats).",
  paramsSchema: {
    type: "object",
    properties: {
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    description: "Raw cluster-health response",
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async () => {
    const { getElasticsearchConnector } = await import(
      "../../connectors/elasticsearch.js"
    );
    const connector = getElasticsearchConnector();
    const result = await connector.clusterHealth();
    return JSON.stringify(result);
  }),
});
