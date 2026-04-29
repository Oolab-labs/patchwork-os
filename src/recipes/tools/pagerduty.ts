/**
 * PagerDuty tools — read incidents, services, on-call rotations, plus writes
 * (acknowledge, resolve, add note, create incident).
 *
 * Self-registering tool module for the recipe tool registry. Read tools wrap
 * connector throws into the `{count, items, error}` shape that the runner's
 * silent-fail detector (PR #75) catches as a step error rather than a silent
 * empty list. Write tools use a single-object response shape (no count/items)
 * but still surface failures via an `error` field.
 *
 * Identity for writes (PagerDuty `From` header) is sourced exclusively from
 * the PAGERDUTY_FROM_EMAIL env var, NOT from recipe tool params — recipes
 * can't spoof who acknowledged / resolved / created an incident.
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

// ============================================================================
// pagerduty.acknowledge_incident  (write-gated)
// ============================================================================

registerTool({
  id: "pagerduty.acknowledge_incident",
  namespace: "pagerduty",
  description:
    "Acknowledge a PagerDuty incident (status -> acknowledged). Identity sourced from PAGERDUTY_FROM_EMAIL env var.",
  paramsSchema: {
    type: "object",
    properties: {
      incident_id: {
        type: "string",
        description: "PagerDuty incident id (e.g. 'PXXXX')",
      },
      into: CommonSchemas.into,
    },
    required: ["incident_id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      id: { type: "string" },
      status: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPagerDutyConnector } = await import(
      "../../connectors/pagerduty.js"
    );
    try {
      const connector = getPagerDutyConnector();
      const incident = await connector.acknowledgeIncident(
        params.incident_id as string,
      );
      return JSON.stringify({
        ok: true,
        id: incident.id,
        status: incident.status,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// pagerduty.resolve_incident  (write-gated)
// ============================================================================

registerTool({
  id: "pagerduty.resolve_incident",
  namespace: "pagerduty",
  description:
    "Resolve a PagerDuty incident (status -> resolved), optionally with a resolution note. Identity sourced from PAGERDUTY_FROM_EMAIL env var.",
  paramsSchema: {
    type: "object",
    properties: {
      incident_id: {
        type: "string",
        description: "PagerDuty incident id (e.g. 'PXXXX')",
      },
      resolution: {
        type: "string",
        description: "Optional resolution note attached to the close",
      },
      into: CommonSchemas.into,
    },
    required: ["incident_id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      id: { type: "string" },
      status: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPagerDutyConnector } = await import(
      "../../connectors/pagerduty.js"
    );
    try {
      const connector = getPagerDutyConnector();
      const incident = await connector.resolveIncident(
        params.incident_id as string,
        {
          resolution:
            typeof params.resolution === "string"
              ? params.resolution
              : undefined,
        },
      );
      return JSON.stringify({
        ok: true,
        id: incident.id,
        status: incident.status,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// pagerduty.add_incident_note  (write-gated)
// ============================================================================

registerTool({
  id: "pagerduty.add_incident_note",
  namespace: "pagerduty",
  description:
    "Append a note to a PagerDuty incident timeline. Identity sourced from PAGERDUTY_FROM_EMAIL env var.",
  paramsSchema: {
    type: "object",
    properties: {
      incident_id: {
        type: "string",
        description: "PagerDuty incident id (e.g. 'PXXXX')",
      },
      content: { type: "string", description: "Note content (plain text)" },
      into: CommonSchemas.into,
    },
    required: ["incident_id", "content"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      id: { type: "string" },
      content: { type: "string" },
      created_at: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPagerDutyConnector } = await import(
      "../../connectors/pagerduty.js"
    );
    try {
      const connector = getPagerDutyConnector();
      const note = await connector.addIncidentNote(
        params.incident_id as string,
        { content: params.content as string },
      );
      return JSON.stringify({
        ok: true,
        id: note.id,
        content: note.content,
        created_at: note.created_at,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// pagerduty.create_incident  (write-gated)
// ============================================================================

registerTool({
  id: "pagerduty.create_incident",
  namespace: "pagerduty",
  description:
    "Create a new PagerDuty incident on a service. Default urgency: high. Identity sourced from PAGERDUTY_FROM_EMAIL env var.",
  paramsSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Incident title" },
      service_id: {
        type: "string",
        description:
          "PagerDuty service id (PD service the incident attaches to)",
      },
      urgency: {
        type: "string",
        enum: ["high", "low"],
        description: "Incident urgency. Defaults to 'high'.",
        default: "high",
      },
      body: {
        type: "string",
        description: "Optional incident body (free-form details)",
      },
      into: CommonSchemas.into,
    },
    required: ["title", "service_id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      id: { type: "string" },
      incident_number: { type: "number" },
      status: { type: "string" },
      html_url: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPagerDutyConnector } = await import(
      "../../connectors/pagerduty.js"
    );
    try {
      const connector = getPagerDutyConnector();
      const incident = await connector.createIncident({
        title: params.title as string,
        serviceId: params.service_id as string,
        urgency:
          params.urgency === "low" || params.urgency === "high"
            ? (params.urgency as "high" | "low")
            : "high",
        body: typeof params.body === "string" ? params.body : undefined,
      });
      return JSON.stringify({
        ok: true,
        id: incident.id,
        incident_number: incident.incident_number,
        status: incident.status,
        html_url: incident.html_url,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
