import fs from "node:fs/promises";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  optionalInt,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

const MAX_CONTENT_BYTES = 512 * 1024; // 512 KB hard cap

export function createGetBufferContentTool(
  workspace: string,
  extensionClient?: ExtensionClient,
) {
  return {
    schema: {
      name: "getBufferContent",
      description:
        "Read the current content of a file from the VS Code editor buffer, including any unsaved changes. " +
        "Use this instead of the standard Read tool when you need the live editor state — " +
        "especially before calling editText, to ensure your line numbers are accurate. " +
        "Returns isDirty:true when the buffer has unsaved changes that differ from disk. " +
        "Falls back to disk content when the extension is not connected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["filePath"],
        additionalProperties: false as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative file path",
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
    },

    timeoutMs: 5_000,
    async handler(args: Record<string, unknown>) {
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
                source: r.source ?? "vscode-buffer",
              };
            }
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to disk
        }
      }

      // Fallback: read from disk
      if (content === null) {
        try {
          content = await fs.readFile(filePath, "utf-8");
          meta = { isDirty: false, source: "disk" };
        } catch {
          return error(`File not found: ${filePath}`);
        }
      }

      // Enforce size cap before splitting
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

      return success({
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
