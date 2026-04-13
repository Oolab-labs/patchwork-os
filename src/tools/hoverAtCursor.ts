import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { error, extensionRequired, successStructured } from "./utils.js";

export function createGetHoverAtCursorTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "getHoverAtCursor",
      description:
        "Get hover documentation for the symbol currently under the developer's cursor. " +
        "Zero-input convenience wrapper around getHover — uses the active file and " +
        "cursor position tracked by the extension.",
      annotations: { readOnlyHint: true },
      extensionRequired: true,
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          found: { type: "boolean" as const },
          file: { type: "string" as const },
          line: { type: "number" as const },
          column: { type: "number" as const },
          message: { type: "string" as const },
          hover: { type: "object" as const },
        },
        required: ["found"],
      },
    },
    timeoutMs: 8_000,
    async handler() {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getHoverAtCursor");
      }

      const file = extensionClient.latestActiveFile;
      const selection = extensionClient.latestSelection;

      if (!file) {
        return error("No active file tracked — open a file in VS Code first");
      }

      const line = selection ? selection.startLine : 1;
      const column = selection ? selection.startColumn : 1;

      try {
        const result = await extensionClient.getHover(file, line, column);
        if (result === null) {
          return successStructured({
            found: false,
            file,
            line,
            column,
            message: "No hover information available at cursor position",
          });
        }
        return successStructured({
          found: true,
          file,
          line,
          column,
          hover: result,
        });
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out getting hover information");
        }
        throw err;
      }
    },
  };
}
