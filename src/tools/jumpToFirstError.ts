/**
 * jumpToFirstError — composite tool that replaces the 3-call pattern of
 * getDiagnostics → openFile → setEditorDecorations with a single call.
 *
 * Most common session-start workflow: "find the first error and take me to it".
 *
 * Implementation notes (from v2.25.25 session plan):
 * - diagnostic.file may be `file://...` (LSP path) OR workspace-relative
 *   (CLI linter path). resolveFilePath handles relative but not `file://` —
 *   we strip the scheme before calling openFile.
 * - Diagnostic field is `rule`, not `code`. (getDiagnostics outputSchema
 *   confirms.)
 * - setEditorDecorations requires top-level `id` + `file` — the shape
 *   `{ startLine, style, message }` is only the inner decoration entry.
 * - Guard for `fmt.isError` / `diag.isError` before reading structuredContent;
 *   several fix rounds in v2.25.18–24 fixed bugs caused by skipping this.
 */
import { fileURLToPath } from "node:url";
import type { ExtensionClient } from "../extensionClient.js";
import type { ProgressFn } from "../transport.js";
import type { createSetEditorDecorationsTool } from "./decorations.js";
import type { createGetDiagnosticsTool } from "./getDiagnostics.js";
import type { createOpenFileTool } from "./openFile.js";
import { error, successStructured } from "./utils.js";

type GetDiagnosticsTool = ReturnType<typeof createGetDiagnosticsTool>;
type OpenFileTool = ReturnType<typeof createOpenFileTool>;
type SetEditorDecorationsTool = ReturnType<
  typeof createSetEditorDecorationsTool
>;

function normalizeFilePath(f: string): string {
  if (f.startsWith("file://")) {
    try {
      return fileURLToPath(f);
    } catch {
      return f.slice("file://".length);
    }
  }
  return f;
}

export function createJumpToFirstErrorTool(deps: {
  getDiagnostics: GetDiagnosticsTool;
  openFile: OpenFileTool;
  setEditorDecorations?: SetEditorDecorationsTool;
  extensionClient?: ExtensionClient;
}) {
  return {
    schema: {
      name: "jumpToFirstError",
      description:
        "Jump to first workspace error (getDiagnostics→openFile→decoration). Returns {found:false} if none.",
      annotations: { readOnlyHint: false, idempotentHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
        properties: {},
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          found: { type: "boolean" },
          file: { type: "string" },
          line: { type: "integer" },
          column: { type: "integer" },
          message: { type: "string" },
          rule: { type: "string" },
          decorationApplied: { type: "boolean" },
        },
        required: ["found"],
      },
    },
    async handler(
      _args: Record<string, unknown>,
      signal?: AbortSignal,
      progress?: ProgressFn,
    ) {
      // Step 1: fetch the first error
      const diag = await deps.getDiagnostics.handler(
        { severity: "error", maxResults: 1 },
        signal,
        progress,
      );
      if ("isError" in diag && diag.isError) return diag;

      const diagData = (diag as { structuredContent?: Record<string, unknown> })
        .structuredContent;
      if (!diagData || typeof diagData !== "object") {
        return error(
          "getDiagnostics returned unexpected shape (no structuredContent)",
        );
      }

      const diagnostics = (diagData as { diagnostics?: unknown }).diagnostics;
      if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
        return successStructured({ found: false });
      }

      const first = diagnostics[0] as Record<string, unknown>;
      const rawFile = typeof first.file === "string" ? first.file : undefined;
      if (!rawFile) {
        return error(
          "first diagnostic missing 'file' field — cannot jump to error",
        );
      }
      const filePath = normalizeFilePath(rawFile);
      const line = typeof first.line === "number" ? first.line : 1;
      const column = typeof first.column === "number" ? first.column : 1;
      const message =
        typeof first.message === "string" ? first.message : "Unknown error";
      const rule = typeof first.rule === "string" ? first.rule : undefined;

      // Step 2: open the file at the error line
      const openResult = await deps.openFile.handler({
        filePath,
        startLine: line,
      });
      if ("isError" in openResult && openResult.isError) return openResult;

      // Step 3: decorate the error line (best-effort; extension-only)
      let decorationApplied = false;
      if (
        deps.setEditorDecorations &&
        deps.extensionClient?.isConnected() === true
      ) {
        try {
          const decoResult = await deps.setEditorDecorations.handler({
            id: "jump-to-first-error",
            file: filePath,
            decorations: [
              {
                startLine: line,
                endLine:
                  typeof first.endLine === "number" ? first.endLine : line,
                style: "error",
                message,
              },
            ],
          });
          decorationApplied = !("isError" in decoResult && decoResult.isError);
        } catch (decoErr) {
          // best-effort; decoration failure does not fail the jump
          console.warn(
            "[jumpToFirstError] decoration failed:",
            decoErr instanceof Error ? decoErr.message : String(decoErr),
          );
        }
      }

      return successStructured({
        found: true,
        file: filePath,
        line,
        column,
        message,
        ...(rule && { rule }),
        decorationApplied,
      });
    },
  };
}
