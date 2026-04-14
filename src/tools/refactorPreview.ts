import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  extensionRequired,
  requireInt,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

export function createRefactorPreviewTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "refactorPreview",
      description:
        "Preview refactoring edits across files without applying. Use getCodeActions first.",
      extensionRequired: true,
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string",
            description: "Absolute or workspace-relative path",
          },
          startLine: {
            type: "integer",
            description: "Start line (1-based)",
          },
          startColumn: {
            type: "integer",
            description: "Start column (1-based)",
          },
          endLine: {
            type: "integer",
            description: "End line (1-based)",
          },
          endColumn: {
            type: "integer",
            description: "End column (1-based)",
          },
          actionTitle: {
            type: "string",
            description: "Exact action title from getCodeActions output",
          },
        },
        required: [
          "filePath",
          "startLine",
          "startColumn",
          "endLine",
          "endColumn",
          "actionTitle",
        ],
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string" as const },
          changes: {
            type: "array" as const,
            items: { type: "object" as const },
          },
          totalFiles: { type: "number" as const },
          totalEdits: { type: "number" as const },
          note: { type: "string" as const },
        },
        required: ["title", "changes"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("refactorPreview", [
          "Use getCodeActions + applyCodeAction to apply refactorings directly",
        ]);
      }

      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const startLine = requireInt(args, "startLine");
      const startColumn = requireInt(args, "startColumn");
      const endLine = requireInt(args, "endLine");
      const endColumn = requireInt(args, "endColumn");
      const actionTitle = requireString(args, "actionTitle");

      let result: unknown;
      try {
        result = await extensionClient.previewCodeAction(
          filePath,
          startLine,
          startColumn,
          endLine,
          endColumn,
          actionTitle,
          signal,
        );
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Language server timed out — it may still be indexing. " +
              "Wait a few seconds and try again.",
          );
        }
        throw err;
      }

      if (!result) return error("No response from extension");
      const r = result as Record<string, unknown>;
      if (typeof r.error === "string") return error(r.error);
      return successStructured(result);
    },
  };
}
