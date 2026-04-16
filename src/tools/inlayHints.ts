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
  successStructured,
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
        "Inlay hints (inline type annotations, param names) for a line range. e.g. TS types, Rust lifetimes.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["file", "startLine", "endLine"],
        properties: {
          file: {
            type: "string" as const,
            description: "Workspace or absolute path",
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
      outputSchema: {
        type: "object" as const,
        properties: {
          hints: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                position: { type: "object" as const },
                label: { type: "string" as const },
                kind: { type: "string" as const },
                tooltip: { type: "string" as const },
                paddingLeft: { type: "boolean" as const },
                paddingRight: { type: "boolean" as const },
              },
              required: ["position", "label"],
            },
          },
          count: { type: "number" as const },
        },
        required: ["hints", "count"],
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
        return successStructured(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out getting inlay hints");
        }
        throw err;
      }
    },
  };
}
