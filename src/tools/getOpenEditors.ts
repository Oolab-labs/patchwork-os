import fs from "node:fs";
import path from "node:path";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  languageIdFromPath,
  resolveFilePath,
  successStructured,
} from "./utils.js";

export function createGetOpenEditorsTool(
  openedFiles: Set<string>,
  extensionClient?: ExtensionClient,
  workspace?: string,
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
      outputSchema: {
        type: "object",
        properties: {
          tabs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                uri: { type: "string" },
                fileName: { type: "string" },
                label: { type: "string" },
                languageId: { type: "string" },
                isActive: { type: "boolean" },
                isDirty: { type: "boolean" },
                lineCount: { type: "integer" },
              },
              required: [
                "uri",
                "fileName",
                "label",
                "languageId",
                "isActive",
                "isDirty",
              ],
            },
          },
          source: { type: "string", enum: ["vscode", "local-tracking"] },
        },
        required: ["tabs", "source"],
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
            return successStructured({ tabs, source: "vscode" });
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to local tracking fallback
        }
      }

      // Fallback: files tracked locally via openFile calls
      const tabs = [];
      const toEvict: string[] = [];
      for (const filePath of openedFiles) {
        if (workspace) {
          try {
            resolveFilePath(filePath, workspace);
          } catch {
            toEvict.push(filePath);
            continue;
          }
        }
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
          toEvict.push(filePath);
        }
      }
      for (const p of toEvict) openedFiles.delete(p);
      return successStructured({ tabs, source: "local-tracking" });
    },
  };
}
