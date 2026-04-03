import type { ExtensionClient } from "../extensionClient.js";
import { lspColdStartError, lspWithRetry } from "./lsp.js";
import {
  extensionRequired,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

export function createFoldingRangesTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "foldingRanges",
      extensionRequired: true,
      description:
        "Get foldable code regions in a file using VS Code LSP: functions, classes, imports, comments, and regions. " +
        "Useful for understanding the high-level structure of a large file and identifying block boundaries. " +
        "Returns an array of { startLine, endLine, kind } objects. " +
        "Requires the VS Code extension.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative file path",
          },
        },
        required: ["filePath"],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      if (!extensionClient.isConnected()) {
        return extensionRequired("foldingRanges (LSP folding regions)", [
          "Use getDocumentSymbols to get the structural outline of the file",
        ]);
      }
      const result = await lspWithRetry(
        () => extensionClient.foldingRanges(filePath, signal),
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
