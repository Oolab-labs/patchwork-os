/**
 * Zendesk tools — list/get tickets, add comments, update status, list agents.
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { assertWriteAllowed } from "../../featureFlags.js";
import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// zendesk.listTickets
// ============================================================================

registerTool({
  id: "zendesk.listTickets",
  namespace: "zendesk",
  description:
    "List Zendesk tickets, optionally filtered by status, assignee, or free-text query.",
  paramsSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["new", "open", "pending", "hold", "solved", "closed"],
        description: "Filter by ticket status",
      },
      assigneeId: {
        type: "number",
        description: "Filter by assignee user ID",
      },
      query: {
        type: "string",
        description: "Free-text search query (uses Zendesk search API)",
      },
      perPage: {
        type: "number",
        description: "Results per page (default 25, max 100)",
        default: 25,
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      results: { type: "array", items: { type: "object" } },
      count: { type: "number" },
      next_page: { type: ["string", "null"] },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getZendeskConnector } = await import("../../connectors/zendesk.js");
    const connector = getZendeskConnector();
    const result = await connector.listTickets({
      status: params.status as
        | "new"
        | "open"
        | "pending"
        | "hold"
        | "solved"
        | "closed"
        | undefined,
      assigneeId:
        typeof params.assigneeId === "number" ? params.assigneeId : undefined,
      query: params.query as string | undefined,
      perPage: typeof params.perPage === "number" ? params.perPage : 25,
    });
    return JSON.stringify(result);
  },
});

// ============================================================================
// zendesk.getTicket
// ============================================================================

registerTool({
  id: "zendesk.getTicket",
  namespace: "zendesk",
  description: "Fetch a single Zendesk ticket by ID, including its comments.",
  paramsSchema: {
    type: "object",
    properties: {
      ticketId: { type: "number", description: "Zendesk ticket ID" },
      includeComments: {
        type: "boolean",
        description: "Whether to fetch comments (default true)",
        default: true,
      },
      into: CommonSchemas.into,
    },
    required: ["ticketId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ticket: { type: ["object", "null"] },
      comments: { type: "array", items: { type: "object" } },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getZendeskConnector } = await import("../../connectors/zendesk.js");
    const connector = getZendeskConnector();
    const ticketId = params.ticketId as number;
    const [ticket, comments] = await Promise.all([
      connector.getTicket(ticketId),
      params.includeComments !== false
        ? connector.getTicketComments(ticketId)
        : Promise.resolve([]),
    ]);
    return JSON.stringify({ ticket, comments });
  },
});

// ============================================================================
// zendesk.addComment
// ============================================================================

registerTool({
  id: "zendesk.addComment",
  namespace: "zendesk",
  description: "Add a public or private comment to a Zendesk ticket.",
  paramsSchema: {
    type: "object",
    properties: {
      ticketId: { type: "number", description: "Zendesk ticket ID" },
      body: { type: "string", description: "Comment text (plain text)" },
      public: {
        type: "boolean",
        description:
          "Whether the comment is public (visible to requester). Default true.",
        default: true,
      },
      into: CommonSchemas.into,
    },
    required: ["ticketId", "body"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
      status: { type: "string" },
      updated_at: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    assertWriteAllowed("zendesk.addComment");
    const { getZendeskConnector } = await import("../../connectors/zendesk.js");
    const connector = getZendeskConnector();
    const ticket = await connector.addComment(
      params.ticketId as number,
      params.body as string,
      params.public !== false,
    );
    return JSON.stringify({
      id: ticket.id,
      status: ticket.status,
      updated_at: ticket.updated_at,
    });
  },
});

// ============================================================================
// zendesk.updateStatus
// ============================================================================

registerTool({
  id: "zendesk.updateStatus",
  namespace: "zendesk",
  description: "Update the status of a Zendesk ticket.",
  paramsSchema: {
    type: "object",
    properties: {
      ticketId: { type: "number", description: "Zendesk ticket ID" },
      status: {
        type: "string",
        enum: ["new", "open", "pending", "hold", "solved", "closed"],
        description: "New ticket status",
      },
      into: CommonSchemas.into,
    },
    required: ["ticketId", "status"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
      status: { type: "string" },
      updated_at: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    assertWriteAllowed("zendesk.updateStatus");
    const { getZendeskConnector } = await import("../../connectors/zendesk.js");
    const connector = getZendeskConnector();
    const ticket = await connector.updateStatus(
      params.ticketId as number,
      params.status as
        | "new"
        | "open"
        | "pending"
        | "hold"
        | "solved"
        | "closed",
    );
    return JSON.stringify({
      id: ticket.id,
      status: ticket.status,
      updated_at: ticket.updated_at,
    });
  },
});

// ============================================================================
// zendesk.listUsers
// ============================================================================

registerTool({
  id: "zendesk.listUsers",
  namespace: "zendesk",
  description:
    "List Zendesk users, optionally filtered by role (end-user, agent, admin).",
  paramsSchema: {
    type: "object",
    properties: {
      role: {
        type: "string",
        enum: ["end-user", "agent", "admin"],
        description: "Filter by user role",
      },
      perPage: {
        type: "number",
        description: "Results per page (default 50)",
        default: 50,
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      users: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            name: { type: "string" },
            email: { type: "string" },
            role: { type: "string" },
          },
        },
      },
      count: { type: "number" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getZendeskConnector } = await import("../../connectors/zendesk.js");
    const connector = getZendeskConnector();
    const users = await connector.listUsers(
      params.role as "end-user" | "agent" | "admin" | undefined,
      typeof params.perPage === "number" ? params.perPage : 50,
    );
    return JSON.stringify({ users, count: users.length });
  },
});
