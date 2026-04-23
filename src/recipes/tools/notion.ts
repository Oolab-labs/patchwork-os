/**
 * Notion tools — query databases, get pages, search, create pages, append blocks.
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { assertWriteAllowed } from "../../featureFlags.js";
import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// notion.queryDatabase
// ============================================================================

registerTool({
  id: "notion.queryDatabase",
  namespace: "notion",
  description:
    "Query a Notion database and return matching pages. Supports optional filter and sort.",
  paramsSchema: {
    type: "object",
    properties: {
      databaseId: {
        type: "string",
        description: "Notion database ID (UUID with or without hyphens)",
      },
      filter: {
        type: "object",
        description:
          "Notion filter object (see Notion API docs). Omit to return all rows.",
      },
      sorts: {
        type: "array",
        description: "Array of sort objects: [{property, direction}]",
        items: {
          type: "object",
          properties: {
            property: { type: "string" },
            direction: { type: "string", enum: ["ascending", "descending"] },
          },
          required: ["property", "direction"],
        },
      },
      pageSize: {
        type: "number",
        description: "Max rows to return (default 20, max 100)",
        default: 20,
      },
      into: CommonSchemas.into,
    },
    required: ["databaseId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      results: { type: "array", items: { type: "object" } },
      next_cursor: { type: ["string", "null"] },
      has_more: { type: "boolean" },
      count: { type: "number" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getNotionConnector } = await import("../../connectors/notion.js");
    const connector = getNotionConnector();
    const result = await connector.queryDatabase(
      params.databaseId as string,
      params.filter as Record<string, unknown> | undefined,
      params.sorts as
        | Array<{ property: string; direction: "ascending" | "descending" }>
        | undefined,
      typeof params.pageSize === "number" ? params.pageSize : 20,
    );
    return JSON.stringify({ ...result, count: result.results.length });
  },
});

// ============================================================================
// notion.getPage
// ============================================================================

registerTool({
  id: "notion.getPage",
  namespace: "notion",
  description: "Fetch a single Notion page by ID, including all properties.",
  paramsSchema: {
    type: "object",
    properties: {
      pageId: {
        type: "string",
        description: "Notion page ID (UUID with or without hyphens)",
      },
      into: CommonSchemas.into,
    },
    required: ["pageId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      url: { type: "string" },
      created_time: { type: "string" },
      last_edited_time: { type: "string" },
      archived: { type: "boolean" },
      properties: { type: "object" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getNotionConnector } = await import("../../connectors/notion.js");
    const connector = getNotionConnector();
    const page = await connector.getPage(params.pageId as string);
    return JSON.stringify(page);
  },
});

// ============================================================================
// notion.search
// ============================================================================

registerTool({
  id: "notion.search",
  namespace: "notion",
  description:
    "Search across all Notion pages and databases the integration has access to.",
  paramsSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query string",
      },
      filterType: {
        type: "string",
        enum: ["page", "database"],
        description: "Limit results to pages or databases only (optional)",
      },
      pageSize: {
        type: "number",
        description: "Max results to return (default 10, max 100)",
        default: 10,
      },
      into: CommonSchemas.into,
    },
    required: ["query"],
  },
  outputSchema: {
    type: "object",
    properties: {
      results: { type: "array", items: { type: "object" } },
      next_cursor: { type: ["string", "null"] },
      has_more: { type: "boolean" },
      count: { type: "number" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getNotionConnector } = await import("../../connectors/notion.js");
    const connector = getNotionConnector();
    const result = await connector.search(
      params.query as string,
      params.filterType as "page" | "database" | undefined,
      typeof params.pageSize === "number" ? params.pageSize : 10,
    );
    return JSON.stringify({ ...result, count: result.results.length });
  },
});

// ============================================================================
// notion.createPage  (write-gated)
// ============================================================================

registerTool({
  id: "notion.createPage",
  namespace: "notion",
  description:
    "Create a new Notion page inside a database or as a child of another page. Write-gated.",
  paramsSchema: {
    type: "object",
    properties: {
      parentId: {
        type: "string",
        description: "ID of the parent database or page",
      },
      parentType: {
        type: "string",
        enum: ["database", "page"],
        description: "Whether the parent is a database or a page",
        default: "database",
      },
      title: {
        type: "string",
        description: "Page title",
      },
      content: {
        type: "string",
        description: "Optional initial paragraph content for the page body",
      },
      properties: {
        type: "object",
        description:
          "Additional Notion property values for database rows (see Notion API docs)",
      },
      into: CommonSchemas.into,
    },
    required: ["parentId", "title"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      url: { type: "string" },
      created_time: { type: "string" },
      ok: { type: "boolean" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    assertWriteAllowed("notion.createPage");
    const { getNotionConnector } = await import("../../connectors/notion.js");
    const connector = getNotionConnector();
    const page = await connector.createPage({
      parentId: params.parentId as string,
      parentType: (params.parentType as "database" | "page") ?? "database",
      title: params.title as string,
      content: params.content as string | undefined,
      properties: params.properties as Record<string, unknown> | undefined,
    });
    return JSON.stringify({
      id: page.id,
      url: page.url,
      created_time: page.created_time,
      ok: true,
    });
  },
});

// ============================================================================
// notion.appendBlock  (write-gated)
// ============================================================================

registerTool({
  id: "notion.appendBlock",
  namespace: "notion",
  description:
    "Append a new block (paragraph, list item, heading, etc.) to an existing Notion page. Write-gated.",
  paramsSchema: {
    type: "object",
    properties: {
      pageId: {
        type: "string",
        description: "ID of the Notion page to append to",
      },
      content: {
        type: "string",
        description: "Text content for the new block",
      },
      blockType: {
        type: "string",
        enum: [
          "paragraph",
          "bulleted_list_item",
          "numbered_list_item",
          "heading_1",
          "heading_2",
          "heading_3",
          "quote",
          "code",
        ],
        description: "Block type (default: paragraph)",
        default: "paragraph",
      },
      into: CommonSchemas.into,
    },
    required: ["pageId", "content"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      blockCount: { type: "number" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    assertWriteAllowed("notion.appendBlock");
    const { getNotionConnector } = await import("../../connectors/notion.js");
    const connector = getNotionConnector();
    const result = await connector.appendBlock({
      pageId: params.pageId as string,
      content: params.content as string,
      blockType: params.blockType as Parameters<
        typeof connector.appendBlock
      >[0]["blockType"],
    });
    return JSON.stringify({ ok: true, blockCount: result.results.length });
  },
});
