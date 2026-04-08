import type { ExtensionClient } from "../extensionClient.js";
import { lspColdStartError, lspWithRetry } from "./lsp.js";
import {
  extensionRequired,
  optionalInt,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

export function createGetSemanticTokensTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getSemanticTokens",
      extensionRequired: true,
      description:
        "Get semantic token classification for a file. Returns each token's type " +
        "(variable, function, class, parameter, type, etc.) and modifiers " +
        "(declaration, readonly, deprecated, async, etc.) from the language server. " +
        "Useful for understanding code structure without parsing — e.g. distinguishing " +
        "a function call from a type reference, spotting deprecated APIs. " +
        "Requires the VS Code extension.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative file path",
          },
          startLine: {
            type: "integer" as const,
            description: "First line to include (1-based, optional)",
            minimum: 1,
          },
          endLine: {
            type: "integer" as const,
            description: "Last line to include (1-based, inclusive, optional)",
            minimum: 1,
          },
          maxTokens: {
            type: "integer" as const,
            description:
              "Maximum number of tokens to return (default 2000, max 5000)",
            minimum: 1,
            maximum: 5000,
          },
        },
        required: ["filePath"],
        additionalProperties: false as const,
      },
    },
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getSemanticTokens");
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const startLine = optionalInt(args, "startLine");
      const endLine = optionalInt(args, "endLine");
      const maxTokens = optionalInt(args, "maxTokens");

      const result = await lspWithRetry(
        () =>
          extensionClient.getSemanticTokens(
            filePath,
            startLine ?? undefined,
            endLine ?? undefined,
            maxTokens ?? undefined,
            signal,
          ) as Promise<unknown | null>,
        signal,
      );

      if (result === "timeout") return lspColdStartError();
      if (result === null)
        return success({
          tokens: [],
          count: 0,
          capped: false,
          legend: { tokenTypes: [], tokenModifiers: [] },
        });
      return success(result);
    },
  };
}
