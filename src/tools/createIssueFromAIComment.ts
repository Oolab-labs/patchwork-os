import path from "node:path";
import type { AIComment } from "../extensionClient.js";
import {
  error,
  execSafe,
  optionalString,
  requireInt,
  requireString,
  success,
} from "./utils.js";
import {
  GH_NOT_AUTHED,
  GH_NOT_FOUND,
  isNotAuthed,
  isNotFound,
} from "./github/shared.js";

export function createCreateIssueFromAICommentTool(
  workspace: string,
  latestAIComments: Map<string, AIComment[]>,
) {
  return {
    schema: {
      name: "createGithubIssueFromAIComment",
      description:
        "Create a GitHub issue from an AI comment found in the codebase. " +
        "Call getAIComments first to populate the cache, then use this to file an issue for a specific comment.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["file", "line"],
        properties: {
          file: {
            type: "string",
            description: "File containing the AI comment",
          },
          line: {
            type: "integer",
            minimum: 1,
            description: "Line number of the AI comment",
          },
          title: {
            type: "string",
            description: "Issue title (default: derived from comment text)",
          },
          labels: {
            type: "string",
            description: "Comma-separated labels (e.g. 'bug,ai-comment')",
          },
          assignee: {
            type: "string",
            description: "GitHub username to assign",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      const file = requireString(args, "file");
      const line = requireInt(args, "line", 1);
      const titleArg = optionalString(args, "title", 256);
      const labels = optionalString(args, "labels", 512);
      const assignee = optionalString(args, "assignee", 256);

      // Look up comment in cache
      const commentsForFile = latestAIComments.get(file);
      const comment = commentsForFile?.find((c) => c.line === line);

      if (!comment) {
        return error(
          `No AI comment found at ${file}:${line}. Run getAIComments first.`,
        );
      }

      // Derive title
      let title: string;
      if (titleArg) {
        title = titleArg;
      } else {
        const rawText = comment.comment ?? "";
        // Strip leading "AI:" prefix if present
        const stripped = rawText.replace(/^AI:\s*/i, "").trim();
        title = stripped.length > 72 ? stripped.slice(0, 72) : stripped;
      }

      // Compute relative path
      let relPath: string;
      try {
        relPath = path.relative(workspace, file);
      } catch {
        relPath = path.basename(file);
      }

      // Build body
      const body =
        `**AI Comment** found in \`${relPath}\` at line ${line}\n\n` +
        `> ${comment.comment}\n\n` +
        `**Severity:** ${comment.severity ?? "task"}\n\n` +
        `---\n` +
        `*Created from AI comment via Claude IDE Bridge*`;

      // Build gh args
      const ghArgs = ["issue", "create", "--title", title, "--body", body];
      if (labels) ghArgs.push("--label", labels);
      if (assignee) ghArgs.push("--assignee", assignee);

      const result = await execSafe("gh", ghArgs, {
        cwd: workspace,
        signal,
        timeout: 15_000,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(`${GH_NOT_AUTHED}\n${msg}`);
        return error(`gh issue create failed: ${msg}`);
      }

      const url = result.stdout.trim();
      const numberMatch = url.match(/\/issues\/(\d+)/);
      const number = numberMatch
        ? Number.parseInt(numberMatch[1] ?? "0", 10)
        : null;

      return success({
        url,
        number,
        title,
        commentFile: file,
        commentLine: line,
        severity: comment.severity ?? "task",
      });
    },
  };
}
