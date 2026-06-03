/**
 * Redis tools — read-only access to keys, hashes, and server info.
 *
 * Self-registering tool module for the recipe tool registry. Every tool here
 * wraps a read command on the Redis connector (which is itself read-only — it
 * exposes no SET/DEL/FLUSHDB/CONFIG mutators). Tools declare `isWrite: false`
 * so the approval queue treats them as low-risk reads.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// redis.get
// ============================================================================

registerTool({
  id: "redis.get",
  namespace: "redis",
  description:
    "Read the string value at a Redis key (GET). Returns null if the key does not exist.",
  paramsSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Redis key to read" },
      into: CommonSchemas.into,
    },
    required: ["key"],
  },
  outputSchema: {
    type: ["string", "null"],
    description: "The string value at the key, or null if absent",
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getRedisConnector } = await import("../../connectors/redis.js");
    const connector = getRedisConnector();
    const result = await connector.get(params.key as string);
    return JSON.stringify(result);
  },
});

// ============================================================================
// redis.keys
// ============================================================================

registerTool({
  id: "redis.keys",
  namespace: "redis",
  description:
    "List Redis keys matching a glob pattern (SCAN-based; never blocks the server). Capped by limit.",
  paramsSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern to match keys (e.g. 'user:*')",
      },
      limit: {
        type: "number",
        description: "Max number of keys to return (default 100, max 10000)",
        default: 100,
      },
      into: CommonSchemas.into,
    },
    required: ["pattern"],
  },
  outputSchema: {
    type: "array",
    items: { type: "string" },
    description: "Matching keys",
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getRedisConnector } = await import("../../connectors/redis.js");
    const connector = getRedisConnector();
    const result = await connector.keys(
      params.pattern as string,
      typeof params.limit === "number" ? params.limit : undefined,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// redis.hgetall
// ============================================================================

registerTool({
  id: "redis.hgetall",
  namespace: "redis",
  description:
    "Read all fields and values of a Redis hash (HGETALL). Returns an empty object if the key does not exist.",
  paramsSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Redis hash key to read" },
      into: CommonSchemas.into,
    },
    required: ["key"],
  },
  outputSchema: {
    type: "object",
    additionalProperties: { type: "string" },
    description: "Field/value map of the hash",
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getRedisConnector } = await import("../../connectors/redis.js");
    const connector = getRedisConnector();
    const result = await connector.hgetall(params.key as string);
    return JSON.stringify(result);
  },
});

// ============================================================================
// redis.info
// ============================================================================

registerTool({
  id: "redis.info",
  namespace: "redis",
  description:
    "Read Redis server info (INFO), parsed into a flat key/value map. Optionally scoped to a single section (e.g. 'memory', 'replication').",
  paramsSchema: {
    type: "object",
    properties: {
      section: {
        type: "string",
        description:
          "Optional INFO section to scope to (e.g. 'server', 'memory', 'replication')",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    additionalProperties: { type: "string" },
    description: "Parsed INFO key/value pairs",
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getRedisConnector } = await import("../../connectors/redis.js");
    const connector = getRedisConnector();
    const result = await connector.info(
      typeof params.section === "string" ? params.section : undefined,
    );
    return JSON.stringify(result);
  },
});
