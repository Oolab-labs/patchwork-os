import type { ExtensionClient } from "../extensionClient.js";
import { lspColdStartError, lspWithRetry } from "./lsp.js";
import {
  extensionRequired,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

export function createGetDocumentLinksTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getDocumentLinks",
      extensionRequired: true,
      description:
        "Get document links (file references, URLs) in a file as identified by the language server. " +
        "Useful for navigating to referenced files or external documentation. " +
        "File links are workspace-relative; private/internal URLs are omitted. " +
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
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getDocumentLinks");
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );

      const result = await lspWithRetry(
        () =>
          extensionClient.getDocumentLinks(filePath, signal) as Promise<
            unknown | null
          >,
        signal,
      );

      if (result === "timeout") return lspColdStartError();
      if (result === null) return success({ links: [], count: 0 });
      return success(result);
    },
  };
}
