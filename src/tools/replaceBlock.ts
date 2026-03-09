import fs from "node:fs/promises";
import { ExtensionTimeoutError, type ExtensionClient } from "../extensionClient.js";
import { requireString, optionalBool, resolveFilePath, success, error } from "./utils.js";

export function createReplaceBlockTool(workspace: string, extensionClient?: ExtensionClient) {
  return {
    schema: {
      name: "replaceBlock",
      description:
        "Replace an exact block of text in a file by content match — no line numbers needed. " +
        "Finds the exact oldContent string in the file and replaces it with newContent. " +
        "Safer than editText because it verifies the content exists before applying. " +
        "Fails with a clear error if oldContent is not found or appears more than once. " +
        "Use getBufferContent first to get the current text if the file may have unsaved changes. " +
        "Saves the file by default (save: true).",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object" as const,
        required: ["filePath", "oldContent", "newContent"],
        additionalProperties: false as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative file path",
          },
          oldContent: {
            type: "string" as const,
            description: "The exact text to find and replace (must match precisely, including whitespace)",
          },
          newContent: {
            type: "string" as const,
            description: "The text to replace oldContent with",
          },
          save: {
            type: "boolean" as const,
            description: "Save after replacing (default: true)",
          },
        },
      },
    },

    async handler(args: Record<string, unknown>) {
      const rawPath = requireString(args, "filePath");
      const oldContent = requireString(args, "oldContent");
      const newContent = requireString(args, "newContent");
      const save = optionalBool(args, "save") ?? true;

      if (oldContent.length === 0) {
        return error("oldContent must not be empty");
      }

      const filePath = resolveFilePath(rawPath, workspace);

      // Try extension first — operates on the live buffer including unsaved changes
      if (extensionClient?.isConnected()) {
        try {
          const result = await extensionClient.replaceBlock(filePath, oldContent, newContent, save);
          if (result !== null) {
            return success(result);
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to native fallback
        }
      }

      // Native fallback — operates on disk content
      let text: string;
      let originalMtimeMs: number;
      try {
        const stat = await fs.stat(filePath);
        originalMtimeMs = stat.mtimeMs;
        text = await fs.readFile(filePath, "utf-8");
      } catch {
        return error(`File not found: ${filePath}`);
      }

      const firstIndex = text.indexOf(oldContent);
      if (firstIndex === -1) {
        return error("oldContent not found in file — verify the exact text including whitespace and line endings");
      }

      const secondIndex = text.indexOf(oldContent, firstIndex + 1);
      if (secondIndex !== -1) {
        let count = 2;
        let idx = secondIndex;
        while ((idx = text.indexOf(oldContent, idx + 1)) !== -1) count++;
        return error(`oldContent matches ${count} locations — add more surrounding context to make it unique`);
      }

      const newText = text.slice(0, firstIndex) + newContent + text.slice(firstIndex + oldContent.length);

      // Optimistic concurrency check — detect concurrent modification
      const statAfter = await fs.stat(filePath);
      if (statAfter.mtimeMs !== originalMtimeMs) {
        return error("File was modified concurrently — retry the edit");
      }
      await fs.writeFile(filePath, newText, "utf-8");

      return success({ success: true, saved: save, source: "native-fs" });
    },
  };
}
