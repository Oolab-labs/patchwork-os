/**
 * Grafana tools — read access to dashboards, alert rules, and datasource
 * queries, plus a single write (create_annotation).
 *
 * Self-registering tool module for the recipe tool registry. Each tool mirrors
 * the real connector signature in `src/connectors/grafana.ts` and returns
 * `JSON.stringify(result)` of the connector's native return type. Reads declare
 * `isWrite: false`; `create_annotation` declares `isWrite: true` so the approval
 * queue gates it appropriately.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// grafana.list_dashboards
// ============================================================================

registerTool({
  id: "grafana.list_dashboards",
  namespace: "grafana",
  description:
    "List Grafana dashboards, optionally filtered by a search query string.",
  paramsSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query to filter dashboards by title/tag",
      },
      limit: {
        type: "number",
        description: "Max number of dashboards to return (default 50)",
        default: 50,
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
        id: { type: "number" },
        uid: { type: "string" },
        title: { type: "string" },
        url: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        folderTitle: { type: "string" },
        folderId: { type: "number" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getGrafanaConnector } = await import("../../connectors/grafana.js");
    const connector = getGrafanaConnector();
    const result = await connector.getDashboards(
      typeof params.query === "string" ? params.query : undefined,
      typeof params.limit === "number" ? params.limit : undefined,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// grafana.list_alert_rules
// ============================================================================

registerTool({
  id: "grafana.list_alert_rules",
  namespace: "grafana",
  description: "List Grafana provisioned alert rules.",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max number of alert rules to return (default 100)",
        default: 100,
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
        uid: { type: "string" },
        title: { type: "string" },
        condition: { type: "string" },
        data: { type: "array", items: {} },
        intervalSeconds: { type: "number" },
        orgId: { type: "number" },
        namespaceUID: { type: "string" },
        ruleGroup: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getGrafanaConnector } = await import("../../connectors/grafana.js");
    const connector = getGrafanaConnector();
    const result = await connector.getAlertRules(
      typeof params.limit === "number" ? params.limit : undefined,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// grafana.create_annotation
// ============================================================================

registerTool({
  id: "grafana.create_annotation",
  namespace: "grafana",
  description:
    "Create a Grafana annotation on a dashboard panel (marks an event in time).",
  paramsSchema: {
    type: "object",
    properties: {
      dashboardUid: {
        type: "string",
        description: "UID of the dashboard to annotate",
      },
      panelId: {
        type: "number",
        description: "ID of the panel within the dashboard",
      },
      text: {
        type: "string",
        description: "Annotation text body",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags to attach to the annotation",
      },
      time: {
        type: "number",
        description: "Optional start time (epoch milliseconds)",
      },
      timeEnd: {
        type: "number",
        description: "Optional end time (epoch milliseconds) for a region",
      },
      into: CommonSchemas.into,
    },
    required: ["dashboardUid", "panelId", "text"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getGrafanaConnector } = await import("../../connectors/grafana.js");
    const connector = getGrafanaConnector();
    const result = await connector.createAnnotation(
      params.dashboardUid as string,
      params.panelId as number,
      params.text as string,
      {
        tags: Array.isArray(params.tags)
          ? (params.tags as string[])
          : undefined,
        time: typeof params.time === "number" ? params.time : undefined,
        timeEnd:
          typeof params.timeEnd === "number" ? params.timeEnd : undefined,
      },
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// grafana.query_datasource
// ============================================================================

registerTool({
  id: "grafana.query_datasource",
  namespace: "grafana",
  description:
    "Run one or more queries against a Grafana datasource over a time range.",
  paramsSchema: {
    type: "object",
    properties: {
      datasourceUid: {
        type: "string",
        description: "UID of the datasource to query",
      },
      queries: {
        type: "array",
        items: { type: "object" },
        description:
          "Array of query objects (datasource-specific; datasource uid is injected)",
      },
      from: {
        type: "string",
        description: "Range start (e.g. 'now-1h' or epoch ms string)",
        default: "now-1h",
      },
      to: {
        type: "string",
        description: "Range end (e.g. 'now' or epoch ms string)",
        default: "now",
      },
      into: CommonSchemas.into,
    },
    required: ["datasourceUid", "queries"],
  },
  outputSchema: {
    type: "object",
    properties: {
      results: { type: "object" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getGrafanaConnector } = await import("../../connectors/grafana.js");
    const connector = getGrafanaConnector();
    const result = await connector.queryDataSource(
      params.datasourceUid as string,
      Array.isArray(params.queries) ? (params.queries as unknown[]) : [],
      typeof params.from === "string" ? params.from : undefined,
      typeof params.to === "string" ? params.to : undefined,
    );
    return JSON.stringify(result);
  },
});
