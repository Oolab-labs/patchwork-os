import fs from "node:fs/promises";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import type { FileLock } from "../fileLock.js";
import {
  error,
  optionalBool,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

export function createReplaceBlockTool(
  workspace: string,
  extensionClient?: ExtensionClient,
  fileLock?: FileLock,
) {
  return {
    schema: {
      name: "replaceBlock",
      description:
        "Replace an exact block of text in a file by content match — no line numbers needed. " +
        "Safer than editText — fails clearly if content not found or ambiguous.",
      annotations: { destructiveHint: true },
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
            description:
              "The exact text to find and replace (must match precisely, including whitespace)",
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
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          saved: { type: "boolean" },
          source: { type: "string" },
        },
        required: ["success"],
      },
    },

    async handler(args: Record<string, unknown>) {
      const rawPath = requireString(args, "filePath");
      const oldContent = requireString(args, "oldContent", 65_536);
      const newContent = requireString(args, "newContent", 65_536);
      const save = optionalBool(args, "save") ?? true;

      if (oldContent.length === 0) {
        return error("oldContent must not be empty");
      }

      const filePath = resolveFilePath(rawPath, workspace, { write: true });

      // Try extension first — operates on the live buffer including unsaved changes
      if (extensionClient?.isConnected()) {
        try {
          const result = await extensionClient.replaceBlock(
            filePath,
            oldContent,
            newContent,
            save,
          );
          if (result !== null) {
            return successStructured(result);
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
        return error(
          "oldContent not found in file — verify the exact text including whitespace and line endings",
        );
      }

      const secondIndex = text.indexOf(oldContent, firstIndex + 1);
      if (secondIndex !== -1) {
        let count = 2;
        let idx = secondIndex;
        while ((idx = text.indexOf(oldContent, idx + 1)) !== -1) count++;
        return error(
          `oldContent matches ${count} locations — add more surrounding context to make it unique`,
        );
      }

      const newText =
        text.slice(0, firstIndex) +
        newContent +
        text.slice(firstIndex + oldContent.length);

      // Acquire per-file lock before write to serialize concurrent edits from multiple sessions
      const release = fileLock ? await fileLock.acquire(filePath) : null;
      try {
        // Optimistic concurrency check — detect concurrent modification
        const statAfter = await fs.stat(filePath);
        if (statAfter.mtimeMs !== originalMtimeMs) {
          return error("File was modified concurrently — retry the edit");
        }
        await fs.writeFile(filePath, newText, "utf-8");
      } finally {
        release?.();
      }

      return successStructured({
        success: true,
        saved: save,
        source: "native-fs",
      });
    },
  };
}
