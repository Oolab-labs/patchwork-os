import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { successStructured } from "./utils.js";

const SELECTION_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" as const },
    selection: {
      type: "object" as const,
      properties: {
        file: { type: "string" as const },
        startLine: { type: "integer" as const },
        startColumn: { type: "integer" as const },
        endLine: { type: "integer" as const },
        endColumn: { type: "integer" as const },
        selectedText: { type: "string" as const },
      },
      required: [
        "file",
        "startLine",
        "startColumn",
        "endLine",
        "endColumn",
        "selectedText",
      ],
    },
    source: { type: "string" as const },
    message: { type: "string" as const },
  },
  required: ["success"],
};

const STUB_RESPONSE = {
  success: false,
  message:
    "Selection tracking not available in bridge mode. Use openFile with startText/endText to navigate to code.",
};

export function createGetCurrentSelectionTool(
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getCurrentSelection",
      description: "Get the current text selection in the editor",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
      },
      outputSchema: SELECTION_OUTPUT_SCHEMA,
    },
    timeoutMs: 5_000,
    async handler() {
      // Try extension first
      try {
        const selection = await extensionClient.getSelection();
        if (selection !== null) {
          return successStructured({
            success: true,
            selection,
            source: "extension",
          });
        }
      } catch (err) {
        if (!(err instanceof ExtensionTimeoutError)) throw err;
        // Timeout — fall through to stub
      }
      return successStructured(STUB_RESPONSE);
    },
  };
}

export function createGetLatestSelectionTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "getLatestSelection",
      description:
        "Get the most recent text selection (even if not in the active editor)",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
      },
      outputSchema: SELECTION_OUTPUT_SCHEMA,
    },
    timeoutMs: 5_000,
    async handler() {
      // Try cached selection from push notifications
      if (extensionClient.latestSelection) {
        return successStructured({
          success: true,
          selection: extensionClient.latestSelection,
          source: "extension-cached",
        });
      }
      // Try live request
      try {
        const selection = await extensionClient.getSelection();
        if (selection !== null) {
          return successStructured({
            success: true,
            selection,
            source: "extension",
          });
        }
      } catch (err) {
        if (!(err instanceof ExtensionTimeoutError)) throw err;
        // Timeout — fall through to stub
      }
      return successStructured(STUB_RESPONSE);
    },
  };
}
