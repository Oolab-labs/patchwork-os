/**
 * Datadog tools — query metrics, monitors, alerts, and incidents.
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { assertWriteAllowed } from "../../featureFlags.js";
import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// datadog.queryMetrics
// ============================================================================

registerTool({
  id: "datadog.queryMetrics",
  namespace: "datadog",
  description:
    "Query Datadog metrics for a time range. Returns time series data.",
  paramsSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'Datadog metrics query string (e.g. "avg:system.cpu.user{*}")',
      },
      from: {
        type: "number",
        description: "Start of the query window (Unix timestamp, seconds)",
      },
      to: {
        type: "number",
        description: "End of the query window (Unix timestamp, seconds)",
      },
      into: CommonSchemas.into,
    },
    required: ["query", "from", "to"],
  },
  outputSchema: {
    type: "object",
    properties: {
      series: { type: "array", items: { type: "object" } },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getDatadogConnector } = await import("../../connectors/datadog.js");
    const connector = getDatadogConnector();
    const result = await connector.queryMetrics(
      params.query as string,
      params.from as number,
      params.to as number,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// datadog.listMonitors
// ============================================================================

registerTool({
  id: "datadog.listMonitors",
  namespace: "datadog",
  description: "List Datadog monitors, optionally filtered by tags.",
  paramsSchema: {
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: { type: "string" },
        description: 'Filter monitors by tags (e.g. ["env:prod", "team:ops"])',
      },
      perPage: {
        type: "number",
        description: "Results per page (default 100)",
        default: 100,
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      monitors: { type: "array", items: { type: "object" } },
      count: { type: "number" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getDatadogConnector } = await import("../../connectors/datadog.js");
    const connector = getDatadogConnector();
    const monitors = await connector.listMonitors({
      tags: Array.isArray(params.tags) ? (params.tags as string[]) : undefined,
      perPage: typeof params.perPage === "number" ? params.perPage : undefined,
    });
    return JSON.stringify({ monitors, count: monitors.length });
  },
});

// ============================================================================
// datadog.getMonitor
// ============================================================================

registerTool({
  id: "datadog.getMonitor",
  namespace: "datadog",
  description: "Fetch a single Datadog monitor by ID.",
  paramsSchema: {
    type: "object",
    properties: {
      monitorId: { type: "number", description: "Datadog monitor ID" },
      into: CommonSchemas.into,
    },
    required: ["monitorId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
      name: { type: "string" },
      status: { type: "string" },
      overall_state: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getDatadogConnector } = await import("../../connectors/datadog.js");
    const connector = getDatadogConnector();
    const monitor = await connector.getMonitor(params.monitorId as number);
    return JSON.stringify(monitor);
  },
});

// ============================================================================
// datadog.listActiveAlerts
// ============================================================================

registerTool({
  id: "datadog.listActiveAlerts",
  namespace: "datadog",
  description:
    "List Datadog monitors currently in Alert or Warn state (active incidents).",
  paramsSchema: {
    type: "object",
    properties: {
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      alerts: { type: "array", items: { type: "object" } },
      count: { type: "number" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params: _ }) => {
    const { getDatadogConnector } = await import("../../connectors/datadog.js");
    const connector = getDatadogConnector();
    const alerts = await connector.listActiveAlerts();
    return JSON.stringify({ alerts, count: alerts.length });
  },
});

// ============================================================================
// datadog.muteMonitor
// ============================================================================

registerTool({
  id: "datadog.muteMonitor",
  namespace: "datadog",
  description:
    "Mute a Datadog monitor to suppress alerts. Optionally specify when the mute expires.",
  paramsSchema: {
    type: "object",
    properties: {
      monitorId: { type: "number", description: "Datadog monitor ID" },
      end: {
        type: "number",
        description:
          "Unix timestamp when the mute expires (optional). If omitted, muted indefinitely.",
      },
      into: CommonSchemas.into,
    },
    required: ["monitorId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
      name: { type: "string" },
      overall_state: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    assertWriteAllowed("datadog.muteMonitor");
    const { getDatadogConnector } = await import("../../connectors/datadog.js");
    const connector = getDatadogConnector();
    const monitor = await connector.muteMonitor(
      params.monitorId as number,
      typeof params.end === "number" ? params.end : undefined,
    );
    return JSON.stringify({
      id: monitor.id,
      name: monitor.name,
      overall_state: monitor.overall_state,
    });
  },
});

// ============================================================================
// datadog.listIncidents
// ============================================================================

registerTool({
  id: "datadog.listIncidents",
  namespace: "datadog",
  description: "List Datadog incidents.",
  paramsSchema: {
    type: "object",
    properties: {
      perPage: {
        type: "number",
        description: "Results per page (default 10)",
        default: 10,
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      data: { type: "array", items: { type: "object" } },
      count: { type: "number" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getDatadogConnector } = await import("../../connectors/datadog.js");
    const connector = getDatadogConnector();
    const result = await connector.listIncidents({
      perPage: typeof params.perPage === "number" ? params.perPage : undefined,
    });
    return JSON.stringify({ data: result.data, count: result.data.length });
  },
});
