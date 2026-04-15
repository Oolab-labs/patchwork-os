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
        "Save workspace document via VS Code buffer when ext connected. No-op otherwise (editText writes to disk).",
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
          const result = await extensionClient.saveFile(filePath);
          if (result?.saved) {
            return successStructured({
              success: true,
              filePath,
              saved: true,
              source: "vscode-buffer",
            });
          }
          // Not saved — handler returned a structured error (e.g. untitled
          // document, document not open). Surface the handler's message when
          // available; otherwise explain the "not open in editor" case.
          const message =
            result?.error ??
            "File is not open in VS Code editor — content is already persisted to disk";
          return successStructured({
            success: true,
            filePath,
            saved: false,
            message,
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
