import path from "node:path";
import type { ExtensionClient } from "../extensionClient.js";
import { execSafe, optionalString, resolveFilePath, success } from "./utils.js";

const SEVERITY_PREFIXES: Record<string, string> = {
  fix: "fix",
  todo: "todo",
  question: "question",
  warn: "warn",
  task: "task",
};

function parseSeverityFromComment(comment: string): {
  severity: string;
  text: string;
} {
  const match = comment.match(/^(FIX|TODO|QUESTION|WARN|TASK)\s*:?\s*/i);
  if (match) {
    const key = match[1]!.toLowerCase();
    return {
      severity: SEVERITY_PREFIXES[key] ?? "task",
      text: comment.slice(match[0].length).trim(),
    };
  }
  return { severity: "task", text: comment };
}

// Grep pattern covering all supported AI comment syntaxes:
// // AI:, # AI:, /* AI:, <!-- AI:, -- AI:, %% AI:, ' AI:
const GREP_PATTERN = "(\\/\\/|#|/\\*|<!--|--|%%|')\\s*AI:\\s*";

const GREP_INCLUDE_GLOBS = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.jsx",
  "*.py",
  "*.rb",
  "*.go",
  "*.rs",
  "*.java",
  "*.kt",
  "*.swift",
  "*.c",
  "*.cpp",
  "*.h",
  "*.cs",
  "*.php",
  "*.lua",
  "*.sql",
  "*.hs",
  "*.erl",
  "*.ex",
  "*.exs",
  "*.ml",
  "*.vb",
  "*.m",
  "*.html",
  "*.vue",
  "*.svelte",
  "*.css",
  "*.scss",
  "*.yaml",
  "*.yml",
  "*.toml",
  "*.sh",
];

export function createGetAICommentsTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "getAIComments",
      description:
        "Get pending AI comment directives (// AI: ..., # AI: ..., /* AI: */, <!-- AI: -->, -- AI:, %% AI:, ' AI:) found in workspace source files. These are inline instructions from developers for Claude to act on. Supports severity prefixes: AI:FIX, AI:TODO, AI:QUESTION, AI:WARN.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          file: {
            type: "string",
            description:
              "Optional file path to filter comments for a specific file",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const rawFile = optionalString(args, "file");

      // If extension is connected, use it
      if (extensionClient.isConnected()) {
        const allComments: Array<{
          file: string;
          line: number;
          comment: string;
          syntax: string;
          fullLine: string;
          severity: string;
        }> = [];

        for (const [, comments] of extensionClient.latestAIComments) {
          for (const c of comments) {
            const { severity, text } = parseSeverityFromComment(c.comment);
            allComments.push({
              ...c,
              comment: text,
              severity: c.severity ?? severity,
            });
          }
        }

        // If no cached comments, try on-demand request
        if (allComments.length === 0) {
          try {
            const result = await extensionClient.getAIComments();
            if (Array.isArray(result)) {
              for (const c of result) {
                const { severity, text } = parseSeverityFromComment(c.comment);
                allComments.push({
                  file: c.file,
                  line: c.line,
                  comment: text,
                  syntax: c.syntax,
                  fullLine: c.fullLine,
                  severity: c.severity ?? severity,
                });
              }
            }
          } catch {
            // Extension may not support on-demand scan yet
          }
        }

        let filtered = allComments;
        if (rawFile) {
          const resolved = resolveFilePath(rawFile, workspace);
          filtered = allComments.filter((c) => c.file === resolved);
        }

        return success({
          available: true,
          source: "extension",
          comments: filtered,
          count: filtered.length,
        });
      }

      // Grep fallback when extension is not connected
      const grepArgs = ["-rn", "-E", "-m", "500", GREP_PATTERN];
      for (const glob of GREP_INCLUDE_GLOBS) {
        grepArgs.push("--include", glob);
      }

      if (rawFile) {
        grepArgs.push(resolveFilePath(rawFile, workspace));
      } else {
        grepArgs.push(workspace);
      }

      const result = await execSafe("grep", grepArgs, {
        cwd: workspace,
        signal,
        timeout: 10000,
      });

      const comments: Array<{
        file: string;
        line: number;
        comment: string;
        syntax: string;
        fullLine: string;
        severity: string;
      }> = [];

      if (result.stdout) {
        for (const line of result.stdout.split("\n")) {
          if (!line.trim()) continue;
          // Parse grep output: file:line:content
          const match = line.match(/^(.+?):(\d+):(.+)$/);
          if (!match) continue;

          const file = match[1]!;
          const lineNum = Number.parseInt(match[2]!, 10);
          const fullLine = match[3]!.trim();

          // Extract AI comment text
          const commentMatch = fullLine.match(
            /(?:\/\/|#|\/\*|<!--|--|%%|')\s*AI:\s*(.+)/i,
          );
          if (!commentMatch) continue;

          const rawComment = commentMatch[1]!
            .replace(/\s*\*\/\s*$/, "")
            .replace(/\s*-->\s*$/, "")
            .trim();

          // Detect syntax
          let syntax = "//";
          if (fullLine.includes("/* AI:")) syntax = "/*";
          else if (fullLine.includes("<!-- AI:")) syntax = "<!--";
          else if (fullLine.includes("# AI:")) syntax = "#";
          else if (fullLine.includes("-- AI:")) syntax = "--";
          else if (fullLine.includes("%% AI:")) syntax = "%%";
          else if (fullLine.includes("' AI:")) syntax = "'";

          const { severity, text } = parseSeverityFromComment(rawComment);

          comments.push({
            file: path.isAbsolute(file) ? file : path.resolve(workspace, file),
            line: lineNum,
            comment: text,
            syntax,
            fullLine,
            severity,
          });
        }
      }

      return success({
        available: true,
        source: "grep-fallback",
        comments,
        count: comments.length,
      });
    },
  };
}
