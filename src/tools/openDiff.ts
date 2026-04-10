import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  error,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

const MAX_DIFF_CONTENT_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_TRACKED_DIRS = 10;
const trackedTempDirs = new Set<string>();

export function trackedTempDirCount(): number {
  return trackedTempDirs.size;
}

export function cleanupTempDirs(): void {
  for (const dir of trackedTempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  trackedTempDirs.clear();
}

export function createOpenDiffTool(
  workspace: string,
  editorCommand: string | null,
) {
  return {
    schema: {
      name: "openDiff",
      description:
        "Open a diff view comparing old file content with new file content. Creates temporary files on disk.",
      annotations: { destructiveHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        required: ["oldFilePath", "newFilePath", "newFileContents", "tabName"],
        properties: {
          oldFilePath: {
            type: "string",
            description: "Path to the old file",
          },
          newFilePath: {
            type: "string",
            description: "Path to the new file",
          },
          newFileContents: {
            type: "string",
            description: "Contents for the new file version",
          },
          tabName: { type: "string", description: "Name for the diff tab" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          oldPath: { type: "string" },
          newPath: { type: "string" },
          message: { type: "string" },
        },
        required: ["success"],
      },
    },

    async handler(args: Record<string, unknown>) {
      const rawOldPath = requireString(args, "oldFilePath");
      const rawNewPath = requireString(args, "newFilePath");
      const newContents = requireString(
        args,
        "newFileContents",
        MAX_DIFF_CONTENT_BYTES,
      );
      requireString(args, "tabName", 256);

      const oldPath = resolveFilePath(rawOldPath, workspace);

      if (Buffer.byteLength(newContents, "utf-8") > MAX_DIFF_CONTENT_BYTES) {
        return error("newFileContents exceeds 5 MB limit");
      }

      // Validate basename of newFilePath
      const baseName = path.basename(rawNewPath);
      if (!baseName || baseName === "." || baseName === "..") {
        return error("newFilePath has an invalid basename");
      }

      // Write new contents to a temp file
      const tmpDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "claude-diff-"),
      );
      let tmpFile = "";
      try {
        await fs.promises.chmod(tmpDir, 0o700);
        trackedTempDirs.add(tmpDir);
        // Evict oldest temp dirs if over the cap
        if (trackedTempDirs.size > MAX_TRACKED_DIRS) {
          const oldest = trackedTempDirs.values().next().value;
          if (oldest) {
            try {
              fs.rmSync(oldest, { recursive: true, force: true });
            } catch {
              /* best-effort */
            }
            trackedTempDirs.delete(oldest);
          }
        }
        tmpFile = path.join(tmpDir, baseName);
        await fs.promises.writeFile(tmpFile, newContents);
      } catch (err) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        trackedTempDirs.delete(tmpDir);
        throw err;
      }

      if (!editorCommand) {
        return successStructured({
          success: true,
          message: "No editor command — diff files written",
          oldPath,
          newPath: tmpFile,
        });
      }

      try {
        const child = spawn(editorCommand, ["--diff", oldPath, tmpFile], {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", () => {}); // Prevent unhandled error events
        child.unref();
        return successStructured({ success: true, oldPath, newPath: tmpFile });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return error(`Failed to open diff: ${message}`);
      }
    },
  };
}
