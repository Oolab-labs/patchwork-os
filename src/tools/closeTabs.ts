import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { cleanupTempDirs, trackedTempDirCount } from "./openDiff.js";
import { error, requireString, resolveFilePath, success } from "./utils.js";

export function createCloseTabTool(
  workspace?: string,
  extensionClient?: ExtensionClient,
) {
  return {
    schema: {
      name: "closeTab",
      extensionRequired: true,
      description:
        "Close a specific editor tab by file path. Uses VS Code when the extension is connected (prompts to save if dirty). Without the extension, this operation is not available.",
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
              "Path to the file whose tab should be closed (absolute or workspace-relative)",
          },
        },
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
        if (result === true) {
          return success({ success: true, filePath, closed: true });
        }
        if (result !== null && typeof result === "object") {
          const r = result as Record<string, unknown>;
          if (r.success === false) {
            return error(r.error ?? "Failed to close tab");
          }
          return success(result);
        }
        return error("Failed to close tab — file may not be open");
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
      description:
        "Close all diff tabs in the editor and clean up temporary diff directories",
      annotations: { destructiveHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
      },
    },
    async handler() {
      const count = trackedTempDirCount();
      cleanupTempDirs();
      return success({
        success: true,
        message: `${count} diff temp dirs cleaned up`,
      });
    },
  };
}
