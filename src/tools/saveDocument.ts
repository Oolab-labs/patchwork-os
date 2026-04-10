import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { requireString, resolveFilePath, successStructured } from "./utils.js";

export function createSaveDocumentTool(
  workspace: string,
  extensionClient?: ExtensionClient,
) {
  return {
    schema: {
      name: "saveDocument",
      description:
        "Save a document with unsaved changes. Uses VS Code's buffer save when connected. " +
        "Without the extension, this is a no-op — editText writes directly to disk.",
      annotations: { destructiveHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        required: ["filePath"],
        properties: {
          filePath: { type: "string", description: "Path to the file to save" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          filePath: { type: "string" },
          saved: { type: "boolean" },
          source: { type: "string" },
          message: { type: "string" },
        },
        required: ["success"],
      },
    },

    async handler(args: Record<string, unknown>) {
      const rawPath = requireString(args, "filePath");
      const filePath = resolveFilePath(rawPath, workspace, { write: true });

      // Use extension for real buffer flush when available
      if (extensionClient?.isConnected()) {
        try {
          const saved = await extensionClient.saveFile(filePath);
          if (saved) {
            return successStructured({
              success: true,
              filePath,
              saved: true,
              source: "vscode-buffer",
            });
          }
          // false — file not open in editor (already on disk from editText or never opened)
          return successStructured({
            success: true,
            filePath,
            saved: false,
            message:
              "File is not open in VS Code editor — content is already persisted to disk",
          });
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to no-op response
        }
      }

      // Without the extension, editText already writes directly to disk
      return successStructured({
        success: true,
        filePath,
        saved: false,
        message:
          "Extension not connected — edits are written directly to disk by editText; no buffer flush needed",
      });
    },
  };
}
