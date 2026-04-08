import type { ExtensionClient } from "../extensionClient.js";
import { lspColdStartError, lspWithRetry } from "./lsp.js";
import {
  extensionRequired,
  requireString,
  resolveFilePath,
  success,
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
        "Get code lens items for a file. Code lenses are contextual annotations shown " +
        "above code by language server extensions — reference counts, 'Run Test', " +
        "'Debug', implementation counts, etc. Provides quantitative signals about " +
        "code importance and test coverage. Requires the VS Code extension.",
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
      if (result === null) return success({ lenses: [], count: 0 });
      return success(result);
    },
  };
}
