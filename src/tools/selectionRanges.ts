import type { ExtensionClient } from "../extensionClient.js";
import { lspColdStartError, lspWithRetry } from "./lsp.js";
import {
  extensionRequired,
  requireInt,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

export function createSelectionRangesTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "selectionRanges",
      extensionRequired: true,
      description:
        "Hierarchical selection ranges at position: identifier→expression→block→function→class.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Workspace or absolute path",
          },
          line: {
            type: "integer" as const,
            description: "Line number (1-based)",
          },
          column: {
            type: "integer" as const,
            description: "Column (1-based)",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          ranges: {
            type: "array" as const,
            items: { type: "object" as const },
          },
          count: { type: "number" as const },
        },
        required: ["ranges", "count"],
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
        return extensionRequired("selectionRanges (LSP selection hierarchy)", [
          "Use getDocumentSymbols to get the structural outline of the file",
        ]);
      }
      const result = await lspWithRetry(
        () => extensionClient.selectionRanges(filePath, line, column, signal),
        signal,
      );
      if (result === "timeout") return lspColdStartError();
      if (result === null) {
        return successStructured({ ranges: [], count: 0 });
      }
      const data = result as { ranges: unknown[] };
      return successStructured({ ...data, count: data.ranges.length });
    },
  };
}
