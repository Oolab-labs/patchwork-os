/**
 * Google Calendar tools — calendar.list_events
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// calendar.list_events
// ============================================================================

registerTool({
  id: "calendar.list_events",
  namespace: "calendar",
  description: "List upcoming Google Calendar events.",
  paramsSchema: {
    type: "object",
    properties: {
      days_ahead: {
        type: "number",
        description: "Number of days to look ahead",
        default: 7,
      },
      max: CommonSchemas.max,
      calendar_id: {
        type: "string",
        description: "Calendar ID (omit for primary calendar)",
      },
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      events: { type: "array" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { listEvents } = await import("../../connectors/googleCalendar.js");
    const daysAhead =
      typeof params.days_ahead === "number" ? params.days_ahead : 7;
    const maxResults = typeof params.max === "number" ? params.max : 20;
    const calendarId = params.calendar_id
      ? String(params.calendar_id)
      : undefined;

    try {
      const events = await listEvents({ daysAhead, maxResults, calendarId });
      return JSON.stringify({ count: events.length, events });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        events: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
