import path from "node:path";
import type { ExtensionClient } from "../extensionClient.js";
import { successStructured } from "./utils.js";

export function createGetWorkspaceFoldersTool(
  workspaceFolders: string[],
  extensionClient?: ExtensionClient,
) {
  return {
    schema: {
      name: "getWorkspaceFolders",
      description: "Get all workspace folders currently open in the IDE",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          success: { type: "boolean" as const },
          folders: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                name: { type: "string" as const },
                path: { type: "string" as const },
                uri: { type: "string" as const },
                index: { type: "integer" as const },
              },
              required: ["name", "path", "uri", "index"],
            },
          },
          rootPath: { type: ["string", "null"] as const },
          workspaceFile: { type: ["string", "null"] as const },
        },
        required: ["success", "folders", "rootPath", "workspaceFile"],
      },
    },

    async handler() {
      // Use extension for real multi-root data when available
      if (extensionClient?.isConnected()) {
        try {
          const folders = await extensionClient.getWorkspaceFolders();
          if (folders && folders.length > 0) {
            return successStructured({
              success: true,
              folders,
              rootPath: folders[0]?.path ?? null,
              workspaceFile: null,
            });
          }
        } catch {
          // Fall through to static list
        }
      }

      return successStructured({
        success: true,
        folders: workspaceFolders.map((p, i) => ({
          name: path.basename(p),
          uri: `file://${p}`,
          path: p,
          index: i,
        })),
        rootPath: workspaceFolders[0] ?? null,
        workspaceFile: null,
      });
    },
  };
}
