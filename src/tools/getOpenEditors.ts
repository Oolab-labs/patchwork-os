import fs from "node:fs";
import path from "node:path";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { languageIdFromPath, success } from "./utils.js";

export function createGetOpenEditorsTool(
  openedFiles: Set<string>,
  extensionClient?: ExtensionClient,
) {
  return {
    schema: {
      name: "getOpenEditors",
      description:
        "Get list of currently open files/tabs. Uses real VS Code tab state when the extension is connected (includes isDirty, isActive, and all open tabs). Without the extension, returns only files that Claude Code has opened in this session.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
      },
    },

    async handler() {
      // Use extension for real tab state when available
      if (extensionClient?.isConnected()) {
        try {
          const result = await extensionClient.getOpenFiles();
          if (result !== null && Array.isArray(result)) {
            // result is TabInfo[] — enrich with languageId and lineCount from disk (async)
            const tabs = await Promise.all(
              result.map(async (tab) => {
                let lineCount: number | undefined;
                try {
                  const stat = await fs.promises.stat(tab.filePath);
                  lineCount = Math.max(1, Math.ceil(stat.size / 40));
                } catch {
                  lineCount = undefined;
                }
                return {
                  uri: `file://${tab.filePath}`,
                  isActive: tab.isActive,
                  isDirty: tab.isDirty,
                  label: path.basename(tab.filePath),
                  fileName: tab.filePath,
                  languageId:
                    tab.languageId ?? languageIdFromPath(tab.filePath),
                  lineCount,
                  source: "vscode",
                };
              }),
            );
            return success({ tabs, source: "vscode" });
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to local tracking fallback
        }
      }

      // Fallback: files tracked locally via openFile calls
      const tabs = [];
      for (const filePath of openedFiles) {
        try {
          const stat = await fs.promises.stat(filePath);
          const estimatedLines = Math.max(1, Math.ceil(stat.size / 40));
          tabs.push({
            uri: `file://${filePath}`,
            isActive: false,
            isPinned: false,
            isPreview: false,
            isDirty: false,
            label: path.basename(filePath),
            groupIndex: 0,
            viewColumn: 1,
            isGroupActive: false,
            fileName: filePath,
            languageId: languageIdFromPath(filePath),
            lineCount: estimatedLines,
            isUntitled: false,
          });
        } catch {
          // file may have been deleted
          openedFiles.delete(filePath);
        }
      }
      return success({ tabs, source: "local-tracking" });
    },
  };
}
