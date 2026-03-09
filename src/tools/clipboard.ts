import { ExtensionTimeoutError, type ExtensionClient } from "../extensionClient.js";
import { error, extensionRequired, success } from "./utils.js";

export function createReadClipboardTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "readClipboard",
      description:
        "Read the current contents of the system clipboard. " +
        "Returns up to 100 KB of text. Useful for reading error messages, stack traces, " +
        "or code snippets the user has copied. Requires the VS Code extension.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
      },
    },
    async handler() {
      if (!extensionClient.isConnected()) {
        return extensionRequired("readClipboard");
      }
      try {
        const result = await extensionClient.readClipboard();
        if (result === null) return error("Failed to read clipboard");
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out reading clipboard");
        }
        throw err;
      }
    },
  };
}

export function createWriteClipboardTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "writeClipboard",
      description:
        "Write text to the system clipboard. " +
        "Useful for placing formatted output, transformed snippets, or summaries " +
        "directly on the clipboard for the user to paste. Max 1 MB. " +
        "Requires the VS Code extension.",
      annotations: { readOnlyHint: false, idempotentHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["text"],
        properties: {
          text: {
            type: "string" as const,
            description: "Text to write to the clipboard",
          },
        },
        additionalProperties: false as const,
      },
    },
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("writeClipboard");
      }
      const text = args.text;
      if (typeof text !== "string") return error("text is required");
      try {
        const result = await extensionClient.writeClipboard(text);
        if (result === null) return error("Failed to write clipboard");
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out writing clipboard");
        }
        throw err;
      }
    },
  };
}
