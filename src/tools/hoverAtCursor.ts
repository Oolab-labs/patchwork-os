import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { error, extensionRequired, success } from "./utils.js";

export function createGetHoverAtCursorTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "getHoverAtCursor",
      description:
        "Get hover documentation for the symbol currently under the developer's cursor. " +
        "Zero-input convenience wrapper around getHover — uses the active file and " +
        "cursor position tracked by the extension. Requires the VS Code extension.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
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
          return success({
            found: false,
            file,
            line,
            column,
            message: "No hover information available at cursor position",
          });
        }
        return success({ found: true, file, line, column, hover: result });
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out getting hover information");
        }
        throw err;
      }
    },
  };
}
