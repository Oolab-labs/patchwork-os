import { spawn } from "node:child_process";
import fs from "node:fs";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  findLineNumber,
  optionalInt,
  optionalString,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

export function createOpenFileTool(
  workspace: string,
  editorCommand: string | null,
  openedFiles: Set<string>,
  extensionClient?: ExtensionClient,
) {
  return {
    schema: {
      name: "openFile",
      description:
        "Open a file in the editor and optionally select a range of text",
      annotations: {
        title: "Open File in Editor",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        required: ["filePath"],
        properties: {
          filePath: {
            type: "string",
            description:
              "Absolute or workspace-relative path to the file to open",
          },
          startLine: {
            type: "integer",
            minimum: 1,
            description:
              "Line number to scroll to (1-based). If both startLine and startText are provided, startLine takes precedence.",
          },
          startText: {
            type: "string",
            description:
              "Text pattern to find and scroll to. If both startLine and startText are provided, startLine takes precedence.",
          },
        },
      },
    },

    async handler(args: Record<string, unknown>) {
      const rawPath = requireString(args, "filePath");
      const startText = optionalString(args, "startText", 512);
      const startLine = optionalInt(args, "startLine");

      const filePath = resolveFilePath(rawPath, workspace);

      if (!fs.existsSync(filePath)) {
        return error(`File not found: ${filePath}`);
      }

      // Cap tracked files to prevent unbounded memory growth
      if (openedFiles.size >= 500) {
        const oldest = openedFiles.values().next().value;
        if (oldest) openedFiles.delete(oldest);
      }
      openedFiles.add(filePath);

      // Prefer extension path when connected — works in remote/container environments
      // and supports precise cursor positioning
      if (extensionClient?.isConnected()) {
        let line: number | undefined;
        // startLine takes precedence over startText (matches CLI fallback behaviour and schema docs)
        if (startLine) {
          line = startLine;
        } else if (startText) {
          const found = await findLineNumber(filePath, startText);
          if (found) line = found;
        }
        try {
          const result = await extensionClient.openFile(filePath, line);
          return success({ success: result, filePath, via: "extension" });
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to CLI fallback
        }
      }

      if (!editorCommand) {
        return success({
          success: true,
          filePath,
          tracked: true,
          message:
            "No editor command configured (headless VPS or SSH remote without GUI IDE). " +
            "File recorded internally — use getBufferContent, editText, or replaceBlock to work with it directly.",
        });
      }

      // Fallback: CLI spawn
      let gotoArg = filePath;
      if (startText) {
        const line = await findLineNumber(filePath, startText);
        if (line) gotoArg = `${filePath}:${line}`;
      } else if (startLine) {
        gotoArg = `${filePath}:${startLine}`;
      }

      try {
        const child = spawn(
          editorCommand,
          ["--reuse-window", "--goto", gotoArg],
          {
            detached: true,
            stdio: "ignore",
          },
        );
        child.on("error", () => {}); // Prevent unhandled error events
        child.unref();
        return success({ success: true, filePath });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return error(
          `Failed to launch "${editorCommand}": ${errMsg}. Try --editor or CLAUDE_IDE_BRIDGE_EDITOR env var.`,
        );
      }
    },
  };
}
