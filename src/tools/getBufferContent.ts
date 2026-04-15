import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import readline from "node:readline";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  optionalInt,
  requireString,
  resolveFilePath,
  successStructuredLarge,
} from "./utils.js";

const MAX_CONTENT_BYTES = 512 * 1024; // 512 KB hard cap

/**
 * Read lines [startLine, endLine] from a large file without loading the whole
 * file into memory. Uses readline so only the needed lines are buffered.
 * Returns null if the file cannot be read.
 */
async function readLineRange(
  filePath: string,
  startLine: number, // 1-based inclusive
  endLine: number, // 1-based inclusive
  signal?: AbortSignal,
): Promise<{ lines: string[]; totalLines: number } | null> {
  return new Promise((resolve) => {
    let lineNum = 0;
    const collected: string[] = [];

    let stream: ReturnType<typeof createReadStream>;
    try {
      stream = createReadStream(filePath, { encoding: "utf-8" });
    } catch {
      return resolve(null);
    }

    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    rl.on("line", (line) => {
      lineNum++;
      if (lineNum >= startLine && lineNum <= endLine) {
        collected.push(line);
      }
      // Continue counting past the range to get accurate totalLines
    });

    rl.on("close", () => {
      resolve({ lines: collected, totalLines: lineNum });
    });

    rl.on("error", () => {
      rl.close();
      stream.destroy();
      resolve(null);
    });
    stream.on("error", () => {
      rl.close();
      stream.destroy();
      resolve(null);
    });

    signal?.addEventListener("abort", () => {
      rl.close();
      stream.destroy();
      resolve(null);
    });
  });
}

export function createGetBufferContentTool(
  workspace: string,
  extensionClient?: ExtensionClient,
) {
  return {
    schema: {
      name: "getBufferContent",
      description:
        "Read workspace file from VS Code buffer including unsaved changes. Use before editText. Returns isDirty flag. Workspace files only.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["filePath"],
        additionalProperties: false as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path",
          },
          startLine: {
            type: "integer" as const,
            description: "First line to include (1-based, default: 1)",
            minimum: 1,
          },
          endLine: {
            type: "integer" as const,
            description: "Last line to include (1-based, default: all lines)",
            minimum: 1,
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "File or buffer content (may be sliced by startLine/endLine)",
          },
          filePath: { type: "string" },
          startLine: { type: "integer" },
          endLine: { type: "integer" },
          totalLines: { type: "integer" },
          isDirty: {
            type: "boolean",
            description:
              "True when the buffer has unsaved changes (extension only)",
          },
          languageId: { type: "string" },
          source: {
            type: "string",
            enum: ["extension", "disk"],
            description:
              "Whether content came from the live VS Code buffer or disk",
          },
        },
        required: ["content", "filePath"],
      },
    },

    // 15s: disk fallback on slow VPS storage or large files via readline streaming
    timeoutMs: 15_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const rawPath = requireString(args, "filePath");
      const filePath = resolveFilePath(rawPath, workspace);
      const startLine = optionalInt(args, "startLine", 1, 1_000_000) ?? 1;
      const endLine = optionalInt(args, "endLine", 1, 1_000_000);

      let content: string | null = null;
      let meta: Record<string, unknown> = {};

      // Try extension first — only source with unsaved buffer state
      if (extensionClient?.isConnected()) {
        try {
          const result = await extensionClient.getFileContent(filePath);
          if (result !== null && typeof result === "object") {
            const r = result as Record<string, unknown>;
            if (typeof r.content === "string") {
              content = r.content;
              meta = {
                isDirty: r.isDirty ?? false,
                languageId: r.languageId,
                source: "extension",
              };
            }
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to disk
        }
      }

      // Disk fallback
      if (content === null) {
        // Check file size first — avoids reading a huge file into memory
        let fileSize: number;
        try {
          const stat = await fs.stat(filePath);
          fileSize = stat.size;
        } catch {
          return error(`File not found: ${filePath}`);
        }

        if (fileSize > MAX_CONTENT_BYTES) {
          // Large file — only serve if the caller provided a line range
          if (endLine === undefined) {
            const sizeKb = Math.round(fileSize / 1024);
            return error(
              `File too large (${sizeKb}KB). Use startLine/endLine to read in chunks — e.g. startLine:1, endLine:500.`,
            );
          }

          // Stream only the requested line range — no full-file allocation
          const rangeResult = await readLineRange(
            filePath,
            startLine,
            endLine,
            signal,
          );
          if (!rangeResult) return error(`File not found: ${filePath}`);

          const slicedContent = rangeResult.lines.join("\n");
          if (Buffer.byteLength(slicedContent, "utf-8") > MAX_CONTENT_BYTES) {
            return error(
              `Requested range is too large (>${MAX_CONTENT_BYTES / 1024}KB). Narrow the line range.`,
            );
          }

          return successStructuredLarge({
            isDirty: false,
            source: "disk",
            filePath,
            content: slicedContent,
            startLine,
            endLine,
            totalLines: rangeResult.totalLines,
          });
        }

        // Small file — read fully
        try {
          content = await fs.readFile(filePath, { encoding: "utf-8", signal });
          meta = { isDirty: false, source: "disk" };
        } catch {
          return error(`File not found: ${filePath}`);
        }
      }

      // content is now set (from extension or small disk file)
      // Apply size cap (extension could return a large buffer)
      if (Buffer.byteLength(content, "utf-8") > MAX_CONTENT_BYTES) {
        const lines = content.split("\n");
        const sizeKb = Math.round(Buffer.byteLength(content, "utf-8") / 1024);
        return error(
          `File too large (${lines.length} lines, ${sizeKb}KB). Use startLine/endLine to read in chunks — e.g. startLine:1, endLine:500.`,
        );
      }

      const lines = content.split("\n");
      const totalLines = lines.length;

      // Apply line range
      const start = startLine - 1; // 0-based
      const end = endLine !== undefined ? endLine : totalLines; // exclusive
      const sliced = lines.slice(start, end);

      return successStructuredLarge({
        ...meta,
        filePath,
        content: sliced.join("\n"),
        startLine,
        endLine: endLine ?? totalLines,
        totalLines,
      });
    },
  };
}
