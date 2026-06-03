/**
 * Supabase tools — storage listing + schema read plus a storage upload write.
 *
 * Self-registering tool module for the recipe tool registry. Wraps the Supabase
 * connector's Storage `listFiles` / `uploadFile` and the PostgREST `getSchema`
 * (OpenAPI) endpoint. Binary-payload operations (`deleteFiles`, `downloadFile`)
 * are intentionally excluded from the recipe-step surface.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// supabase.list_files
// ============================================================================

registerTool({
  id: "supabase.list_files",
  namespace: "supabase",
  description:
    "List objects in a Supabase Storage bucket, optionally filtered by path prefix.",
  paramsSchema: {
    type: "object",
    properties: {
      bucket: {
        type: "string",
        description: "Storage bucket id/name",
      },
      prefix: {
        type: "string",
        description: "Optional path prefix to filter objects by",
      },
      limit: {
        type: "number",
        description: "Max number of objects to return (default 100)",
        default: 100,
      },
      into: CommonSchemas.into,
    },
    required: ["bucket"],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        name: { type: "string" },
        bucket_id: { type: "string" },
        owner: { type: "string" },
        created_at: { type: "string" },
        updated_at: { type: "string" },
        last_accessed_at: { type: "string" },
        metadata: { type: ["object", "null"] },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getSupabaseConnector } = await import(
      "../../connectors/supabase.js"
    );
    const connector = getSupabaseConnector();
    const result = await connector.listFiles(
      params.bucket as string,
      typeof params.prefix === "string" ? params.prefix : undefined,
      typeof params.limit === "number" ? params.limit : undefined,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// supabase.get_schema
// ============================================================================

registerTool({
  id: "supabase.get_schema",
  namespace: "supabase",
  description:
    "Fetch the Supabase PostgREST OpenAPI schema describing exposed tables and RPCs.",
  paramsSchema: {
    type: "object",
    properties: {
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async () => {
    const { getSupabaseConnector } = await import(
      "../../connectors/supabase.js"
    );
    const connector = getSupabaseConnector();
    const result = await connector.getSchema();
    return JSON.stringify(result);
  },
});

// ============================================================================
// supabase.upload_file  (write-gated)
// ============================================================================

registerTool({
  id: "supabase.upload_file",
  namespace: "supabase",
  description:
    "Upload an object to a Supabase Storage bucket at the given path. File content is supplied as a string body.",
  paramsSchema: {
    type: "object",
    properties: {
      bucket: {
        type: "string",
        description: "Storage bucket id/name",
      },
      path: {
        type: "string",
        description: "Object path within the bucket (e.g. folder/file.txt)",
      },
      file: {
        type: "string",
        description: "File content to upload (string body)",
      },
      contentType: {
        type: "string",
        description:
          "MIME type for the object (default application/octet-stream)",
      },
      into: CommonSchemas.into,
    },
    required: ["bucket", "path", "file"],
  },
  outputSchema: {
    type: "object",
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getSupabaseConnector } = await import(
      "../../connectors/supabase.js"
    );
    const connector = getSupabaseConnector();
    const result = await connector.uploadFile(
      params.bucket as string,
      params.path as string,
      params.file as string,
      typeof params.contentType === "string" ? params.contentType : undefined,
    );
    return JSON.stringify(result);
  },
});
