import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  extensionRequired,
  optionalInt,
  optionalString,
  requireInt,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

export function createGetTypeHierarchyTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getTypeHierarchy",
      description:
        "Get the type hierarchy for a symbol — supertypes (parent classes/interfaces) and subtypes (implementations/subclasses). Requires a language server with type hierarchy support.",
      annotations: { readOnlyHint: true },
      extensionRequired: true,
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["file", "line", "column"],
        properties: {
          file: {
            type: "string" as const,
            description: "Absolute path to the file",
          },
          line: {
            type: "integer" as const,
            description: "Line number (1-based)",
          },
          column: {
            type: "integer" as const,
            description: "Column number (1-based)",
          },
          direction: {
            type: "string" as const,
            enum: ["supertypes", "subtypes", "both"],
            description: "Which direction to traverse (default: both)",
          },
          maxResults: {
            type: "integer" as const,
            description: "Max results per direction (default: 20)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          found: { type: "boolean" as const },
          message: { type: "string" as const },
          supertypes: {
            type: "array" as const,
            items: { type: "object" as const },
          },
          subtypes: {
            type: "array" as const,
            items: { type: "object" as const },
          },
        },
        required: ["found"],
      },
    },
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getTypeHierarchy");
      }
      const file = resolveFilePath(requireString(args, "file"), workspace);
      const line = requireInt(args, "line", 1, 1_000_000);
      const column = requireInt(args, "column", 1, 100_000);
      const direction = optionalString(args, "direction") ?? "both";
      if (!["supertypes", "subtypes", "both"].includes(direction)) {
        return error('direction must be "supertypes", "subtypes", or "both"');
      }
      const maxResults = optionalInt(args, "maxResults", 1, 200) ?? 20;
      try {
        const result = await extensionClient.getTypeHierarchy(
          file,
          line,
          column,
          direction,
          maxResults,
          signal,
        );
        if (result === null)
          return successStructured({
            found: false,
            message:
              "No type hierarchy at this position — ensure a language server is active",
          });
        return successStructured(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out getting type hierarchy");
        }
        throw err;
      }
    },
  };
}
