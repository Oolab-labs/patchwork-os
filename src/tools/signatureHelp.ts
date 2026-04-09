import type { ExtensionClient } from "../extensionClient.js";
import { lspColdStartError, lspWithRetry } from "./lsp.js";
import {
  extensionRequired,
  requireInt,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

export function createSignatureHelpTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "signatureHelp",
      extensionRequired: true,
      description:
        "Get function signature documentation and parameter info at a call site. " +
        "Returns the active signature, parameter index, and all overloads with docs. ",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative file path",
          },
          line: {
            type: "integer" as const,
            description: "1-based line number (inside a function call)",
          },
          column: {
            type: "integer" as const,
            description: "1-based column number (inside a function call)",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          activeSignature: { type: "integer" },
          activeParameter: { type: "integer" },
          signatures: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                documentation: { type: ["string", "null"] },
                parameters: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: ["string", "array"] },
                      documentation: { type: ["string", "null"] },
                    },
                  },
                },
              },
            },
          },
        },
        required: ["found"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line", 1);
      const column = requireInt(args, "column", 1);
      if (!extensionClient.isConnected()) {
        return extensionRequired("signatureHelp (LSP signature info)", [
          "Use getHover to get type information about a function",
          "Use goToDefinition to navigate to the function definition",
        ]);
      }
      const result = await lspWithRetry(
        () => extensionClient.signatureHelp(filePath, line, column, signal),
        signal,
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return successStructured({ found: false });
      }
      return successStructured({ found: true, ...(result as object) });
    },
  };
}
