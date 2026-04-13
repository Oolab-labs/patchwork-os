import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  extensionRequired,
  requireInt,
  requireString,
  successStructured,
} from "./utils.js";

export function createGetTypeSignatureTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "getTypeSignature",
      extensionRequired: true,
      description:
        "Type signature for symbol at position via LSP hover. Returns clean signature from hover markdown.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["file", "line", "column"],
        properties: {
          file: { type: "string" },
          line: { type: "integer", minimum: 1 },
          column: { type: "integer", minimum: 1 },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          found: { type: "boolean" as const },
          file: { type: "string" as const },
          line: { type: "integer" as const },
          column: { type: "integer" as const },
          signature: { type: "string" as const },
          raw: { type: "array" as const, items: { type: "string" as const } },
        },
        required: ["found", "file", "line", "column"],
      },
    },
    async handler(args: Record<string, unknown>) {
      const file = requireString(args, "file");
      const line = requireInt(args, "line", 1);
      const column = requireInt(args, "column", 1);

      if (!extensionClient.isConnected()) {
        return extensionRequired("getTypeSignature");
      }

      try {
        const result = await extensionClient.getHover(file, line, column);

        if (result === null || result === undefined) {
          return successStructured({ found: false, file, line, column });
        }

        // Extract contents array from hover result
        const hover = result as Record<string, unknown>;
        const contents: string[] = [];
        if (Array.isArray(hover.contents)) {
          for (const c of hover.contents) {
            if (typeof c === "string") contents.push(c);
            else if (
              c &&
              typeof c === "object" &&
              typeof (c as Record<string, unknown>).value === "string"
            ) {
              contents.push((c as Record<string, unknown>).value as string);
            }
          }
        } else if (hover.markdown && typeof hover.markdown === "string") {
          contents.push(hover.markdown);
        }

        if (contents.length === 0) {
          return successStructured({ found: false, file, line, column });
        }

        // Try to extract a fenced code block from any content string
        let signature: string | null = null;
        for (const content of contents) {
          const match = content.match(/```(?:typescript|ts)\n([\s\S]*?)```/);
          if (match) {
            signature = match[1]?.trim() ?? null;
            break;
          }
        }

        // Fall back to first non-empty content string
        if (!signature) {
          signature = contents.find((c) => c.trim().length > 0)?.trim() ?? null;
        }

        if (!signature) {
          return successStructured({ found: false, file, line, column });
        }

        return successStructured({
          found: true,
          file,
          line,
          column,
          signature,
          raw: contents,
        });
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out getting type signature");
        }
        throw err;
      }
    },
  };
}
