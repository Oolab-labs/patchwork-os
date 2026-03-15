import fs from "node:fs";
import type { ExtensionClient } from "../extensionClient.js";
import {
  extensionRequired,
  requireInt,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

export function createRefactorExtractFunctionTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "refactorExtractFunction",
      description:
        "Extract selected lines of code into a new named function. Uses VS Code's built-in Extract Function code action when available, with a text-manipulation fallback.",
      annotations: { destructiveHint: true },
      extensionRequired: true,
      inputSchema: {
        type: "object" as const,
        properties: {
          file: {
            type: "string",
            description: "File path (relative to workspace)",
          },
          startLine: {
            type: "number",
            description: "Start line (1-indexed)",
          },
          endLine: {
            type: "number",
            description: "End line (1-indexed)",
          },
          functionName: {
            type: "string",
            description: "Name for the extracted function",
          },
        },
        required: ["file", "startLine", "endLine", "functionName"],
        additionalProperties: false as const,
      },
    },
    timeoutMs: 30_000,

    async handler(
      args: Record<string, unknown>,
      _signal?: AbortSignal,
    ): Promise<
      ReturnType<typeof success> | ReturnType<typeof extensionRequired>
    > {
      if (!extensionClient.isConnected()) {
        return extensionRequired("refactorExtractFunction");
      }

      const file = requireString(args, "file");
      const startLine = requireInt(args, "startLine", 1, 1_000_000);
      const endLine = requireInt(args, "endLine", 1, 1_000_000);
      const functionName = requireString(args, "functionName");

      let absPath: string;
      try {
        absPath = resolveFilePath(file, workspace);
      } catch (err) {
        return success({
          refactored: false,
          method: "none",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Strategy 1: Try VS Code code actions
      try {
        const actions = await extensionClient.getCodeActions(
          absPath,
          startLine,
          1,
          endLine,
          9999,
        );

        const actionsArray = Array.isArray(actions)
          ? actions
          : ((actions as { actions?: unknown[] })?.actions ?? []);

        const extractAction = (
          actionsArray as Array<{
            title?: string;
            id?: string;
            command?: string;
          }>
        ).find((a) => a.title && /extract/i.test(a.title));

        if (extractAction) {
          const actionTitle = extractAction.title ?? "";
          await extensionClient.applyCodeAction(
            absPath,
            startLine,
            1,
            endLine,
            9999,
            actionTitle,
          );
          return success({
            refactored: true,
            method: "codeAction",
            message: `Applied VS Code code action: "${actionTitle}"`,
          });
        }
      } catch {
        // fall through to text manipulation
      }

      // Strategy 2: Text manipulation fallback
      try {
        const content = fs.readFileSync(absPath, "utf-8");
        const lines = content.split("\n");
        const extracted = lines.slice(startLine - 1, endLine);
        const indent = "  ";
        const body = extracted.map((l) => `${indent}${l}`).join("\n");
        const newFunction = `function ${functionName}() {\n${body}\n}\n`;

        // Find insertion point: insert new function before the extracted block,
        // then replace the extracted block with a call expression.
        const insertAt = startLine - 1; // index of first extracted line (0-based)
        const newLines = [
          ...lines.slice(0, insertAt),
          newFunction,
          `${functionName}();`,
          ...lines.slice(endLine),
        ];

        fs.writeFileSync(absPath, newLines.join("\n"), "utf-8");

        return success({
          refactored: true,
          method: "textManipulation",
          message: `Extracted lines ${startLine}-${endLine} into function \`${functionName}\` using text manipulation. Review the result and adjust parameters/return values as needed.`,
        });
      } catch (err) {
        return success({
          refactored: false,
          method: "none",
          message: `Refactor failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
