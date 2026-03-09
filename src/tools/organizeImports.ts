import fs from "node:fs";
import { ExtensionTimeoutError, type ExtensionClient } from "../extensionClient.js";
import { requireString, resolveFilePath, success, error } from "./utils.js";

export function createOrganizeImportsTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "organizeImports",
      description:
        "Organize and sort imports in a file using VS Code's built-in organize imports action. Requires the VS Code extension to be connected — returns an error if disconnected (no CLI fallback available).",
      annotations: { destructiveHint: true, idempotentHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string",
            description: "Path to the file to organize imports in (relative to workspace or absolute)",
          },
        },
        required: ["filePath"],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
      const rawPath = requireString(args, "filePath");
      const resolved = resolveFilePath(rawPath, workspace);

      let contentBefore: string;
      try {
        contentBefore = fs.readFileSync(resolved, "utf-8");
      } catch {
        return error({ error: `File not found: ${rawPath}` });
      }

      if (!extensionClient.isConnected()) {
        return error({
          error: "Extension not connected — organize imports requires the VS Code extension",
        });
      }

      let result: unknown;
      try {
        result = await extensionClient.organizeImports(resolved);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out — organize imports may require more time");
        }
        throw err;
      }
      if (result === null) {
        return error({
          error: "Extension failed to organize imports",
        });
      }

      const contentAfter = fs.readFileSync(resolved, "utf-8");
      return success({
        organized: true,
        source: "extension",
        changes: contentBefore === contentAfter ? "none" : "modified",
        linesBeforeCount: contentBefore.split("\n").length,
        linesAfterCount: contentAfter.split("\n").length,
      });
    },
  };
}
