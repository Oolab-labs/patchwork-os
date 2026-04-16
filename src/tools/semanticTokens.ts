import type { ExtensionClient } from "../extensionClient.js";
import { lspColdStartError, lspWithRetry } from "./lsp.js";
import {
  extensionRequired,
  optionalInt,
  requireString,
  resolveFilePath,
  successStructured,
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
        "Semantic token types and modifiers for a file from the language server.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Workspace or absolute path",
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
            description: "Max tokens to return (default: 2000, max: 5000)",
            minimum: 1,
            maximum: 5000,
          },
        },
        required: ["filePath"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          tokens: {
            type: "array" as const,
            items: { type: "object" as const },
          },
          count: { type: "number" as const },
          capped: { type: "boolean" as const },
          legend: {
            type: "object" as const,
            properties: {
              tokenTypes: {
                type: "array" as const,
                items: { type: "string" as const },
              },
              tokenModifiers: {
                type: "array" as const,
                items: { type: "string" as const },
              },
            },
            required: ["tokenTypes", "tokenModifiers"],
          },
        },
        required: ["tokens", "count", "capped", "legend"],
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
        return successStructured({
          tokens: [],
          count: 0,
          capped: false,
          legend: { tokenTypes: [], tokenModifiers: [] },
        });
      return successStructured(result);
    },
  };
}
