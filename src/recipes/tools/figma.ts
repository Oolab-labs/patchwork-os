/**
 * Figma tools — read-only access to files, file comments, project files, and
 * rendered image URLs via the Figma REST API.
 *
 * Self-registering tool module for the recipe tool registry. Wraps the Figma
 * connector methods (`getFile`, `getFileComments`, `listProjectFiles`,
 * `getImageUrls`) and returns the connector result verbatim as JSON.
 *
 * All v1 Figma tools are read-only (the connector only requests the `read`
 * scope and exposes no mutation methods).
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// figma.get_file
// ============================================================================

registerTool({
  id: "figma.get_file",
  namespace: "figma",
  description:
    "Fetch a Figma file's document tree and metadata by file key. Optional depth limits how many node levels are returned; geometry='paths' includes vector path data.",
  paramsSchema: {
    type: "object",
    properties: {
      fileKey: {
        type: "string",
        description: "Figma file key (from the file URL, e.g. /file/<key>/...)",
      },
      depth: {
        type: "number",
        description: "How many node levels to return (default 2)",
      },
      geometry: {
        type: "string",
        enum: ["paths"],
        description: "Set to 'paths' to include vector geometry data",
      },
      into: CommonSchemas.into,
    },
    required: ["fileKey"],
  },
  outputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      lastModified: { type: "string" },
      version: { type: "string" },
      document: {},
      components: { type: "object" },
      styles: { type: "object" },
      schemaVersion: { type: "number" },
      thumbnailUrl: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getFigmaConnector } = await import("../../connectors/figma.js");
    const connector = getFigmaConnector();
    const result = await connector.getFile(params.fileKey as string, {
      depth: typeof params.depth === "number" ? params.depth : undefined,
      geometry: params.geometry === "paths" ? "paths" : undefined,
    });
    return JSON.stringify(result);
  },
});

// ============================================================================
// figma.get_file_comments
// ============================================================================

registerTool({
  id: "figma.get_file_comments",
  namespace: "figma",
  description: "List all comments on a Figma file by file key.",
  paramsSchema: {
    type: "object",
    properties: {
      fileKey: {
        type: "string",
        description: "Figma file key (from the file URL, e.g. /file/<key>/...)",
      },
      into: CommonSchemas.into,
    },
    required: ["fileKey"],
  },
  outputSchema: {
    type: "object",
    properties: {
      comments: { type: "array", items: { type: "object" } },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getFigmaConnector } = await import("../../connectors/figma.js");
    const connector = getFigmaConnector();
    const result = await connector.getFileComments(params.fileKey as string);
    return JSON.stringify(result);
  },
});

// ============================================================================
// figma.list_project_files
// ============================================================================

registerTool({
  id: "figma.list_project_files",
  namespace: "figma",
  description: "List the files within a Figma project by project ID.",
  paramsSchema: {
    type: "object",
    properties: {
      projectId: {
        type: "string",
        description: "Figma project ID",
      },
      into: CommonSchemas.into,
    },
    required: ["projectId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      files: { type: "array", items: { type: "object" } },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getFigmaConnector } = await import("../../connectors/figma.js");
    const connector = getFigmaConnector();
    const result = await connector.listProjectFiles(params.projectId as string);
    return JSON.stringify(result);
  },
});

// ============================================================================
// figma.get_image_urls
// ============================================================================

registerTool({
  id: "figma.get_image_urls",
  namespace: "figma",
  description:
    "Render and fetch image URLs for one or more nodes in a Figma file. Returns a map of node id → rendered image URL.",
  paramsSchema: {
    type: "object",
    properties: {
      fileKey: {
        type: "string",
        description: "Figma file key (from the file URL, e.g. /file/<key>/...)",
      },
      ids: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Node IDs to render (non-empty array)",
      },
      format: {
        type: "string",
        enum: ["png", "jpg", "svg", "pdf"],
        description: "Image output format (default png)",
      },
      scale: {
        type: "number",
        description: "Image scale factor (default 1)",
      },
      into: CommonSchemas.into,
    },
    required: ["fileKey", "ids"],
  },
  outputSchema: {
    type: "object",
    properties: {
      err: { type: ["string", "null"] },
      images: { type: "object" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getFigmaConnector } = await import("../../connectors/figma.js");
    const connector = getFigmaConnector();
    const result = await connector.getImageUrls(params.fileKey as string, {
      ids: params.ids as string[],
      format:
        params.format === "png" ||
        params.format === "jpg" ||
        params.format === "svg" ||
        params.format === "pdf"
          ? params.format
          : undefined,
      scale: typeof params.scale === "number" ? params.scale : undefined,
    });
    return JSON.stringify(result);
  },
});
