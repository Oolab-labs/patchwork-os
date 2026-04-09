import type { ExtensionClient } from "../extensionClient.js";
import { lspColdStartError, lspWithRetry } from "./lsp.js";
import {
  extensionRequired,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

export function createGetCodeLensTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getCodeLens",
      extensionRequired: true,
      description:
        "Get code lens items for a file: reference counts, Run Test/Debug buttons, and implementation counts " +
        "shown above code by the language server. Useful for quantitative code coverage signals.",
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
      outputSchema: {
        type: "object" as const,
        properties: {
          lenses: {
            type: "array" as const,
            items: { type: "object" as const },
          },
          count: { type: "number" as const },
        },
        required: ["lenses", "count"],
      },
    },
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getCodeLens");
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );

      const result = await lspWithRetry(
        () =>
          extensionClient.getCodeLens(filePath, signal) as Promise<
            unknown | null
          >,
        signal,
      );

      if (result === "timeout") return lspColdStartError();
      if (result === null) return successStructured({ lenses: [], count: 0 });
      return successStructured(result);
    },
  };
}
