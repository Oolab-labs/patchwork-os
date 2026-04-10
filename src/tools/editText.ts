import fs from "node:fs";
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

export interface TextEdit {
  type: "insert" | "delete" | "replace";
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  text?: string;
}

/**
 * Apply text edits natively by reading the file, modifying in-memory, and writing back.
 * Edits are sorted in reverse document order so that earlier edits don't shift later indices.
 */
export function applyEditsToContent(
  content: string,
  edits: TextEdit[],
): string {
  // Validate that delete/replace edits include a range end — without endColumn the
  // fallback `edit.column` produces a zero-width range that silently deletes nothing.
  for (const [i, e] of edits.entries()) {
    if (
      (e.type === "delete" || e.type === "replace") &&
      (e.endLine === undefined || e.endColumn === undefined)
    ) {
      throw new Error(
        `edits[${i}]: delete/replace requires endLine and endColumn`,
      );
    }
    if (
      (e.type === "delete" || e.type === "replace") &&
      e.endLine !== undefined &&
      e.endLine < e.line
    ) {
      throw new Error(
        `edits[${i}]: endLine (${e.endLine}) must be >= line (${e.line})`,
      );
    }
    if (
      (e.type === "delete" || e.type === "replace") &&
      e.endLine === e.line &&
      e.endColumn !== undefined &&
      e.endColumn < e.column
    ) {
      throw new Error(
        `edits[${i}]: endColumn (${e.endColumn}) must be >= column (${e.column}) when endLine === line`,
      );
    }
  }

  const lines = content.split("\n");

  // Sort edits in forward order first to detect overlaps
  const sortedForward = [...edits].sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });

  // Check for overlapping ranges
  for (let i = 0; i < sortedForward.length - 1; i++) {
    const cur = sortedForward[i];
    const next = sortedForward[i + 1];
    if (!cur || !next) continue;
    const curEndLine = cur.endLine ?? cur.line;
    const curEndCol = cur.endColumn ?? cur.column;
    // Two edits overlap when the end of edit[i] is strictly past the start of edit[i+1]
    const overlaps =
      curEndLine > next.line ||
      (curEndLine === next.line && curEndCol > next.column);
    if (overlaps) {
      throw new Error(
        `overlapping edits detected: edit ending at line ${curEndLine} overlaps edit starting at line ${next.line}`,
      );
    }
  }

  // Sort edits in reverse order: last position first so indices stay stable
  const sorted = sortedForward.slice().reverse();

  for (const edit of sorted) {
    const lineIdx = edit.line - 1; // 1-based → 0-based
    const colIdx = edit.column - 1;

    // Pad lines array if edit targets beyond EOF (prevents "undefined" in output)
    while (lineIdx >= lines.length) {
      lines.push("");
    }

    if (edit.type === "insert") {
      const text = edit.text ?? "";
      const insertLines = text.split("\n");
      const currentLine = lines[lineIdx] ?? "";
      const before = currentLine.slice(0, colIdx);
      const after = currentLine.slice(colIdx);

      if (insertLines.length === 1) {
        lines[lineIdx] = before + insertLines[0] + after;
      } else {
        // Multi-line insert: first fragment joins before, last fragment joins after
        const newLines = [
          before + insertLines[0],
          ...insertLines.slice(1, -1),
          insertLines[insertLines.length - 1] + after,
        ];
        lines.splice(lineIdx, 1, ...newLines);
      }
    } else if (edit.type === "delete" || edit.type === "replace") {
      const originalEndLineIdx = (edit.endLine ?? edit.line) - 1;
      const endLineIdx = Math.min(originalEndLineIdx, lines.length - 1);
      // When endLine is clamped to EOF, use end-of-last-line so the range
      // correctly covers "to end of file" rather than referencing a column on
      // the wrong (clamped) line.
      const endColIdx =
        originalEndLineIdx > lines.length - 1
          ? (lines[endLineIdx] ?? "").length
          : (edit.endColumn ?? edit.column) - 1;
      const beforeText = (lines[lineIdx] ?? "").slice(0, colIdx);
      const afterText = (lines[endLineIdx] ?? "").slice(endColIdx);

      const replacement = edit.type === "replace" ? (edit.text ?? "") : "";
      const replacementLines = replacement.split("\n");

      if (replacementLines.length === 1) {
        const merged = beforeText + replacementLines[0] + afterText;
        lines.splice(lineIdx, endLineIdx - lineIdx + 1, merged);
      } else {
        const newLines = [
          beforeText + replacementLines[0],
          ...replacementLines.slice(1, -1),
          replacementLines[replacementLines.length - 1] + afterText,
        ];
        lines.splice(lineIdx, endLineIdx - lineIdx + 1, ...newLines);
      }
    }
  }

  return lines.join("\n");
}

export function createEditTextTool(
  workspace: string,
  extensionClient: ExtensionClient,
  fileLock?: FileLock,
) {
  return {
    schema: {
      name: "editText",
      description:
        "Insert, delete, or replace text at specific positions in a file (1-based line/col). " +
        "Supports multiple atomic edits. Uses VS Code WorkspaceEdit when connected, or native fs otherwise.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["filePath", "edits"],
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path to the file",
          },
          edits: {
            type: "array" as const,
            description: "Array of edit operations to apply atomically",
            items: {
              type: "object" as const,
              required: ["type"],
              properties: {
                type: {
                  type: "string" as const,
                  enum: ["insert", "delete", "replace"],
                  description: "Type of edit operation",
                },
                line: {
                  type: "integer" as const,
                  description: "Line number (1-based)",
                },
                column: {
                  type: "integer" as const,
                  description: "Column number (1-based)",
                },
                endLine: {
                  type: "integer" as const,
                  description: "End line number (1-based, for delete/replace)",
                },
                endColumn: {
                  type: "integer" as const,
                  description:
                    "End column number (1-based, for delete/replace)",
                },
                text: {
                  type: "string" as const,
                  description: "Text to insert or replace with",
                },
              },
            },
          },
          save: {
            type: "boolean" as const,
            description: "Save the file after applying edits (default: false)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          editsApplied: { type: "integer" },
          source: { type: "string" },
          filePath: { type: "string" },
          warning: { type: "string" },
        },
        required: ["success"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const rawPath = requireString(args, "filePath");
      const edits = args.edits;
      const save = optionalBool(args, "save") ?? false;

      if (!Array.isArray(edits) || edits.length === 0) {
        return error("'edits' must be a non-empty array");
      }
      if (edits.length > 1000) {
        return error("'edits' must have at most 1000 entries");
      }

      // Validate each edit
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i] as Record<string, unknown>;
        if (!edit || typeof edit !== "object") {
          return error(`edits[${i}] must be an object`);
        }
        const type = edit.type;
        if (type !== "insert" && type !== "delete" && type !== "replace") {
          return error(
            `edits[${i}].type must be "insert", "delete", or "replace"`,
          );
        }
        if (typeof edit.line !== "number") {
          return error(`edits[${i}].line is required and must be a number`);
        }
        if (typeof edit.column !== "number") {
          return error(`edits[${i}].column is required and must be a number`);
        }
        if ((edit.line as number) < 1 || (edit.column as number) < 1) {
          return error(`edits[${i}].line and column must be >= 1 (1-based)`);
        }
        if (type === "insert" && typeof edit.text !== "string") {
          return error(`edits[${i}].text is required for insert operations`);
        }
        if (
          (type === "delete" || type === "replace") &&
          typeof edit.endLine !== "number"
        ) {
          return error(
            `edits[${i}].endLine is required for ${type} operations`,
          );
        }
        if (
          (type === "delete" || type === "replace") &&
          typeof edit.endColumn !== "number"
        ) {
          return error(
            `edits[${i}].endColumn is required for ${type} operations`,
          );
        }
        if (
          (type === "delete" || type === "replace") &&
          ((edit.endLine as number) < 1 || (edit.endColumn as number) < 1)
        ) {
          return error(
            `edits[${i}].endLine and endColumn must be >= 1 (1-based)`,
          );
        }
        if (
          (type === "delete" || type === "replace") &&
          ((edit.endLine as number) < (edit.line as number) ||
            ((edit.endLine as number) === (edit.line as number) &&
              (edit.endColumn as number) < (edit.column as number)))
        ) {
          return error(
            `edits[${i}].endLine:endColumn must be >= line:column (range cannot be reversed)`,
          );
        }
        if (type === "replace" && typeof edit.text !== "string") {
          return error(`edits[${i}].text is required for replace operations`);
        }
      }

      const filePath = resolveFilePath(rawPath, workspace, { write: true });

      // Try extension first (supports undo, works with unsaved buffers)
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.editText(filePath, edits, save);
          if (result !== null) {
            const parsed = result as Record<string, unknown>;
            if (parsed.success === false) {
              return error(String(parsed.error ?? "Failed to apply edits"));
            }
            // Pass through extension result with source annotation
            return successStructured({ ...parsed, source: "vscode", filePath });
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to native fs fallback
        }
      }

      if (signal?.aborted) throw new Error("Request aborted");

      // Native fs fallback — read, apply edits in-memory, write back
      // Uses mtime-based optimistic concurrency to detect concurrent modifications
      try {
        let content: string;
        let originalMtimeMs: number;
        try {
          const stat = await fs.promises.stat(filePath);
          originalMtimeMs = stat.mtimeMs;
          content = await fs.promises.readFile(filePath, {
            encoding: "utf-8",
            signal,
          });
        } catch {
          return error(`File not found: ${filePath}`);
        }

        const typedEdits = edits as TextEdit[];
        const newContent = applyEditsToContent(content, typedEdits);

        // Acquire per-file lock before write to serialize concurrent edits from multiple sessions
        const release = fileLock ? await fileLock.acquire(filePath) : null;
        try {
          // Check if file was modified between read and write
          try {
            const statAfter = await fs.promises.stat(filePath);
            if (statAfter.mtimeMs !== originalMtimeMs) {
              return error("File was modified concurrently — retry the edit");
            }
          } catch {
            // File was deleted between read and write
            return error("File was deleted concurrently — cannot apply edits");
          }

          await fs.promises.writeFile(filePath, newContent, {
            encoding: "utf-8",
            signal,
          });
        } finally {
          release?.();
        }

        return successStructured({
          success: true,
          editsApplied: typedEdits.length,
          source: extensionClient.isConnected()
            ? "native-fs (extension timed out)"
            : "native-fs",
          warning: "Edits applied directly to disk — no undo buffer available",
        });
      } catch (err) {
        return error(
          `Failed to apply edits: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
