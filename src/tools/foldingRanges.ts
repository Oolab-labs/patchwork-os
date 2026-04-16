import type { ExtensionClient } from "../extensionClient.js";
import { lspColdStartError, lspWithRetry } from "./lsp.js";
import {
  extensionRequired,
  requireString,
  resolveFilePath,
  successStructured,
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
        "Foldable regions in a file (functions, classes, imports, comments). Returns {startLine, endLine, kind}.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Workspace or absolute file path",
          },
        },
        required: ["filePath"],
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
        return successStructured({ ranges: [], count: 0 });
      }
      const data = result as { ranges: unknown[] };
      return successStructured({ ...data, count: data.ranges.length });
    },
  };
}
