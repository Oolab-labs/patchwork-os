import type { ProbeResults } from "../probe.js";
import { resolveCommandPath } from "../probe.js";
import type { ProgressFn } from "../transport.js";
import {
  error,
  execSafe,
  makeRelative,
  optionalBool,
  optionalInt,
  optionalString,
  requireString,
  successStructuredLarge,
} from "./utils.js";

export function createSearchWorkspaceTool(
  workspace: string,
  probes: ProbeResults,
) {
  return {
    schema: {
      name: "searchWorkspace",
      description:
        "Search workspace files via ripgrep. Returns matching lines with file paths and line numbers.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search pattern (text or regex)",
          },
          fileGlob: {
            type: "string",
            description: "Optional glob to filter files (e.g. '*.ts')",
          },
          isRegex: {
            type: "boolean",
            description: "Treat query as regex (default: false)",
          },
          caseSensitive: {
            type: "boolean",
            description: "Case-sensitive search (default: true)",
          },
          maxResults: {
            type: "integer",
            description:
              "Max results to return (default: 50, max: 200; pass higher value explicitly for broader searches)",
            minimum: 1,
            maximum: 200,
          },
          contextLines: {
            type: "integer",
            description: "Lines of context around matches (default: 0, max: 5)",
            minimum: 0,
            maximum: 5,
          },
        },
        required: ["query"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          matches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "integer" },
                matchText: { type: "string" },
              },
              required: ["file", "line", "matchText"],
            },
          },
          totalMatches: { type: "integer" },
          tool: {
            type: "string",
            enum: ["rg", "grep"],
            description: "Search backend used",
          },
          truncated: {
            type: "boolean",
            description: "True when maxResults was reached",
          },
          note: { type: "string" },
        },
        required: ["matches", "totalMatches", "tool"],
      },
    },
    handler: async (
      args: Record<string, unknown>,
      signal?: AbortSignal,
      progress?: ProgressFn,
    ) => {
      progress?.(0, 100);
      const query = requireString(args, "query", 500);
      if (query.trim().length === 0) throw new Error("query must not be empty");
      const fileGlob = optionalString(args, "fileGlob", 200);
      const isRegex = optionalBool(args, "isRegex") ?? false;
      const caseSensitive = optionalBool(args, "caseSensitive") ?? true;
      const maxResults = optionalInt(args, "maxResults", 1, 200) ?? 50;
      const contextLines = optionalInt(args, "contextLines", 0, 5) ?? 0;

      // Reject patterns with nested quantifiers — these cause catastrophic backtracking (ReDoS)
      if (isRegex) {
        if (
          /\([^)]*[+*]\)[+*?]/.test(query) ||
          /\([^)]*\{[^}]+\}\)[+*{?]/.test(query) ||
          /[+*][+*]|\{[^}]+\}[+*]/.test(query)
        ) {
          return error(
            "Pattern contains nested quantifiers (e.g. (a+)+) which can cause catastrophic backtracking (ReDoS). " +
              "Simplify the regex — use a literal string match or a non-nested quantifier.",
          );
        }
      }

      if (probes.rg) {
        // Use ripgrep
        const rgArgs: string[] = ["--json", "--max-count", String(maxResults)];
        if (fileGlob) rgArgs.push("--glob", fileGlob);
        if (!caseSensitive) rgArgs.push("-i");
        if (!isRegex) rgArgs.push("--fixed-strings");
        if (contextLines > 0) rgArgs.push("-C", String(contextLines));
        rgArgs.push("--", query, workspace);

        const result = await execSafe(
          resolveCommandPath("rg", workspace),
          rgArgs,
          {
            timeout: 15000,
            maxBuffer: 1024 * 1024,
            signal,
          },
        );

        // Parse ripgrep JSON output
        const matches: Array<{
          file: string;
          line: number;
          column: number;
          matchText: string;
        }> = [];
        for (const line of result.stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === "match") {
              const d = entry.data;
              const filePath = d.path?.text ?? "";
              matches.push({
                file: makeRelative(filePath, workspace),
                line: d.line_number,
                column: d.submatches?.[0]?.start ?? 0,
                matchText: d.lines?.text?.trimEnd() ?? "",
              });
            }
          } catch {
            /* skip unparseable lines */
          }
        }
        const truncated = matches.length >= maxResults;
        return successStructuredLarge({
          matches,
          totalMatches: matches.length,
          tool: "rg",
          ...(truncated && {
            truncated: true,
            note: "Result limit reached — increase maxResults or narrow your query",
          }),
        });
      }

      // Fallback to grep
      const grepArgs: string[] = ["-rn"];
      if (fileGlob) grepArgs.push("--include", fileGlob);
      if (!caseSensitive) grepArgs.push("-i");
      if (!isRegex) grepArgs.push("-F");
      else grepArgs.push("-E");
      if (contextLines > 0) grepArgs.push(`-C${contextLines}`);
      grepArgs.push("--", query, workspace);

      const result = await execSafe("grep", grepArgs, {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        signal,
      });

      const matches: Array<{
        file: string;
        line: number;
        matchText: string;
      }> = [];
      for (const line of result.stdout.split("\n")) {
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (match) {
          const filePath = match[1] ?? "";
          matches.push({
            file: makeRelative(filePath, workspace),
            line: Number.parseInt(match[2] ?? "0", 10),
            matchText: match[3]?.trimEnd() ?? "",
          });
          if (matches.length >= maxResults) break;
        }
      }
      const truncated = matches.length >= maxResults;
      progress?.(100, 100);
      return successStructuredLarge({
        matches,
        totalMatches: matches.length,
        tool: "grep",
        ...(truncated && {
          truncated: true,
          note: "Result limit reached — increase maxResults or narrow your query",
        }),
      });
    },
  };
}
