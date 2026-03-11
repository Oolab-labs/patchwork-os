import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  extensionRequired,
  requireInt,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

export function createGetInlayHintsTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getInlayHints",
      extensionRequired: true,
      description:
        "Get inlay hints for a range of lines in a file. Inlay hints are the inline type " +
        "annotations and parameter names shown by the language server (e.g. TypeScript types, " +
        "Rust lifetimes). Requires the VS Code extension.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["file", "startLine", "endLine"],
        properties: {
          file: {
            type: "string" as const,
            description: "Absolute path to the file",
          },
          startLine: {
            type: "integer" as const,
            description: "First line (1-based)",
          },
          endLine: {
            type: "integer" as const,
            description: "Last line (1-based, inclusive)",
          },
        },
        additionalProperties: false as const,
      },
    },
    timeoutMs: 8_000,
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getInlayHints");
      }
      const file = resolveFilePath(requireString(args, "file"), workspace);
      const startLine = requireInt(args, "startLine", 1, 1_000_000);
      const endLine = requireInt(args, "endLine", 1, 1_000_000);
      try {
        const result = await extensionClient.getInlayHints(
          file,
          startLine,
          endLine,
        );
        if (result === null) return error("Failed to get inlay hints");
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out getting inlay hints");
        }
        throw err;
      }
    },
  };
}
