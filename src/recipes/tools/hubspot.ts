/**
 * HubSpot tools — list/get contacts and deals, create notes, search contacts.
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { assertWriteAllowed } from "../../featureFlags.js";
import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// hubspot.listContacts
// ============================================================================

registerTool({
  id: "hubspot.listContacts",
  namespace: "hubspot",
  description: "List HubSpot CRM contacts with basic properties.",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max contacts to return (default 25)",
        default: 25,
      },
      after: {
        type: "string",
        description: "Pagination cursor (after value from previous response)",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      results: { type: "array", items: { type: "object" } },
      paging: { type: "object" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getHubSpotConnector } = await import("../../connectors/hubspot.js");
    const connector = getHubSpotConnector();
    const result = await connector.listContacts({
      limit: typeof params.limit === "number" ? params.limit : undefined,
      after: typeof params.after === "string" ? params.after : undefined,
    });
    return JSON.stringify(result);
  },
});

// ============================================================================
// hubspot.getContact
// ============================================================================

registerTool({
  id: "hubspot.getContact",
  namespace: "hubspot",
  description: "Fetch a single HubSpot contact by ID.",
  paramsSchema: {
    type: "object",
    properties: {
      contactId: { type: "string", description: "HubSpot contact ID" },
      into: CommonSchemas.into,
    },
    required: ["contactId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      contact: { type: ["object", "null"] },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getHubSpotConnector } = await import("../../connectors/hubspot.js");
    const connector = getHubSpotConnector();
    const contact = await connector.getContact(params.contactId as string);
    return JSON.stringify({ contact });
  },
});

// ============================================================================
// hubspot.listDeals
// ============================================================================

registerTool({
  id: "hubspot.listDeals",
  namespace: "hubspot",
  description: "List HubSpot CRM deals, optionally filtered by stage.",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max deals to return (default 25)",
        default: 25,
      },
      stage: {
        type: "string",
        description: "Filter by deal stage ID",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      results: { type: "array", items: { type: "object" } },
      paging: { type: "object" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getHubSpotConnector } = await import("../../connectors/hubspot.js");
    const connector = getHubSpotConnector();
    const result = await connector.listDeals({
      limit: typeof params.limit === "number" ? params.limit : undefined,
      stage: typeof params.stage === "string" ? params.stage : undefined,
    });
    return JSON.stringify(result);
  },
});

// ============================================================================
// hubspot.getDeal
// ============================================================================

registerTool({
  id: "hubspot.getDeal",
  namespace: "hubspot",
  description: "Fetch a single HubSpot deal by ID.",
  paramsSchema: {
    type: "object",
    properties: {
      dealId: { type: "string", description: "HubSpot deal ID" },
      into: CommonSchemas.into,
    },
    required: ["dealId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      deal: { type: ["object", "null"] },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getHubSpotConnector } = await import("../../connectors/hubspot.js");
    const connector = getHubSpotConnector();
    const deal = await connector.getDeal(params.dealId as string);
    return JSON.stringify({ deal });
  },
});

// ============================================================================
// hubspot.createNote
// ============================================================================

registerTool({
  id: "hubspot.createNote",
  namespace: "hubspot",
  description:
    "Create a note in HubSpot, optionally associated with a contact or deal.",
  paramsSchema: {
    type: "object",
    properties: {
      body: { type: "string", description: "Note text content" },
      contactId: {
        type: "string",
        description: "Associate note with this contact ID",
      },
      dealId: {
        type: "string",
        description: "Associate note with this deal ID",
      },
      into: CommonSchemas.into,
    },
    required: ["body"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      createdAt: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    assertWriteAllowed("hubspot.createNote");
    const { getHubSpotConnector } = await import("../../connectors/hubspot.js");
    const connector = getHubSpotConnector();
    const note = await connector.createNote(
      params.body as string,
      typeof params.contactId === "string" ? params.contactId : undefined,
      typeof params.dealId === "string" ? params.dealId : undefined,
    );
    return JSON.stringify({ id: note.id, createdAt: note.createdAt });
  },
});

// ============================================================================
// hubspot.searchContacts
// ============================================================================

registerTool({
  id: "hubspot.searchContacts",
  namespace: "hubspot",
  description: "Search HubSpot contacts by name, email, or company.",
  paramsSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query string",
      },
      into: CommonSchemas.into,
    },
    required: ["query"],
  },
  outputSchema: {
    type: "object",
    properties: {
      results: { type: "array", items: { type: "object" } },
      count: { type: "number" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getHubSpotConnector } = await import("../../connectors/hubspot.js");
    const connector = getHubSpotConnector();
    const results = await connector.searchContacts(params.query as string);
    return JSON.stringify({ results, count: results.length });
  },
});
