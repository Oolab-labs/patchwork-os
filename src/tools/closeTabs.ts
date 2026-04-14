import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { cleanupTempDirs, trackedTempDirCount } from "./openDiff.js";
import {
  error,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

export function createCloseTabTool(
  workspace?: string,
  extensionClient?: ExtensionClient,
) {
  return {
    schema: {
      name: "closeTab",
      extensionRequired: true,
      description:
        "Close editor tab by file path. Prompts to save if dirty. Requires ext.",
      annotations: { destructiveHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        required: ["filePath"],
        properties: {
          filePath: {
            type: "string",
            description:
              "File whose tab to close (absolute or workspace-relative)",
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          filePath: { type: "string" },
          closed: { type: "boolean" },
        },
        required: ["success"],
      },
    },
    async handler(args: Record<string, unknown>) {
      const rawPath = requireString(args, "filePath", 4096);
      const filePath = workspace
        ? resolveFilePath(rawPath, workspace)
        : rawPath;

      if (!extensionClient?.isConnected()) {
        return error("closeTab requires the VS Code extension to be connected");
      }

      try {
        const result = await extensionClient.closeTab(filePath);
        if (result === null) {
          return error("Failed to close tab — extension returned no result");
        }
        if (result.success) {
          return successStructured({
            success: true,
            filePath,
            closed: true,
            ...(result.promptedToSave !== undefined && {
              promptedToSave: result.promptedToSave,
            }),
          });
        }
        return error(
          result.error ?? "Failed to close tab — file may not be open",
        );
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out while closing tab");
        }
        throw err;
      }
    },
  };
}

export function createCloseAllDiffTabsTool() {
  return {
    schema: {
      name: "closeAllDiffTabs",
      description: "Close all diff tabs and clean up temp diff directories.",
      annotations: { destructiveHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          message: { type: "string" },
        },
        required: ["success"],
      },
    },
    async handler() {
      const count = trackedTempDirCount();
      cleanupTempDirs();
      return successStructured({
        success: true,
        message: `${count} diff temp dirs cleaned up`,
      });
    },
  };
}
