import type { ExtensionClient } from "../extensionClient.js";
import { lspColdStartError, lspWithRetry } from "./lsp.js";
import {
  extensionRequired,
  requireString,
  resolveFilePath,
  successStructured,
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
        "Get file references and URLs in a document. File links are workspace-relative.",
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
          links: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                url: { type: "string" as const },
                range: { type: "object" as const },
                tooltip: { type: "string" as const },
              },
              required: ["url"],
            },
          },
          count: { type: "number" as const },
        },
        required: ["links", "count"],
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
      if (result === null) return successStructured({ links: [], count: 0 });
      return successStructured(result);
    },
  };
}
