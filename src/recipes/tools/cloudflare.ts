/**
 * Cloudflare tools — read wrappers (list_zones, list_dns_records,
 * get_zone_analytics) plus a single write (create_dns_record).
 *
 * Self-registering tool module for the recipe tool registry. Each tool mirrors
 * the real connector signature in `src/connectors/cloudflare.ts` and returns
 * `JSON.stringify(result)` of the connector's native return type.
 *
 * Deliberately excludes destructive operations: no delete_dns_record,
 * update_dns_record, or purge_cache. Only create_dns_record is write-gated
 * (`isWrite: true`); the rest declare `isWrite: false`.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// cloudflare.list_zones
// ============================================================================

registerTool({
  id: "cloudflare.list_zones",
  namespace: "cloudflare",
  description:
    "List Cloudflare zones, optionally filtered by exact zone name (domain).",
  paramsSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Filter by exact zone name (e.g. example.com)",
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
        id: { type: "string" },
        name: { type: "string" },
        status: { type: "string" },
        nameservers: { type: "array", items: { type: "string" } },
        plan: { type: "object", properties: { name: { type: "string" } } },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getCloudflareConnector } = await import(
      "../../connectors/cloudflare.js"
    );
    const connector = getCloudflareConnector();
    const result = await connector.listZones(
      typeof params.name === "string" ? params.name : undefined,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// cloudflare.list_dns_records
// ============================================================================

registerTool({
  id: "cloudflare.list_dns_records",
  namespace: "cloudflare",
  description:
    "List DNS records in a Cloudflare zone, optionally filtered by record type and name.",
  paramsSchema: {
    type: "object",
    properties: {
      zoneId: {
        type: "string",
        description: "Cloudflare zone ID",
      },
      type: {
        type: "string",
        description: "Filter by DNS record type (e.g. A, AAAA, CNAME, TXT, MX)",
      },
      name: {
        type: "string",
        description: "Filter by record name (e.g. www.example.com)",
      },
      into: CommonSchemas.into,
    },
    required: ["zoneId"],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        type: { type: "string" },
        name: { type: "string" },
        content: { type: "string" },
        ttl: { type: "number" },
        proxied: { type: "boolean" },
        proxiable: { type: "boolean" },
        created_on: { type: "string" },
        modified_on: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getCloudflareConnector } = await import(
      "../../connectors/cloudflare.js"
    );
    const connector = getCloudflareConnector();
    const result = await connector.listDnsRecords(
      params.zoneId as string,
      typeof params.type === "string" ? params.type : undefined,
      typeof params.name === "string" ? params.name : undefined,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// cloudflare.create_dns_record  (write-gated)
// ============================================================================

registerTool({
  id: "cloudflare.create_dns_record",
  namespace: "cloudflare",
  description:
    "Create a DNS record in a Cloudflare zone. Requires zoneId, type, name, and content.",
  paramsSchema: {
    type: "object",
    properties: {
      zoneId: {
        type: "string",
        description: "Cloudflare zone ID",
      },
      type: {
        type: "string",
        description: "DNS record type (e.g. A, AAAA, CNAME, TXT, MX)",
      },
      name: {
        type: "string",
        description: "Record name (e.g. www.example.com)",
      },
      content: {
        type: "string",
        description: "Record content (e.g. 192.0.2.1 for an A record)",
      },
      ttl: {
        type: "number",
        description: "Time-to-live in seconds (1 = automatic)",
      },
      proxied: {
        type: "boolean",
        description: "Whether the record is proxied through Cloudflare",
      },
      into: CommonSchemas.into,
    },
    required: ["zoneId", "type", "name", "content"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      type: { type: "string" },
      name: { type: "string" },
      content: { type: "string" },
      ttl: { type: "number" },
      proxied: { type: "boolean" },
      proxiable: { type: "boolean" },
      created_on: { type: "string" },
      modified_on: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getCloudflareConnector } = await import(
      "../../connectors/cloudflare.js"
    );
    const connector = getCloudflareConnector();
    const result = await connector.createDnsRecord(
      params.zoneId as string,
      params.type as string,
      params.name as string,
      params.content as string,
      typeof params.ttl === "number" ? params.ttl : undefined,
      typeof params.proxied === "boolean" ? params.proxied : undefined,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// cloudflare.get_zone_analytics
// ============================================================================

registerTool({
  id: "cloudflare.get_zone_analytics",
  namespace: "cloudflare",
  description:
    "Fetch dashboard analytics for a Cloudflare zone over an optional time window.",
  paramsSchema: {
    type: "object",
    properties: {
      zoneId: {
        type: "string",
        description: "Cloudflare zone ID",
      },
      since: {
        type: "string",
        description:
          "Start of the window (RFC3339 timestamp or relative, e.g. -10080 minutes)",
      },
      until: {
        type: "string",
        description: "End of the window (RFC3339 timestamp or relative)",
      },
      into: CommonSchemas.into,
    },
    required: ["zoneId"],
  },
  outputSchema: {
    type: "object",
    description: "Cloudflare zone analytics dashboard payload (free-form).",
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getCloudflareConnector } = await import(
      "../../connectors/cloudflare.js"
    );
    const connector = getCloudflareConnector();
    const result = await connector.getZoneAnalytics(
      params.zoneId as string,
      typeof params.since === "string" ? params.since : undefined,
      typeof params.until === "string" ? params.until : undefined,
    );
    return JSON.stringify(result);
  },
});
