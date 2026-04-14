import type { ExtensionClient } from "../extensionClient.js";
import { readNote } from "./handoffNote.js";
import { execSafe, successStructured } from "./utils.js";

/**
 * contextBundle — composite tool that collects the most useful IDE context
 * in a single call, eliminating multiple cold-start round-trips.
 *
 * All sub-calls run in parallel via Promise.allSettled; individual failures
 * are silently omitted so partial results are still useful.
 */
export function createContextBundleTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "contextBundle",
      description:
        "Collect IDE context in one call: active file, diagnostics, diff, editors, handoff note, git status.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          includeDiff: {
            type: "boolean" as const,
            description:
              "Include recent git diff (staged + unstaged). Default: true",
          },
          includeHandoffNote: {
            type: "boolean" as const,
            description: "Include the workspace handoff note. Default: true",
          },
          summarize: {
            type: "boolean" as const,
            description:
              "Summarize output for token efficiency: top-5 diagnostics, 20-line active file window, 100-line diff cap, diagnosticSummary string. Default: false",
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          activeFile: { type: "string" },
          activeFileContent: { type: "string" },
          diagnostics: { type: "array" },
          diff: { type: "string" },
          openEditors: { type: "array" },
          handoffNote: { type: "string" },
          gitStatus: { type: "object" },
          bundledAt: { type: "number" },
          diagnosticSummary: { type: "string" },
        },
        required: ["bundledAt"],
      },
    },

    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const includeDiff = args.includeDiff !== false;
      const includeHandoffNote = args.includeHandoffNote !== false;
      const summarize = args.summarize === true;

      const connected = extensionClient.isConnected();

      // Run all sub-calls in parallel; failures become undefined
      const [
        diagnosticsResult,
        openEditorsResult,
        activeFileContentResult,
        gitStatusResult,
        gitDiffResult,
        handoffNoteResult,
      ] = await Promise.allSettled([
        connected ? extensionClient.getDiagnostics() : Promise.resolve(null),
        connected ? extensionClient.getOpenFiles() : Promise.resolve(null),
        connected && extensionClient.latestActiveFile
          ? extensionClient.getFileContent(extensionClient.latestActiveFile)
          : Promise.resolve(null),
        execSafe("git", ["status", "--porcelain=v1", "--branch"], {
          cwd: workspace,
          signal,
        }),
        includeDiff
          ? execSafe("git", ["diff", "HEAD", "--stat", "--", "."], {
              cwd: workspace,
              signal,
            })
          : Promise.resolve(null),
        includeHandoffNote ? readNote(workspace) : Promise.resolve(null),
      ]);

      const bundle: Record<string, unknown> = {
        bundledAt: Date.now(),
      };

      // Active file (from live extension state)
      if (extensionClient.latestActiveFile) {
        bundle.activeFile = extensionClient.latestActiveFile;
        // Workspace-relative path for downstream tools
        if (extensionClient.latestActiveFile.startsWith(`${workspace}/`)) {
          bundle.activeFileRelativePath =
            extensionClient.latestActiveFile.slice(workspace.length + 1);
        }
      }

      // Active file content — getFileContent returns { content, languageId, isDirty, ... }
      if (
        activeFileContentResult.status === "fulfilled" &&
        activeFileContentResult.value !== null &&
        typeof activeFileContentResult.value === "object"
      ) {
        const fc = activeFileContentResult.value as Record<string, unknown>;
        if (typeof fc.content === "string") {
          const content = fc.content;
          if (summarize) {
            // 20-line window: around first error if any, else first 20 lines
            const lines = content.split("\n");
            const diags: Array<Record<string, unknown>> =
              diagnosticsResult.status === "fulfilled" &&
              Array.isArray(diagnosticsResult.value)
                ? (diagnosticsResult.value as unknown as Array<
                    Record<string, unknown>
                  >)
                : [];
            const activeFile = extensionClient.latestActiveFile ?? "";
            const firstError = diags.find(
              (d) =>
                d.severity === "error" &&
                typeof d.line === "number" &&
                (String(d.file ?? "").endsWith(
                  activeFile.split("/").pop() ?? "",
                ) ||
                  d.file === activeFile),
            );
            const errorLine =
              firstError && typeof firstError.line === "number"
                ? (firstError.line as number) - 1
                : 0;
            const start = Math.max(0, errorLine - 5);
            const end = Math.min(lines.length, start + 20);
            bundle.activeFileContent = lines.slice(start, end).join("\n");
          } else {
            // Truncate to 16KB to keep context manageable
            bundle.activeFileContent =
              content.length > 16384
                ? content.slice(0, 16384) +
                  "\n[file truncated at 16KB — use getBufferContent for full content]"
                : content;
          }
        }
        if (typeof fc.languageId === "string") {
          bundle.activeFileLanguageId = fc.languageId;
        }
        if (typeof fc.isDirty === "boolean") {
          bundle.activeFileIsDirty = fc.isDirty;
        }
      }

      // Diagnostics — capped to avoid dwarfing the 16KB active-file budget
      const CONTEXT_BUNDLE_MAX_DIAGNOSTICS = summarize ? 5 : 50;
      const SEVERITY_RANK: Record<string, number> = {
        error: 3,
        warning: 2,
        information: 1,
        hint: 0,
      };
      if (
        diagnosticsResult.status === "fulfilled" &&
        Array.isArray(diagnosticsResult.value)
      ) {
        const diags = diagnosticsResult.value;
        const diagsUnknown = diags as unknown[];
        if (summarize) {
          // Sort errors first, then warnings, then rest; keep top-5
          diagsUnknown.sort((a, b) => {
            const ra =
              SEVERITY_RANK[
                (a as Record<string, unknown>).severity as string
              ] ?? 0;
            const rb =
              SEVERITY_RANK[
                (b as Record<string, unknown>).severity as string
              ] ?? 0;
            return rb - ra;
          });
        }
        bundle.diagnostics = diagsUnknown.slice(
          0,
          CONTEXT_BUNDLE_MAX_DIAGNOSTICS,
        );
        if (diagsUnknown.length > CONTEXT_BUNDLE_MAX_DIAGNOSTICS) {
          bundle.diagnosticsTruncated = true;
          bundle.diagnosticsTotalCount = diagsUnknown.length;
        }
        if (summarize) {
          // Build diagnosticSummary: "3 TypeScript errors in auth.ts, 2 warnings in utils.ts"
          const countsByFileSeverity = new Map<string, number>();
          for (const d of diagsUnknown) {
            const rec = d as Record<string, unknown>;
            const sev = String(rec.severity ?? "error");
            const file = String(rec.file ?? "unknown");
            const baseName = file.split("/").pop() ?? file;
            const key = `${sev}:${baseName}`;
            countsByFileSeverity.set(
              key,
              (countsByFileSeverity.get(key) ?? 0) + 1,
            );
          }
          const parts: string[] = [];
          for (const [key, count] of countsByFileSeverity) {
            const [sev, fileName] = key.split(":");
            parts.push(
              `${count} ${sev}${count !== 1 ? "s" : ""} in ${fileName}`,
            );
          }
          bundle.diagnosticSummary =
            parts.length > 0 ? parts.join(", ") : "No diagnostics";
        }
      }

      // Open editors
      if (
        openEditorsResult.status === "fulfilled" &&
        Array.isArray(openEditorsResult.value)
      ) {
        bundle.openEditors = openEditorsResult.value;
      }

      // Git status
      if (
        gitStatusResult.status === "fulfilled" &&
        gitStatusResult.value !== null &&
        gitStatusResult.value.exitCode === 0
      ) {
        bundle.gitStatus = { raw: gitStatusResult.value.stdout.trim() };
      }

      // Git diff summary
      if (
        includeDiff &&
        gitDiffResult.status === "fulfilled" &&
        gitDiffResult.value !== null &&
        (gitDiffResult.value as { exitCode: number; stdout: string })
          .exitCode === 0
      ) {
        const diffOut = (
          gitDiffResult.value as { stdout: string }
        ).stdout.trim();
        if (diffOut) {
          if (summarize) {
            const diffLines = diffOut.split("\n");
            if (diffLines.length > 100) {
              bundle.diff =
                diffLines.slice(0, 100).join("\n") +
                `\n[diff truncated — ${diffLines.length - 100} lines omitted]`;
            } else {
              bundle.diff = diffOut;
            }
          } else {
            bundle.diff = diffOut;
          }
        }
      }

      // Handoff note
      if (
        includeHandoffNote &&
        handoffNoteResult.status === "fulfilled" &&
        handoffNoteResult.value !== null
      ) {
        bundle.handoffNote = handoffNoteResult.value.note;
      }

      return successStructured(bundle);
    },
  };
}
