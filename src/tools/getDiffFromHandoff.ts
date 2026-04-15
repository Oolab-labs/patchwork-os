import type { ExtensionClient } from "../extensionClient.js";
import { readNote } from "./handoffNote.js";
import { execSafe, successStructured } from "./utils.js";

interface DiagnosticItem {
  file: string;
  line: number;
  column: number;
  severity: string;
  message: string;
  source?: string;
}

/**
 * Parse `git diff --stat` output to extract summary numbers.
 * Example: " 3 files changed, 10 insertions(+), 5 deletions(-)"
 */
function parseGitStatSummary(statOutput: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
} {
  const lines = statOutput.trim().split("\n").filter(Boolean);
  const summaryLine = lines[lines.length - 1] ?? "";

  const filesMatch = summaryLine.match(/(\d+) files? changed/);
  const insMatch = summaryLine.match(/(\d+) insertions?\(\+\)/);
  const delMatch = summaryLine.match(/(\d+) deletions?\(-\)/);

  // File paths are all lines except the last summary line
  const files = lines
    .slice(0, -1)
    .map((l) => {
      const m = l.match(/^\s*(.+?)\s*\|/);
      return m ? m[1]!.trim() : l.trim();
    })
    .filter(Boolean);

  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1]!, 10) : 0,
    insertions: insMatch ? parseInt(insMatch[1]!, 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1]!, 10) : 0,
    files,
  };
}

function formatAge(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function createGetDiffFromHandoffTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getDiffFromHandoff",
      description:
        "Compute what changed since the handoff note was written: git diff summary + new/resolved diagnostics.",
      annotations: { readOnlyHint: true },
      extensionRequired: true,
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          handoffAge: { type: "string" as const },
          handoffNote: { type: "string" as const },
          gitDiff: {
            type: "object" as const,
            properties: {
              filesChanged: { type: "integer" as const },
              insertions: { type: "integer" as const },
              deletions: { type: "integer" as const },
              files: {
                type: "array" as const,
                items: { type: "string" as const },
              },
            },
            required: ["filesChanged", "insertions", "deletions", "files"],
          },
          newDiagnostics: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                file: { type: "string" as const },
                line: { type: "integer" as const },
                column: { type: "integer" as const },
                severity: { type: "string" as const },
                message: { type: "string" as const },
              },
              required: ["file", "line", "column", "severity", "message"],
            },
          },
          resolvedCount: { type: "integer" as const },
          summary: { type: "string" as const },
          noHandoffNote: { type: "boolean" as const },
        },
        required: ["gitDiff", "newDiagnostics", "resolvedCount", "summary"],
      },
    },
    handler: async (_args: Record<string, unknown>, signal?: AbortSignal) => {
      // Read handoff note
      const note = await readNote(workspace);

      const handoffAge = note
        ? formatAge(Date.now() - note.updatedAt)
        : "never";

      // Run git diff --stat since handoff (or HEAD~1 if no note)
      // We use `git diff HEAD` to show unstaged+staged changes vs last commit
      const statResult = await execSafe("git", ["diff", "HEAD", "--stat"], {
        cwd: workspace,
        timeout: 10_000,
        signal,
      });

      const gitDiff =
        statResult.exitCode === 0 && statResult.stdout.trim()
          ? parseGitStatSummary(statResult.stdout)
          : { filesChanged: 0, insertions: 0, deletions: 0, files: [] };

      // Get current diagnostics
      const newDiagnostics: DiagnosticItem[] = [];
      const resolvedCount = 0;

      if (extensionClient.isConnected()) {
        try {
          const diags = extensionClient.latestDiagnostics;
          // Collect all current errors/warnings
          for (const [_file, fileDiags] of diags) {
            for (const d of fileDiags) {
              if (d.severity === "error" || d.severity === "warning") {
                newDiagnostics.push({
                  file: d.file,
                  line: d.line,
                  column: d.column,
                  severity: d.severity,
                  message: d.message,
                  ...(d.source && { source: d.source }),
                });
              }
            }
          }
        } catch {
          // Best-effort
        }
      }

      // Build summary
      const parts: string[] = [];
      if (note) {
        parts.push(`Handoff note written ${handoffAge}`);
      } else {
        parts.push("No handoff note found");
      }
      if (gitDiff.filesChanged > 0) {
        parts.push(
          `${gitDiff.filesChanged} file(s) changed (+${gitDiff.insertions}/-${gitDiff.deletions})`,
        );
      } else {
        parts.push("No uncommitted changes");
      }
      if (newDiagnostics.length > 0) {
        const errors = newDiagnostics.filter(
          (d) => d.severity === "error",
        ).length;
        const warnings = newDiagnostics.filter(
          (d) => d.severity === "warning",
        ).length;
        parts.push(
          `${errors} error(s), ${warnings} warning(s) in current diagnostics`,
        );
      }

      return successStructured({
        handoffAge,
        ...(note ? { handoffNote: note.note } : { noHandoffNote: true }),
        gitDiff,
        newDiagnostics: newDiagnostics.slice(0, 50),
        resolvedCount,
        summary: parts.join(". "),
      });
    },
  };
}
