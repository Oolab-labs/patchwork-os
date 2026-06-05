/**
 * PostHog tools — capture product-analytics events (write) plus read wrappers
 * for insights, HogQL queries, and raw events.
 *
 * Self-registering tool module for the recipe tool registry. Mirrors the
 * connector method signatures in src/connectors/posthog.ts:
 *   - captureEvent(distinctId, event, properties?, timestamp?)
 *   - getInsights(projectId, limit?)
 *   - queryInsight(projectId, query)
 *   - getEvents(projectId, params)
 *
 * `capture_event` is the only mutating tool — it POSTs to /capture/ and so
 * declares isWrite: true so the approval queue / kill-switch gate it. The
 * remaining tools are read-only.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { wrapConnectorExecute } from "./wrapConnectorExecute.js";

// ============================================================================
// posthog.capture_event  (write-gated)
// ============================================================================

registerTool({
  id: "posthog.capture_event",
  namespace: "posthog",
  description:
    "Capture a PostHog product-analytics event for a distinct id. Requires a project API key on the connection.",
  paramsSchema: {
    type: "object",
    properties: {
      distinctId: {
        type: "string",
        description: "Distinct id of the person the event is attributed to",
      },
      event: {
        type: "string",
        description: "Event name (e.g. 'signed_up', '$pageview')",
      },
      properties: {
        type: "object",
        description: "Optional event property bag",
        additionalProperties: true,
      },
      timestamp: {
        type: "string",
        description: "Optional ISO 8601 timestamp for the event",
      },
      into: CommonSchemas.into,
    },
    required: ["distinctId", "event"],
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getPostHogConnector } = await import("../../connectors/posthog.js");
    const connector = getPostHogConnector();
    const result = await connector.captureEvent(
      params.distinctId as string,
      params.event as string,
      typeof params.properties === "object" && params.properties !== null
        ? (params.properties as Record<string, unknown>)
        : undefined,
      typeof params.timestamp === "string" ? params.timestamp : undefined,
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// posthog.list_insights
// ============================================================================

registerTool({
  id: "posthog.list_insights",
  namespace: "posthog",
  description: "List PostHog insights for a project, optionally limited.",
  paramsSchema: {
    type: "object",
    properties: {
      projectId: {
        type: ["string", "number"],
        description: "PostHog project id",
      },
      limit: {
        type: "number",
        description: "Max number of insights to return",
      },
      into: CommonSchemas.into,
    },
    required: ["projectId"],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: ["string", "number"] },
        name: { type: "string" },
        description: { type: "string" },
        filters: { type: "object" },
        result: {},
        last_modified_at: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getPostHogConnector } = await import("../../connectors/posthog.js");
    const connector = getPostHogConnector();
    const result = await connector.getInsights(
      params.projectId as string | number,
      typeof params.limit === "number" ? params.limit : undefined,
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// posthog.query_insight
// ============================================================================

registerTool({
  id: "posthog.query_insight",
  namespace: "posthog",
  description:
    "Run a HogQL / structured query against a PostHog project and return the raw query result.",
  paramsSchema: {
    type: "object",
    properties: {
      projectId: {
        type: ["string", "number"],
        description: "PostHog project id",
      },
      query: {
        type: "object",
        description:
          "PostHog query object (e.g. { kind: 'HogQLQuery', query: 'SELECT ...' })",
        additionalProperties: true,
      },
      into: CommonSchemas.into,
    },
    required: ["projectId", "query"],
  },
  outputSchema: {
    type: "object",
    description: "Raw PostHog query response (shape varies by query kind)",
    additionalProperties: true,
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getPostHogConnector } = await import("../../connectors/posthog.js");
    const connector = getPostHogConnector();
    const result = await connector.queryInsight(
      params.projectId as string | number,
      params.query as Record<string, unknown>,
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// posthog.list_events
// ============================================================================

registerTool({
  id: "posthog.list_events",
  namespace: "posthog",
  description:
    "List raw PostHog events for a project, optionally filtered by event name, person, and time window.",
  paramsSchema: {
    type: "object",
    properties: {
      projectId: {
        type: ["string", "number"],
        description: "PostHog project id",
      },
      event: {
        type: "string",
        description: "Filter by event name",
      },
      personId: {
        type: "string",
        description: "Filter by person id",
      },
      after: {
        type: "string",
        description: "ISO 8601 timestamp — only events after this time",
      },
      before: {
        type: "string",
        description: "ISO 8601 timestamp — only events before this time",
      },
      limit: {
        type: "number",
        description: "Max number of events to return",
      },
      into: CommonSchemas.into,
    },
    required: ["projectId"],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        distinct_id: { type: "string" },
        event: { type: "string" },
        properties: { type: "object" },
        timestamp: { type: "string" },
        person: { type: "object" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getPostHogConnector } = await import("../../connectors/posthog.js");
    const connector = getPostHogConnector();
    const result = await connector.getEvents(
      params.projectId as string | number,
      {
        event: typeof params.event === "string" ? params.event : undefined,
        personId:
          typeof params.personId === "string" ? params.personId : undefined,
        after: typeof params.after === "string" ? params.after : undefined,
        before: typeof params.before === "string" ? params.before : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      },
    );
    return JSON.stringify(result);
  }),
});
