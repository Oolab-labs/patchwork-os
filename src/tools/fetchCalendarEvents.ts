import { listEvents } from "../connectors/googleCalendar.js";
import { successStructured } from "./utils.js";

export function createFetchCalendarEventsTool() {
  return {
    schema: {
      name: "fetchCalendarEvents",
      description:
        "Fetch upcoming Google Calendar events. Returns events for the next N days. Requires Google Calendar connector connected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          daysAhead: {
            type: "integer",
            description: "Number of days ahead to fetch (default: 7, max: 30).",
            minimum: 1,
            maximum: 30,
          },
          maxResults: {
            type: "integer",
            description: "Maximum events to return (default: 20, max: 50).",
            minimum: 1,
            maximum: 50,
          },
          calendarId: {
            type: "string",
            description:
              "Calendar ID to query (e.g. 'primary' or an email address). Defaults to the connected calendar.",
            maxLength: 200,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          events: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                summary: { type: "string" },
                description: { type: ["string", "null"] },
                start: { type: "string" },
                end: { type: "string" },
                allDay: { type: "boolean" },
                location: { type: ["string", "null"] },
                htmlLink: { type: "string" },
                attendees: { type: "array", items: { type: "string" } },
              },
              required: ["id", "summary", "start", "end", "allDay", "htmlLink"],
            },
          },
          count: { type: "integer" },
          daysAhead: { type: "integer" },
          calendarConnected: { type: "boolean" },
        },
        required: ["events", "count", "daysAhead", "calendarConnected"],
      },
    },
    timeoutMs: 15_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const daysAhead = typeof args.daysAhead === "number" ? args.daysAhead : 7;
      const maxResults =
        typeof args.maxResults === "number" ? args.maxResults : 20;
      const calendarId =
        typeof args.calendarId === "string" ? args.calendarId : undefined;

      try {
        const events = await listEvents(
          { daysAhead, maxResults, calendarId },
          signal,
        );
        return successStructured({
          events: events.map((e) => ({
            id: e.id,
            summary: e.summary,
            description: e.description ?? null,
            start: e.start,
            end: e.end,
            allDay: e.allDay,
            location: e.location ?? null,
            htmlLink: e.htmlLink,
            attendees: e.attendees ?? [],
          })),
          count: events.length,
          daysAhead,
          calendarConnected: true,
        });
      } catch (err) {
        const notConnected =
          err instanceof Error && err.message.includes("not connected");
        return successStructured({
          events: [],
          count: 0,
          daysAhead,
          calendarConnected: !notConnected,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
