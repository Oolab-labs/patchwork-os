import type { ExtensionClient } from "../extensionClient.js";
import { lspColdStartError, lspWithRetry } from "./lsp.js";
import {
  extensionRequired,
  requireInt,
  requireString,
  resolveFilePath,
  success,
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
        "Get hierarchical selection boundaries at a position using VS Code LSP. " +
        "Returns an ordered array of ranges from innermost (word/token) to outermost (file), " +
        "e.g. identifier → expression → statement → block → function → class. " +
        "Useful for understanding scope containment and making scope-aware edits. " +
        "Requires the VS Code extension.",
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
            description: "1-based line number",
          },
          column: {
            type: "integer" as const,
            description: "1-based column number",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
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
        return success({ ranges: [], count: 0 });
      }
      const data = result as { ranges: unknown[] };
      return success({ ...data, count: data.ranges.length });
    },
  };
}
