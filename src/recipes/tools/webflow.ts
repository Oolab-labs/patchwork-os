/**
 * Webflow tools — read-only access to sites, collections, collection items,
 * and form submissions via the Webflow v2 API.
 *
 * Self-registering tool module for the recipe tool registry. Read-only set
 * only: no item create/update/delete or publish mutations. Each tool mirrors
 * the real connector signature in `src/connectors/webflow.ts` and returns
 * `JSON.stringify(result)` of the connector's native `WebflowListResult<T>`
 * return type (`{ items, pagination? }`).
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// webflow.list_sites
// ============================================================================

registerTool({
  id: "webflow.list_sites",
  namespace: "webflow",
  description: "List Webflow sites accessible to the authenticated token.",
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
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            displayName: { type: "string" },
            shortName: { type: "string" },
            workspaceId: { type: "string" },
            createdOn: { type: "string" },
            lastPublished: { type: "string" },
          },
        },
      },
      pagination: {
        type: "object",
        properties: {
          limit: { type: "number" },
          offset: { type: "number" },
          total: { type: "number" },
        },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async () => {
    const { getWebflowConnector } = await import("../../connectors/webflow.js");
    const connector = getWebflowConnector();
    const result = await connector.listSites();
    return JSON.stringify(result);
  },
});

// ============================================================================
// webflow.list_collections
// ============================================================================

registerTool({
  id: "webflow.list_collections",
  namespace: "webflow",
  description: "List CMS collections for a Webflow site.",
  paramsSchema: {
    type: "object",
    properties: {
      siteId: { type: "string", description: "Webflow site ID" },
      into: CommonSchemas.into,
    },
    required: ["siteId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            displayName: { type: "string" },
            singularName: { type: "string" },
            slug: { type: "string" },
            createdOn: { type: "string" },
            lastUpdated: { type: "string" },
          },
        },
      },
      pagination: {
        type: "object",
        properties: {
          limit: { type: "number" },
          offset: { type: "number" },
          total: { type: "number" },
        },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getWebflowConnector } = await import("../../connectors/webflow.js");
    const connector = getWebflowConnector();
    const result = await connector.listCollections(params.siteId as string);
    return JSON.stringify(result);
  },
});

// ============================================================================
// webflow.list_collection_items
// ============================================================================

registerTool({
  id: "webflow.list_collection_items",
  namespace: "webflow",
  description:
    "List items within a Webflow CMS collection, with optional limit/offset paging.",
  paramsSchema: {
    type: "object",
    properties: {
      collectionId: { type: "string", description: "Webflow collection ID" },
      limit: {
        type: "number",
        description: "Max number of items to return (default 100, max 100)",
      },
      offset: {
        type: "number",
        description: "Number of items to skip for pagination (default 0)",
      },
      into: CommonSchemas.into,
    },
    required: ["collectionId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            cmsLocaleId: { type: "string" },
            lastPublished: { type: ["string", "null"] },
            lastUpdated: { type: "string" },
            createdOn: { type: "string" },
            isArchived: { type: "boolean" },
            isDraft: { type: "boolean" },
            fieldData: { type: "object" },
          },
        },
      },
      pagination: {
        type: "object",
        properties: {
          limit: { type: "number" },
          offset: { type: "number" },
          total: { type: "number" },
        },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getWebflowConnector } = await import("../../connectors/webflow.js");
    const connector = getWebflowConnector();
    const result = await connector.listCollectionItems(
      params.collectionId as string,
      {
        limit: typeof params.limit === "number" ? params.limit : undefined,
        offset: typeof params.offset === "number" ? params.offset : undefined,
      },
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// webflow.list_form_submissions
// ============================================================================

registerTool({
  id: "webflow.list_form_submissions",
  namespace: "webflow",
  description:
    "List submissions for a Webflow form, with optional limit/offset paging.",
  paramsSchema: {
    type: "object",
    properties: {
      formId: { type: "string", description: "Webflow form ID" },
      limit: {
        type: "number",
        description:
          "Max number of submissions to return (default 100, max 100)",
      },
      offset: {
        type: "number",
        description: "Number of submissions to skip for pagination (default 0)",
      },
      into: CommonSchemas.into,
    },
    required: ["formId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            displayName: { type: "string" },
            siteId: { type: "string" },
            formId: { type: "string" },
            dateSubmitted: { type: "string" },
            formResponse: { type: "object" },
          },
        },
      },
      pagination: {
        type: "object",
        properties: {
          limit: { type: "number" },
          offset: { type: "number" },
          total: { type: "number" },
        },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getWebflowConnector } = await import("../../connectors/webflow.js");
    const connector = getWebflowConnector();
    const result = await connector.listFormSubmissions(
      params.formId as string,
      {
        limit: typeof params.limit === "number" ? params.limit : undefined,
        offset: typeof params.offset === "number" ? params.offset : undefined,
      },
    );
    return JSON.stringify(result);
  },
});
