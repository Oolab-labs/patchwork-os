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
        "Collect IDE context in one call: active file + content, diagnostics, diff, open editors, handoff note, git status. " +
        "Eliminates round-trips at session start. Fields absent if extension disconnected.",
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
        },
        required: ["bundledAt"],
      },
    },

    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const includeDiff = args.includeDiff !== false;
      const includeHandoffNote = args.includeHandoffNote !== false;

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
        if (extensionClient.latestActiveFile.startsWith(workspace + "/")) {
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
          // Truncate to 16KB to keep context manageable
          bundle.activeFileContent =
            content.length > 16384
              ? content.slice(0, 16384) +
                "\n[file truncated at 16KB — use getBufferContent for full content]"
              : content;
        }
        if (typeof fc.languageId === "string") {
          bundle.activeFileLanguageId = fc.languageId;
        }
        if (typeof fc.isDirty === "boolean") {
          bundle.activeFileIsDirty = fc.isDirty;
        }
      }

      // Diagnostics — capped to avoid dwarfing the 16KB active-file budget
      const CONTEXT_BUNDLE_MAX_DIAGNOSTICS = 50;
      if (
        diagnosticsResult.status === "fulfilled" &&
        Array.isArray(diagnosticsResult.value)
      ) {
        const diags = diagnosticsResult.value;
        bundle.diagnostics = diags.slice(0, CONTEXT_BUNDLE_MAX_DIAGNOSTICS);
        if (diags.length > CONTEXT_BUNDLE_MAX_DIAGNOSTICS) {
          bundle.diagnosticsTruncated = true;
          bundle.diagnosticsTotalCount = diags.length;
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
          bundle.diff = diffOut;
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
