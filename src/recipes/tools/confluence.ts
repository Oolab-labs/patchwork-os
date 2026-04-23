/**
 * Confluence tools — get pages, search, create pages, append content, list spaces.
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { assertWriteAllowed } from "../../featureFlags.js";
import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// confluence.getPage
// ============================================================================

registerTool({
  id: "confluence.getPage",
  namespace: "confluence",
  description:
    "Fetch a Confluence page by ID, including its storage-format body.",
  paramsSchema: {
    type: "object",
    properties: {
      pageId: { type: "string", description: "Confluence page ID" },
      includeBody: {
        type: "boolean",
        description: "Whether to include the page body (default true)",
        default: true,
      },
      into: CommonSchemas.into,
    },
    required: ["pageId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      status: { type: "string" },
      spaceId: { type: "string" },
      version: { type: "number" },
      body: { type: ["string", "null"] },
      url: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getConfluenceConnector } = await import(
      "../../connectors/confluence.js"
    );
    const connector = getConfluenceConnector();
    const page = await connector.getPage(
      params.pageId as string,
      params.includeBody !== false,
    );
    if (!page)
      return JSON.stringify({
        error: `Page ${params.pageId as string} not found`,
      });
    return JSON.stringify({
      id: page.id,
      title: page.title,
      status: page.status,
      spaceId: page.spaceId,
      version: page.version.number,
      body: page.body?.storage?.value ?? null,
      url: page._links.webui,
    });
  },
});

// ============================================================================
// confluence.search
// ============================================================================

registerTool({
  id: "confluence.search",
  namespace: "confluence",
  description: "Search Confluence pages using a full-text query (CQL).",
  paramsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search terms" },
      limit: {
        type: "number",
        description: "Max results to return (default 25)",
        default: 25,
      },
      into: CommonSchemas.into,
    },
    required: ["query"],
  },
  outputSchema: {
    type: "object",
    properties: {
      results: { type: "array", items: { type: "object" } },
      totalSize: { type: "number" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getConfluenceConnector } = await import(
      "../../connectors/confluence.js"
    );
    const connector = getConfluenceConnector();
    const result = await connector.search(
      params.query as string,
      typeof params.limit === "number" ? params.limit : 25,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// confluence.createPage
// ============================================================================

registerTool({
  id: "confluence.createPage",
  namespace: "confluence",
  description: "Create a new Confluence page in a space.",
  paramsSchema: {
    type: "object",
    properties: {
      spaceId: { type: "string", description: "Confluence space ID" },
      title: { type: "string", description: "Page title" },
      body: {
        type: "string",
        description: "Page body in Confluence storage format (XHTML)",
      },
      parentId: {
        type: "string",
        description: "Optional parent page ID to nest this page under",
      },
      into: CommonSchemas.into,
    },
    required: ["spaceId", "title", "body"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      url: { type: "string" },
      version: { type: "number" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    assertWriteAllowed("confluence.createPage");
    const { getConfluenceConnector } = await import(
      "../../connectors/confluence.js"
    );
    const connector = getConfluenceConnector();
    const page = await connector.createPage({
      spaceId: params.spaceId as string,
      title: params.title as string,
      body: params.body as string,
      parentId: params.parentId as string | undefined,
    });
    return JSON.stringify({
      id: page.id,
      title: page.title,
      url: page._links.webui,
      version: page.version.number,
    });
  },
});

// ============================================================================
// confluence.appendToPage
// ============================================================================

registerTool({
  id: "confluence.appendToPage",
  namespace: "confluence",
  description:
    "Append content to an existing Confluence page (increments version).",
  paramsSchema: {
    type: "object",
    properties: {
      pageId: { type: "string", description: "Confluence page ID" },
      content: {
        type: "string",
        description: "Storage-format XHTML content to append",
      },
      into: CommonSchemas.into,
    },
    required: ["pageId", "content"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      version: { type: "number" },
      url: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    assertWriteAllowed("confluence.appendToPage");
    const { getConfluenceConnector } = await import(
      "../../connectors/confluence.js"
    );
    const connector = getConfluenceConnector();
    const page = await connector.appendToPage(
      params.pageId as string,
      params.content as string,
    );
    return JSON.stringify({
      id: page.id,
      title: page.title,
      version: page.version.number,
      url: page._links.webui,
    });
  },
});

// ============================================================================
// confluence.listSpaces
// ============================================================================

registerTool({
  id: "confluence.listSpaces",
  namespace: "confluence",
  description: "List all accessible Confluence spaces.",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max spaces to return (default 50)",
        default: 50,
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      spaces: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            key: { type: "string" },
            name: { type: "string" },
            type: { type: "string" },
            url: { type: "string" },
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
    const { getConfluenceConnector } = await import(
      "../../connectors/confluence.js"
    );
    const connector = getConfluenceConnector();
    const spaces = await connector.listSpaces(
      typeof params.limit === "number" ? params.limit : 50,
    );
    return JSON.stringify({
      spaces: spaces.map((s) => ({
        id: s.id,
        key: s.key,
        name: s.name,
        type: s.type,
        url: s._links.webui,
      })),
      count: spaces.length,
    });
  },
});
