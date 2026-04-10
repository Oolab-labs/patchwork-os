import fs from "node:fs";
import type { ExtensionClient } from "../extensionClient.js";
import { requireString, resolveFilePath, successStructured } from "./utils.js";

export function createCheckDocumentDirtyTool(
  workspace: string,
  extensionClient?: ExtensionClient,
) {
  return {
    schema: {
      name: "checkDocumentDirty",
      description:
        "Check if a document has unsaved changes. Uses real-time VS Code buffer state when the extension is connected. Without the extension, returns a heuristic result that may be inaccurate.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        required: ["filePath"],
        properties: {
          filePath: {
            type: "string",
            description: "Path to the file to check",
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          filePath: { type: "string" },
          isDirty: { type: "boolean" },
          isUntitled: { type: "boolean" },
          source: { type: "string" },
          unknown: { type: "boolean" },
          message: { type: "string" },
        },
        required: ["success", "filePath"],
      },
    },

    async handler(args: Record<string, unknown>) {
      const rawPath = requireString(args, "filePath");
      const filePath = resolveFilePath(rawPath, workspace);

      // Use extension for real buffer state when available
      if (extensionClient?.isConnected()) {
        const isDirty = await extensionClient.isDirty(filePath);
        if (isDirty !== null) {
          return successStructured({
            success: true,
            filePath,
            isDirty,
            isUntitled: false,
            source: "vscode-buffer",
          });
        }
        // Fall through if extension returned null (file not open in editor)
      }

      // Fallback: check file exists on disk; buffer state is unknown
      try {
        fs.statSync(filePath);
        return successStructured({
          success: true,
          filePath,
          isDirty: false,
          isUntitled: false,
          unknown: true,
          message:
            "VS Code extension not connected — isDirty may be inaccurate for files with unsaved editor changes",
        });
      } catch {
        return successStructured({
          success: false,
          filePath,
          message: "File not found",
        });
      }
    },
  };
}
