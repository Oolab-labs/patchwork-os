import {
  type DecorationSpec,
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  extensionRequired,
  optionalArray,
  optionalString,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

export function createSetEditorDecorationsTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "setEditorDecorations",
      extensionRequired: true,
      description:
        "Place visual decorations (highlights, annotations, inline text) on lines in a file. " +
        "Decorations are grouped by a logical ID — you can have multiple independent decoration sets. " +
        "Each call replaces existing decorations for that ID+file. " +
        "Styles: info (green), warning (yellow), error (red), focus (border), strikethrough, dim. " +
        "Requires the VS Code extension.",
      annotations: { idempotentHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["id", "file", "decorations"],
        properties: {
          id: {
            type: "string" as const,
            description:
              "Logical group name for these decorations (alphanumeric + hyphens)",
          },
          file: {
            type: "string" as const,
            description: "Absolute path to the file to decorate",
          },
          decorations: {
            type: "array" as const,
            description: "Decorations to apply",
            items: {
              type: "object" as const,
              required: ["startLine"],
              properties: {
                startLine: {
                  type: "integer" as const,
                  description: "Start line (1-based)",
                },
                endLine: {
                  type: "integer" as const,
                  description: "End line (1-based, defaults to startLine)",
                },
                message: {
                  type: "string" as const,
                  description: "Inline message shown after the line",
                },
                hoverMessage: {
                  type: "string" as const,
                  description: "Tooltip shown on hover",
                },
                style: {
                  type: "string" as const,
                  enum: [
                    "info",
                    "warning",
                    "error",
                    "focus",
                    "strikethrough",
                    "dim",
                  ],
                  description: "Visual style (default: info)",
                },
              },
              additionalProperties: false as const,
            },
          },
        },
        additionalProperties: false as const,
      },
    },
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("setEditorDecorations");
      }
      const id = requireString(args, "id", 64);
      const file = resolveFilePath(requireString(args, "file"), workspace);
      const rawDecorations = optionalArray(args, "decorations") ?? [];
      const decorations: DecorationSpec[] = rawDecorations.map((d, i) => {
        if (typeof d !== "object" || d === null)
          throw new Error(`decorations[${i}] must be an object`);
        const dec = d as Record<string, unknown>;
        if (typeof dec.startLine !== "number")
          throw new Error(`decorations[${i}].startLine must be a number`);
        if (
          ![
            "info",
            "warning",
            "error",
            "focus",
            "strikethrough",
            "dim",
          ].includes(dec.style as string)
        )
          throw new Error(`decorations[${i}].style is invalid`);
        return dec as unknown as DecorationSpec;
      });
      try {
        const result = await extensionClient.setDecorations(
          id,
          file,
          decorations,
        );
        if (result === null) return error("Failed to set decorations");
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out setting decorations");
        }
        throw err;
      }
    },
  };
}

export function createClearEditorDecorationsTool(
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "clearEditorDecorations",
      extensionRequired: true,
      description:
        "Clear editor decorations. Pass an id to clear a specific decoration set, " +
        "or omit to clear all Claude-managed decorations. " +
        "Requires the VS Code extension.",
      annotations: { idempotentHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        properties: {
          id: {
            type: "string" as const,
            description: "Decoration set ID to clear. Omit to clear all.",
          },
        },
        additionalProperties: false as const,
      },
    },
    async handler(args: Record<string, unknown>) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("clearEditorDecorations");
      }
      const id = optionalString(args, "id", 64);
      try {
        const result = await extensionClient.clearDecorations(id);
        if (result === null) return error("Failed to clear decorations");
        return success(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out clearing decorations");
        }
        throw err;
      }
    },
  };
}
