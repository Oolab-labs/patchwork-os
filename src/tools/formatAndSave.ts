/**
 * formatAndSave — composite tool that runs formatDocument and saveDocument
 * in one call. Eliminates the race window between formatting a buffer and
 * persisting it, and cuts the common "format then save" workflow from two
 * tool calls to one.
 *
 * Implementation notes (from v2.25.25 session plan):
 * - formatDocument returns `error({...})` on many failure paths
 *   (file-not-found, unsupported extension, non-zero exit). Guard against
 *   result.isError BEFORE reading structuredContent, otherwise we crash.
 * - saveDocument may also error. Propagate in the same way.
 * - Both tools take { filePath } as their first arg in identical shape.
 * - This is a composite factory: it takes the already-constructed
 *   formatDocument + saveDocument tool instances so their handlers (and
 *   therefore their fallback logic) are reused as-is, not duplicated.
 */
import { err, okS, toCallToolResult } from "../fp/result.js";
import type { ProgressFn } from "../transport.js";
import type { createFormatDocumentTool } from "./formatDocument.js";
import type { createSaveDocumentTool } from "./saveDocument.js";
import { requireString } from "./utils.js";

type FormatDocumentTool = ReturnType<typeof createFormatDocumentTool>;
type SaveDocumentTool = ReturnType<typeof createSaveDocumentTool>;

export function createFormatAndSaveTool(deps: {
  formatDocument: FormatDocumentTool;
  saveDocument: SaveDocumentTool;
}) {
  return {
    schema: {
      name: "formatAndSave",
      description:
        "Format a file and save it in one call (formatDocument + saveDocument). Formatter errors propagate; save is not attempted on format failure.",
      annotations: { destructiveHint: true, idempotentHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
        required: ["filePath"],
        properties: {
          filePath: {
            type: "string" as const,
            description: "Path to the file (absolute or workspace-relative)",
          },
        },
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          formatted: { type: "boolean" },
          changes: { type: "string" },
          saved: { type: "boolean" },
          source: { type: "string" },
          message: { type: "string" },
        },
      },
    },
    async handler(
      args: Record<string, unknown>,
      signal?: AbortSignal,
      progress?: ProgressFn,
    ) {
      const filePath = requireString(args, "filePath");

      // Step 1: format — reuse the existing tool's handler so all of its
      // extension/CLI fallback logic is preserved.
      const fmt = await deps.formatDocument.handler(
        { filePath },
        signal,
        progress,
      );
      if ("isError" in fmt && fmt.isError) return fmt;

      const fmtData = (fmt as { structuredContent?: Record<string, unknown> })
        .structuredContent;
      if (!fmtData || typeof fmtData !== "object") {
        return toCallToolResult(
          err(
            "unknown",
            "formatDocument returned unexpected shape (no structuredContent)",
          ),
        );
      }

      // Step 2: save — reuse the existing tool's handler.
      const save = await deps.saveDocument.handler({ filePath });
      if ("isError" in save && save.isError) return save;

      const saveData = (save as { structuredContent?: Record<string, unknown> })
        .structuredContent;
      if (!saveData || typeof saveData !== "object") {
        return toCallToolResult(
          err(
            "unknown",
            "saveDocument returned unexpected shape (no structuredContent)",
          ),
        );
      }

      return toCallToolResult(
        okS({
          formatted: fmtData.formatted ?? false,
          changes: fmtData.changes ?? "unknown",
          saved: saveData.saved ?? false,
          source: saveData.source ?? fmtData.source ?? "unknown",
          ...(typeof fmtData.linesBeforeCount === "number" && {
            linesBeforeCount: fmtData.linesBeforeCount,
          }),
          ...(typeof fmtData.linesAfterCount === "number" && {
            linesAfterCount: fmtData.linesAfterCount,
          }),
          ...(typeof saveData.message === "string" && {
            message: saveData.message,
          }),
        }),
      );
    },
  };
}
