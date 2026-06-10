/**
 * Cal.diy tools — scheduling via the Cal.com-compatible API.
 *
 * Self-registering tool module for the recipe tool registry. Read tools wrap
 * event types and bookings; the single write tool cancels a booking.
 *
 * Wraps the Cal.diy connector (src/connectors/caldiy.ts):
 *   - getEventTypes()                       → list_event_types (read)
 *   - getBookings({status, attendeeEmail,…}) → list_bookings    (read)
 *   - getBooking(uid)                        → get_booking      (read)
 *   - cancelBooking(uid, reason?)            → cancel_booking   (write)
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { wrapConnectorExecute } from "./wrapConnectorExecute.js";

// ============================================================================
// caldiy.list_event_types
// ============================================================================

registerTool({
  id: "caldiy.list_event_types",
  namespace: "caldiy",
  description:
    "List the authenticated Cal.diy user's event types (bookable meeting templates).",
  paramsSchema: {
    type: "object",
    properties: {
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
        slug: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        length: { type: "number" },
        hidden: { type: "boolean" },
        locations: { type: "array" },
        bookingFields: { type: "array" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async () => {
    const { getCalDiyConnector } = await import("../../connectors/caldiy.js");
    const connector = getCalDiyConnector();
    const result = await connector.getEventTypes();
    return JSON.stringify(result);
  }),
});

// ============================================================================
// caldiy.list_bookings
// ============================================================================

registerTool({
  id: "caldiy.list_bookings",
  namespace: "caldiy",
  description:
    "List Cal.diy bookings, optionally filtered by status, attendee email, or date range.",
  paramsSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description:
          "Filter by booking status (e.g. upcoming, past, cancelled, accepted)",
      },
      attendeeEmail: {
        type: "string",
        description: "Filter by attendee email address",
      },
      dateFrom: {
        type: "string",
        description: "Start of date range (ISO 8601)",
      },
      dateTo: {
        type: "string",
        description: "End of date range (ISO 8601)",
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
        description: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        status: { type: "string" },
        attendees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
              timeZone: { type: "string" },
            },
          },
        },
        eventType: { type: "object" },
        cancelledBy: { type: "string" },
        rescheduledBy: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getCalDiyConnector } = await import("../../connectors/caldiy.js");
    const connector = getCalDiyConnector();
    const result = await connector.getBookings({
      status: typeof params.status === "string" ? params.status : undefined,
      attendeeEmail:
        typeof params.attendeeEmail === "string"
          ? params.attendeeEmail
          : undefined,
      dateFrom:
        typeof params.dateFrom === "string" ? params.dateFrom : undefined,
      dateTo: typeof params.dateTo === "string" ? params.dateTo : undefined,
    });
    return JSON.stringify(result);
  }),
});

// ============================================================================
// caldiy.get_booking
// ============================================================================

registerTool({
  id: "caldiy.get_booking",
  namespace: "caldiy",
  description: "Fetch a single Cal.diy booking by its UID.",
  paramsSchema: {
    type: "object",
    properties: {
      uid: { type: "string", description: "Cal.diy booking UID" },
      into: CommonSchemas.into,
    },
    required: ["uid"],
  },
  outputSchema: {
    type: "object",
    properties: {
      uid: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      status: { type: "string" },
      attendees: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
            timeZone: { type: "string" },
          },
        },
      },
      eventType: { type: "object" },
      cancelledBy: { type: "string" },
      rescheduledBy: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getCalDiyConnector } = await import("../../connectors/caldiy.js");
    const connector = getCalDiyConnector();
    const result = await connector.getBooking(params.uid as string);
    return JSON.stringify(result);
  }),
});

// ============================================================================
// caldiy.cancel_booking  (write-gated)
// ============================================================================

registerTool({
  id: "caldiy.cancel_booking",
  namespace: "caldiy",
  description: "Cancel a Cal.diy booking by UID, with an optional reason.",
  paramsSchema: {
    type: "object",
    properties: {
      uid: { type: "string", description: "Cal.diy booking UID (required)" },
      reason: {
        type: "string",
        description: "Optional cancellation reason shown to attendees",
      },
      into: CommonSchemas.into,
    },
    required: ["uid"],
  },
  outputSchema: {
    type: "object",
    properties: {
      uid: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getCalDiyConnector } = await import("../../connectors/caldiy.js");
    const connector = getCalDiyConnector();
    const result = await connector.cancelBooking(
      params.uid as string,
      typeof params.reason === "string" ? params.reason : undefined,
    );
    return JSON.stringify(result);
  }),
});
