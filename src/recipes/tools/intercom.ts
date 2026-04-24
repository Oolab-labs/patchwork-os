/**
 * Intercom tools — list/get conversations, reply, close, list contacts.
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { assertWriteAllowed } from "../../featureFlags.js";
import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// intercom.listConversations
// ============================================================================

registerTool({
  id: "intercom.listConversations",
  namespace: "intercom",
  description:
    "List Intercom conversations, optionally filtered by status or assignee.",
  paramsSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["open", "closed", "snoozed", "pending"],
        description: "Filter by conversation status",
      },
      assigneeId: {
        type: "string",
        description: "Filter by assignee ID",
      },
      perPage: {
        type: "number",
        description: "Results per page (default 20)",
        default: 20,
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      conversations: { type: "array", items: { type: "object" } },
      total_count: { type: "number" },
      pages: { type: "object" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getIntercomConnector } = await import(
      "../../connectors/intercom.js"
    );
    const connector = getIntercomConnector();
    const result = await connector.listConversations({
      status: params.status as
        | "open"
        | "closed"
        | "snoozed"
        | "pending"
        | undefined,
      assigneeId:
        typeof params.assigneeId === "string" ? params.assigneeId : undefined,
      perPage: typeof params.perPage === "number" ? params.perPage : 20,
    });
    return JSON.stringify(result);
  },
});

// ============================================================================
// intercom.getConversation
// ============================================================================

registerTool({
  id: "intercom.getConversation",
  namespace: "intercom",
  description: "Fetch a single Intercom conversation by ID, including parts.",
  paramsSchema: {
    type: "object",
    properties: {
      conversationId: {
        type: "string",
        description: "Intercom conversation ID",
      },
      into: CommonSchemas.into,
    },
    required: ["conversationId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      state: { type: "string" },
      title: { type: ["string", "null"] },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getIntercomConnector } = await import(
      "../../connectors/intercom.js"
    );
    const connector = getIntercomConnector();
    const conversation = await connector.getConversation(
      params.conversationId as string,
    );
    return JSON.stringify(conversation);
  },
});

// ============================================================================
// intercom.replyToConversation
// ============================================================================

registerTool({
  id: "intercom.replyToConversation",
  namespace: "intercom",
  description:
    "Reply to an Intercom conversation as a comment or internal note.",
  paramsSchema: {
    type: "object",
    properties: {
      conversationId: {
        type: "string",
        description: "Intercom conversation ID",
      },
      body: { type: "string", description: "Reply body text" },
      type: {
        type: "string",
        enum: ["comment", "note"],
        description: "Reply type: comment (visible to user) or note (internal)",
        default: "comment",
      },
      into: CommonSchemas.into,
    },
    required: ["conversationId", "body"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      state: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    assertWriteAllowed("intercom.replyToConversation");
    const { getIntercomConnector } = await import(
      "../../connectors/intercom.js"
    );
    const connector = getIntercomConnector();
    const conversation = await connector.replyToConversation(
      params.conversationId as string,
      params.body as string,
      (params.type as "comment" | "note" | undefined) ?? "comment",
    );
    return JSON.stringify({ id: conversation.id, state: conversation.state });
  },
});

// ============================================================================
// intercom.closeConversation
// ============================================================================

registerTool({
  id: "intercom.closeConversation",
  namespace: "intercom",
  description: "Close an open Intercom conversation.",
  paramsSchema: {
    type: "object",
    properties: {
      conversationId: {
        type: "string",
        description: "Intercom conversation ID",
      },
      into: CommonSchemas.into,
    },
    required: ["conversationId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      state: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    assertWriteAllowed("intercom.closeConversation");
    const { getIntercomConnector } = await import(
      "../../connectors/intercom.js"
    );
    const connector = getIntercomConnector();
    const conversation = await connector.closeConversation(
      params.conversationId as string,
    );
    return JSON.stringify({ id: conversation.id, state: conversation.state });
  },
});

// ============================================================================
// intercom.listContacts
// ============================================================================

registerTool({
  id: "intercom.listContacts",
  namespace: "intercom",
  description: "List Intercom contacts, optionally filtered by name query.",
  paramsSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Filter contacts by name (partial match)",
      },
      perPage: {
        type: "number",
        description: "Results per page (default 20)",
        default: 20,
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      contacts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: ["string", "null"] },
            email: { type: ["string", "null"] },
          },
        },
      },
      total_count: { type: "number" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getIntercomConnector } = await import(
      "../../connectors/intercom.js"
    );
    const connector = getIntercomConnector();
    const result = await connector.listContacts({
      query: params.query as string | undefined,
      perPage: typeof params.perPage === "number" ? params.perPage : 20,
    });
    return JSON.stringify(result);
  },
});
