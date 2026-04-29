/**
 * PagerDuty tools — read incidents, services, and on-call rotations.
 *
 * Self-registering tool module for the recipe tool registry. Read-only this PR;
 * write methods (createIncident / ack / resolve) are deferred.
 *
 * Each tool wraps connector throws into the `{count, items, error}` shape that
 * the runner's silent-fail detector (PR #75) catches as a step error rather
 * than a silent empty list.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// pagerduty.list_incidents
// ============================================================================

registerTool({
  id: "pagerduty.list_incidents",
  namespace: "pagerduty",
  description:
    "List PagerDuty incidents, optionally filtered by status, urgency, and time range.",
  paramsSchema: {
    type: "object",
    properties: {
      statuses: {
        type: "array",
        items: { type: "string" },
        description:
          'Filter by incident status (e.g. ["triggered", "acknowledged", "resolved"])',
      },
      urgencies: {
        type: "array",
        items: { type: "string" },
        description: 'Filter by urgency (e.g. ["high", "low"])',
      },
      since: {
        type: "string",
        description: "ISO 8601 lower bound on created_at",
      },
      until: {
        type: "string",
        description: "ISO 8601 upper bound on created_at",
      },
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      items: { type: "array", items: { type: "object" } },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPagerDutyConnector } = await import(
      "../../connectors/pagerduty.js"
    );
    const limit = typeof params.max === "number" ? params.max : 25;
    try {
      const connector = getPagerDutyConnector();
      const { incidents } = await connector.listIncidents({
        statuses: Array.isArray(params.statuses)
          ? (params.statuses as string[])
          : undefined,
        urgencies: Array.isArray(params.urgencies)
          ? (params.urgencies as string[])
          : undefined,
        since: typeof params.since === "string" ? params.since : undefined,
        until: typeof params.until === "string" ? params.until : undefined,
        limit,
      });
      return JSON.stringify({ count: incidents.length, items: incidents });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        items: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// pagerduty.get_incident
// ============================================================================

registerTool({
  id: "pagerduty.get_incident",
  namespace: "pagerduty",
  description: "Fetch a single PagerDuty incident by id (e.g. 'PXXXX').",
  paramsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "PagerDuty incident id" },
      into: CommonSchemas.into,
    },
    required: ["id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      items: { type: "array", items: { type: "object" } },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPagerDutyConnector } = await import(
      "../../connectors/pagerduty.js"
    );
    try {
      const connector = getPagerDutyConnector();
      const incident = await connector.getIncident(params.id as string);
      return JSON.stringify({ count: 1, items: [incident] });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        items: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// pagerduty.list_services
// ============================================================================

registerTool({
  id: "pagerduty.list_services",
  namespace: "pagerduty",
  description: "List PagerDuty services (technical components paged by PD).",
  paramsSchema: {
    type: "object",
    properties: {
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      items: { type: "array", items: { type: "object" } },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPagerDutyConnector } = await import(
      "../../connectors/pagerduty.js"
    );
    const limit = typeof params.max === "number" ? params.max : 25;
    try {
      const connector = getPagerDutyConnector();
      const { services } = await connector.listServices({ limit });
      return JSON.stringify({ count: services.length, items: services });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        items: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// pagerduty.list_on_calls
// ============================================================================

registerTool({
  id: "pagerduty.list_on_calls",
  namespace: "pagerduty",
  description:
    "List current PagerDuty on-call assignments, optionally filtered by schedule ids.",
  paramsSchema: {
    type: "object",
    properties: {
      scheduleIds: {
        type: "array",
        items: { type: "string" },
        description: "Restrict results to these schedule ids",
      },
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      items: { type: "array", items: { type: "object" } },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPagerDutyConnector } = await import(
      "../../connectors/pagerduty.js"
    );
    const limit = typeof params.max === "number" ? params.max : 25;
    try {
      const connector = getPagerDutyConnector();
      const { oncalls } = await connector.listOnCalls({
        scheduleIds: Array.isArray(params.scheduleIds)
          ? (params.scheduleIds as string[])
          : undefined,
        limit,
      });
      return JSON.stringify({ count: oncalls.length, items: oncalls });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        items: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
