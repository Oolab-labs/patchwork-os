import type { ExtensionClient } from "../extensionClient.js";
import {
  error,
  extensionRequired,
  requireInt,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

export function createRefactorPreviewTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "refactorPreview",
      description:
        "Preview what a code action or refactoring would change across files WITHOUT applying it. Use getCodeActions first to see available actions, then pass the action title here to see the diff preview.",
      extensionRequired: true,
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string",
            description: "Path to the file (absolute or workspace-relative)",
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
            description:
              "Exact title of the code action (from getCodeActions output)",
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

      const result = await extensionClient.previewCodeAction(
        filePath,
        startLine,
        startColumn,
        endLine,
        endColumn,
        actionTitle,
        signal,
      );

      if (!result) return error("No response from extension");
      const r = result as Record<string, unknown>;
      if (typeof r.error === "string") return error(r.error);
      return success(result);
    },
  };
}
