import type { ExtensionClient } from "../extensionClient.js";
import { checkGitRepo, runGit } from "./git-utils.js";
import {
  error,
  extensionRequired,
  optionalInt,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

interface SymbolCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
}

interface BlameEntry {
  line: number;
  hash: string;
  author: string;
  summary: string;
}

/**
 * getSymbolHistory — symbol evolution composite tool.
 *
 * Given a file + position, uses LSP to find the symbol's definition, then:
 * 1. git blame on the definition line range → who last touched it and when
 * 2. git log --follow on the definition file → commit history touching that file
 *
 * Returns: current definition location, blame for the definition lines,
 * and the N most recent commits that touched the file.
 */
export function createGetSymbolHistoryTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getSymbolHistory",
      description:
        "Symbol evolution: LSP definition + git blame on definition site + file commit history. " +
        "Answers 'why does this exist?' and 'who changed it last?'",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Workspace or absolute file path",
          },
          line: {
            type: "integer" as const,
            description: "Line number of symbol (1-based)",
          },
          column: {
            type: "integer" as const,
            description: "Column number of symbol (1-based)",
          },
          maxCommits: {
            type: "integer" as const,
            minimum: 1,
            maximum: 50,
            description:
              "Max commits to return from file history (default: 10)",
          },
          blameLines: {
            type: "integer" as const,
            minimum: 1,
            maximum: 50,
            description:
              "Lines of blame context around definition site (default: 5)",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          symbol: {
            type: "object",
            properties: {
              queryFile: { type: "string" },
              queryLine: { type: "integer" },
              queryColumn: { type: "integer" },
            },
            required: ["queryFile", "queryLine", "queryColumn"],
          },
          definition: {
            anyOf: [
              {
                type: "object",
                properties: {
                  file: { type: "string" },
                  line: { type: "integer" },
                  column: { type: "integer" },
                },
                required: ["file", "line"],
              },
              { type: "null" },
            ],
          },
          blame: {
            type: "array",
            items: {
              type: "object",
              properties: {
                line: { type: "integer" },
                hash: { type: "string" },
                author: { type: "string" },
                summary: { type: "string" },
              },
              required: ["line", "hash", "author", "summary"],
            },
          },
          recentCommits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                hash: { type: "string" },
                shortHash: { type: "string" },
                author: { type: "string" },
                date: { type: "string" },
                message: { type: "string" },
              },
              required: ["hash", "shortHash", "author", "date", "message"],
            },
          },
          definitionFile: { type: "string" },
          note: { type: "string" },
        },
        required: ["symbol", "definition", "blame", "recentCommits"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getSymbolHistory");
      }

      const rawPath = requireString(args, "filePath");
      const filePath = resolveFilePath(rawPath, workspace);
      const line = typeof args.line === "number" ? Math.max(1, args.line) : 1;
      const column =
        typeof args.column === "number" ? Math.max(1, args.column) : 1;
      const maxCommits = optionalInt(args, "maxCommits", 1, 50) ?? 10;
      const blameContext = optionalInt(args, "blameLines", 1, 50) ?? 5;

      if (!(await checkGitRepo(workspace, signal))) {
        return error("Not a git repository");
      }

      const compositeSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(20_000),
      ]);

      // Step 1 — LSP: find definition location
      const definitionRaw = await extensionClient
        .goToDefinition(filePath, line, column, compositeSignal)
        .catch(() => null);

      // Normalise definition result — LSP returns array or single object
      let defFile: string | null = null;
      let defLine: number | null = null;
      let defColumn: number | null = null;

      if (definitionRaw) {
        const defArr = Array.isArray(definitionRaw)
          ? definitionRaw
          : [definitionRaw];
        const first = defArr[0] as Record<string, unknown> | undefined;
        if (first) {
          const uri = String(first.uri ?? first.file ?? "");
          defFile = uri.startsWith("file://")
            ? decodeURIComponent(uri.slice(7))
            : uri || null;
          defLine =
            typeof first.line === "number"
              ? first.line
              : typeof first.range === "object" &&
                  first.range !== null &&
                  typeof (first.range as Record<string, unknown>).start ===
                    "object"
                ? Number(
                    (
                      (first.range as Record<string, unknown>).start as Record<
                        string,
                        unknown
                      >
                    ).line,
                  ) + 1 // LSP is 0-based
                : null;
          defColumn =
            typeof first.character === "number" ? first.character : null;
        }
      }

      // Use definition site for blame if available, otherwise fall back to query site
      const blameFile = defFile ?? filePath;
      const blameLine = defLine ?? line;
      const blameStart = Math.max(1, blameLine - Math.floor(blameContext / 2));
      const blameEnd = blameStart + blameContext - 1;

      // Step 2 — git blame on definition line range
      const blameLines: BlameEntry[] = [];
      try {
        const { stdout: blameOutput } = await runGit(
          [
            "blame",
            "--porcelain",
            `-L${blameStart},${blameEnd}`,
            "--",
            blameFile,
          ],
          workspace,
          { signal: compositeSignal, timeout: 10_000, maxBuffer: 256 * 1024 },
        );

        let currentHash = "";
        let currentAuthor = "";
        let currentSummary = "";
        let currentLineNum = 0;

        for (const l of blameOutput.split("\n")) {
          if (!l) continue;
          const headerMatch = l.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
          if (headerMatch) {
            currentHash = headerMatch[1] ?? "";
            currentLineNum = Number(headerMatch[2]);
            continue;
          }
          if (l.startsWith("author ")) currentAuthor = l.slice(7).trim();
          else if (l.startsWith("summary ")) currentSummary = l.slice(8).trim();
          else if (l.startsWith("\t")) {
            blameLines.push({
              line: currentLineNum,
              hash: currentHash.slice(0, 12),
              author: currentAuthor,
              summary: currentSummary,
            });
          }
        }
      } catch {
        // blame failure is non-fatal — return empty blame array
      }

      // Step 3 — git log on definition file (follow renames)
      const recentCommits: SymbolCommit[] = [];
      try {
        const { stdout: logOutput } = await runGit(
          [
            "log",
            `--max-count=${maxCommits}`,
            "--follow",
            "--format=%H%x1f%h%x1f%an%x1f%ai%x1f%s",
            "--",
            blameFile,
          ],
          workspace,
          { signal: compositeSignal, timeout: 10_000, maxBuffer: 256 * 1024 },
        );

        for (const logLine of logOutput.split("\n")) {
          const trimmed = logLine.trim();
          if (!trimmed) continue;
          const parts = trimmed.split("\x1f");
          if (parts.length >= 5) {
            recentCommits.push({
              hash: parts[0] ?? "",
              shortHash: parts[1] ?? "",
              author: parts[2] ?? "",
              date: parts[3] ?? "",
              message: parts[4] ?? "",
            });
          }
        }
      } catch {
        // log failure is non-fatal
      }

      return successStructured({
        symbol: {
          queryFile: filePath,
          queryLine: line,
          queryColumn: column,
        },
        definition:
          defFile && defLine
            ? {
                file: defFile,
                line: defLine,
                ...(defColumn !== null && { column: defColumn }),
              }
            : null,
        blame: blameLines,
        recentCommits,
        ...(defFile ? { definitionFile: defFile } : {}),
        ...(blameLines.length === 0 && recentCommits.length === 0
          ? { note: "No git history found — file may be untracked." }
          : {}),
      });
    },
  };
}
