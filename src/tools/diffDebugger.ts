import path from "node:path";
import type { ToolHandler } from "../transport.js";
import {
  error,
  execSafe,
  optionalBool,
  optionalInt,
  optionalString,
  resolveFilePath,
  success,
} from "./utils.js";

interface ChangedRegion {
  startLine: number;
  endLine: number;
  header: string;
}

function parseDiffHunks(diffOutput: string): Map<string, ChangedRegion[]> {
  const regions = new Map<string, ChangedRegion[]>();
  let currentFile: string | null = null;

  for (const line of diffOutput.split("\n")) {
    // Track current file from +++ line
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      if (!regions.has(currentFile)) {
        regions.set(currentFile, []);
      }
      continue;
    }

    // Skip binary files
    if (line.startsWith("Binary files")) {
      currentFile = null;
      continue;
    }

    // Parse hunk headers
    if (currentFile && line.startsWith("@@")) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)/);
      if (match) {
        const newStart = Number.parseInt(match[1]!, 10);
        const newCount =
          match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
        const header = match[3]?.trim() ?? "";

        if (newCount === 0) {
          // Pure deletion — record as a point
          regions.get(currentFile)?.push({
            startLine: newStart,
            endLine: newStart,
            header,
          });
        } else {
          regions.get(currentFile)?.push({
            startLine: newStart,
            endLine: newStart + newCount - 1,
            header,
          });
        }
      }
    }
  }

  return regions;
}

function lineDistance(
  line: number,
  regionStart: number,
  regionEnd: number,
): number {
  if (line >= regionStart && line <= regionEnd) return 0;
  if (line < regionStart) return regionStart - line;
  return line - regionEnd;
}

export function createDiffDebugTool(
  workspace: string,
  getDiagnosticsFn: ToolHandler,
) {
  return {
    schema: {
      name: "diffDebug",
      description:
        "Correlate git diffs with diagnostics to identify which changes likely introduced errors or warnings. Compares changed regions with diagnostic locations.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          commitRange: {
            type: "string",
            description:
              "Git commit range for the diff (e.g., 'HEAD~3..HEAD'). Default: working tree vs HEAD",
          },
          staged: {
            type: "boolean",
            description:
              "If true and no commitRange, diff staged changes vs HEAD. Default: false",
          },
          filePath: {
            type: "string",
            description: "Optional file path to limit analysis to",
          },
          proximity: {
            type: "integer",
            description:
              "Number of lines around a changed region to consider 'nearby'. Default: 3",
          },
          severity: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Filter diagnostics by severity: 'error', 'warning', 'information', 'hint'. Single value or array.",
          },
          source: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Filter diagnostics by source (e.g., 'tsc', 'eslint', 'pyright'). Single value or array.",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const commitRange = optionalString(args, "commitRange");
      const staged = optionalBool(args, "staged") ?? false;
      const rawPath = optionalString(args, "filePath");
      const proximity = optionalInt(args, "proximity", 0, 50) ?? 3;

      // Reject git flag injection and invalid characters in commit range
      if (commitRange?.startsWith("-")) {
        return error("commitRange must be a revision range, not a flag");
      }
      // Allow word chars, dots, dashes, slashes, and git range/ref syntax (~^@:.)
      if (commitRange && !/^[\w.\-/^~@:.]+$/.test(commitRange)) {
        return error(
          "commitRange contains invalid characters — use a valid git revision range (e.g. 'HEAD~3..HEAD')",
        );
      }

      // Build diff command
      const diffArgs = ["diff", "-U0"];
      if (commitRange) {
        diffArgs.push(commitRange);
      } else if (staged) {
        diffArgs.push("--cached");
      }
      if (rawPath) {
        const filterPath = resolveFilePath(rawPath, workspace);
        diffArgs.push("--", filterPath);
      }

      const diffResult = await execSafe("git", diffArgs, {
        cwd: workspace,
        signal,
      });
      if (diffResult.exitCode !== 0 && !diffResult.stdout) {
        return error(`git diff failed: ${diffResult.stderr.trim()}`);
      }

      const changedRegions = parseDiffHunks(diffResult.stdout);

      // Get diagnostics
      const diagResult = await getDiagnosticsFn({}, signal);
      let diagnostics: Array<{
        file: string;
        line: number;
        column: number;
        severity: string;
        message: string;
        source: string;
        code?: string | number;
      }> = [];

      try {
        const rawText = diagResult.content?.[0]?.text;
        if (rawText) {
          const parsed = JSON.parse(rawText);
          diagnostics = parsed.diagnostics ?? parsed.results ?? [];
        }
      } catch {
        // If parsing fails, no diagnostics to correlate
      }

      // Apply severity/source filters
      const rawSeverity = args.severity;
      const severityFilter: string[] | null = rawSeverity
        ? (Array.isArray(rawSeverity) ? rawSeverity : [rawSeverity]).filter(
            (s): s is string => typeof s === "string",
          )
        : null;

      const rawSource = args.source;
      const sourceFilter: string[] | null = rawSource
        ? (Array.isArray(rawSource) ? rawSource : [rawSource]).filter(
            (s): s is string => typeof s === "string",
          )
        : null;

      if (severityFilter) {
        diagnostics = diagnostics.filter((d) =>
          severityFilter.includes(d.severity),
        );
      }
      if (sourceFilter) {
        diagnostics = diagnostics.filter((d) =>
          sourceFilter.includes(d.source),
        );
      }

      // Correlate
      const correlations: Array<{
        file: string;
        diagnostic: {
          line: number;
          column: number;
          severity: string;
          message: string;
          source: string;
        };
        diffHunk: { startLine: number; endLine: number; header: string } | null;
        likelyIntroducedByChange: boolean;
        distance: number | null;
      }> = [];

      for (const diag of diagnostics) {
        // Normalize diagnostic file path to workspace-relative
        let diagRelative: string;
        if (path.isAbsolute(diag.file)) {
          diagRelative = path.relative(workspace, diag.file);
        } else {
          diagRelative = diag.file;
        }

        // Filter by filePath if specified
        if (rawPath) {
          const filterRelative = path.relative(
            workspace,
            resolveFilePath(rawPath, workspace),
          );
          if (diagRelative !== filterRelative) continue;
        }

        const regions = changedRegions.get(diagRelative);

        if (!regions || regions.length === 0) {
          correlations.push({
            file: diagRelative,
            diagnostic: {
              line: diag.line,
              column: diag.column,
              severity: diag.severity,
              message: diag.message,
              source: diag.source,
            },
            diffHunk: null,
            likelyIntroducedByChange: false,
            distance: null,
          });
          continue;
        }

        let minDist = Number.POSITIVE_INFINITY;
        let nearestHunk: ChangedRegion | null = null;
        for (const region of regions) {
          const dist = lineDistance(
            diag.line,
            region.startLine,
            region.endLine,
          );
          if (dist < minDist) {
            minDist = dist;
            nearestHunk = region;
          }
        }

        correlations.push({
          file: diagRelative,
          diagnostic: {
            line: diag.line,
            column: diag.column,
            severity: diag.severity,
            message: diag.message,
            source: diag.source,
          },
          diffHunk: nearestHunk
            ? {
                startLine: nearestHunk.startLine,
                endLine: nearestHunk.endLine,
                header: nearestHunk.header,
              }
            : null,
          likelyIntroducedByChange: minDist <= proximity,
          distance: minDist === Number.POSITIVE_INFINITY ? null : minDist,
        });
      }

      // Sort: likely-introduced first, then by file/line
      correlations.sort((a, b) => {
        if (a.likelyIntroducedByChange !== b.likelyIntroducedByChange) {
          return a.likelyIntroducedByChange ? -1 : 1;
        }
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        return a.diagnostic.line - b.diagnostic.line;
      });

      const summary = {
        totalDiagnostics: correlations.length,
        likelyIntroduced: correlations.filter((c) => c.likelyIntroducedByChange)
          .length,
        unrelatedToChanges: correlations.filter(
          (c) => !c.likelyIntroducedByChange,
        ).length,
        filesAnalyzed: new Set(correlations.map((c) => c.file)).size,
        filtersApplied: {
          severity: severityFilter,
          source: sourceFilter,
        },
      };

      return success({ correlations, summary });
    },
  };
}
