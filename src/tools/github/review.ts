import { execSafe, requireInt, optionalString, optionalArray, success, error, truncateOutput } from "../utils.js";
import { GH_NOT_FOUND, GH_NOT_AUTHED, isNotFound, isNotAuthed } from "./shared.js";

const MAX_DIFF_BYTES = 256 * 1024; // 256 KB

async function resolveRepo(workspace: string, repoArg: string | undefined, signal?: AbortSignal): Promise<string | null> {
  if (repoArg) return repoArg;
  const result = await execSafe(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner", "--"],
    { cwd: workspace, signal, timeout: 10_000 },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

export function createGithubGetPRDiffTool(workspace: string) {
  return {
    schema: {
      name: "githubGetPRDiff",
      description:
        "Fetch the full diff and metadata for a GitHub pull request. " +
        "Returns the PR title, description, branch info, changed file list, and the unified diff text — " +
        "everything needed to analyze the changes and identify bugs. " +
        "Diffs larger than 256 KB are truncated (truncated: true in response). " +
        "Requires gh to be installed (https://cli.github.com/) and authenticated via 'gh auth login'.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["prNumber"],
        properties: {
          prNumber: {
            type: "integer",
            description: "Pull request number",
          },
          repo: {
            type: "string",
            description: "Repository in owner/repo format. Defaults to the repository of the current workspace.",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const prNumber = requireInt(args, "prNumber", 1);
      const repoArg = optionalString(args, "repo", 256);

      const repoFlags = repoArg ? ["--repo", repoArg] : [];

      // Fetch metadata and diff in parallel
      const [metaResult, diffResult] = await Promise.all([
        execSafe(
          "gh",
          [
            "pr", "view", String(prNumber),
            ...repoFlags,
            "--json",
            "number,title,body,state,baseRefName,headRefName,additions,deletions,changedFiles,author,createdAt,isDraft,mergeable",
            "--",
          ],
          { cwd: workspace, signal, timeout: 30_000 },
        ),
        execSafe(
          "gh",
          ["pr", "diff", String(prNumber), ...repoFlags, "--"],
          { cwd: workspace, signal, timeout: 30_000 },
        ),
      ]);

      if (metaResult.exitCode !== 0) {
        const msg = metaResult.stderr.trim() || metaResult.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(`${GH_NOT_AUTHED}\n${msg}`);
        if (msg.includes("Could not resolve") || msg.includes("not found")) {
          return error(`PR #${prNumber} not found. Check the PR number and repository.`);
        }
        return error(`gh pr view failed: ${msg}`);
      }

      let meta: unknown;
      try {
        meta = JSON.parse(metaResult.stdout.trim());
      } catch {
        return error(`Failed to parse PR metadata: ${metaResult.stdout.trim()}`);
      }

      // Diff fetch may fail for closed/merged PRs in some gh versions — treat as warning, not fatal
      let diff = "";
      let diffTruncated = false;
      if (diffResult.exitCode === 0) {
        const truncated = truncateOutput(diffResult.stdout, MAX_DIFF_BYTES);
        diff = truncated.text;
        diffTruncated = truncated.truncated;
      } else {
        const diffErr = diffResult.stderr.trim();
        if (isNotFound(diffErr)) return error(GH_NOT_FOUND);
        if (isNotAuthed(diffErr)) return error(`${GH_NOT_AUTHED}\n${diffErr}`);
        // Non-fatal: include empty diff with a note
        diff = `(diff unavailable: ${diffErr || "unknown error"})`;
      }

      return success({
        ...(meta as object),
        diff,
        ...(diffTruncated ? { truncated: true, note: "Diff truncated at 256 KB — use getGitDiff or gh pr diff for the full output." } : {}),
      });
    },
    timeoutMs: 30_000,
  };
}

export function createGithubPostPRReviewTool(workspace: string) {
  return {
    schema: {
      name: "githubPostPRReview",
      description:
        "Post a code review on a GitHub pull request: an overview comment plus optional inline comments on specific lines. " +
        "Use after analyzing the PR diff with githubGetPRDiff. " +
        "Set event to 'REQUEST_CHANGES' to request changes, or leave as 'COMMENT' for a non-blocking review. " +
        "Approving PRs is intentionally not supported — that remains a human decision. " +
        "Requires gh to be installed and authenticated.",
      annotations: { destructiveHint: false },
      inputSchema: {
        type: "object" as const,
        required: ["prNumber", "body"],
        properties: {
          prNumber: {
            type: "integer",
            description: "Pull request number",
          },
          body: {
            type: "string",
            description: "Overview review comment in Markdown. Summarize findings, severity, and any patterns noticed.",
          },
          comments: {
            type: "array",
            description: "Inline comments on specific lines. Each comment pins to an exact file and line.",
            items: {
              type: "object",
              required: ["path", "line", "body"],
              properties: {
                path: { type: "string", description: "File path relative to repo root (e.g. src/foo.ts)" },
                line: { type: "integer", description: "Line number in the file (in the new/right side of the diff)" },
                body: { type: "string", description: "Comment text describing the issue found on this line" },
              },
              additionalProperties: false,
            },
          },
          event: {
            type: "string",
            enum: ["COMMENT", "REQUEST_CHANGES"],
            description: "Review event. COMMENT (default) leaves a non-blocking review. REQUEST_CHANGES blocks merging until resolved.",
          },
          repo: {
            type: "string",
            description: "Repository in owner/repo format. Defaults to the repository of the current workspace.",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const prNumber = requireInt(args, "prNumber", 1);
      const body = optionalString(args, "body", 65_535) ?? "";
      const comments = optionalArray(args, "comments");
      const repoArg = optionalString(args, "repo", 256);
      const eventArg = optionalString(args, "event", 32) ?? "COMMENT";

      if (!["COMMENT", "REQUEST_CHANGES"].includes(eventArg)) {
        return error(`Invalid event "${eventArg}". Must be COMMENT or REQUEST_CHANGES.`);
      }

      // Validate inline comments shape
      const inlineComments: Array<{ path: string; line: number; body: string }> = [];
      if (comments) {
        for (const c of comments) {
          if (typeof c !== "object" || c === null) return error("Each comment must be an object.");
          const obj = c as Record<string, unknown>;
          if (typeof obj.path !== "string" || !obj.path) return error("Each comment must have a non-empty 'path' string.");
          if (typeof obj.line !== "number" || !Number.isInteger(obj.line) || obj.line < 1) {
            return error("Each comment must have a positive integer 'line'.");
          }
          if (typeof obj.body !== "string" || !obj.body) return error("Each comment must have a non-empty 'body' string.");
          inlineComments.push({ path: obj.path, line: obj.line, body: obj.body });
        }
      }

      // Resolve owner/repo
      const repo = await resolveRepo(workspace, repoArg, signal);
      if (!repo) {
        return error("Could not determine repository. Pass 'repo' as owner/repo or run from inside a git repository.");
      }

      // Build the review payload and post via gh api using --input (stdin) to avoid arg-length limits
      const payload = {
        body,
        event: eventArg,
        comments: inlineComments.map((c) => ({
          path: c.path,
          line: c.line,
          side: "RIGHT",
          body: c.body,
        })),
      };

      const apiArgs = [
        "api",
        `repos/${repo}/pulls/${prNumber}/reviews`,
        "-X", "POST",
        "--input", "-",
        "--",
      ];

      const result = await execSafe("gh", apiArgs, {
        cwd: workspace,
        signal,
        timeout: 30_000,
        stdin: JSON.stringify(payload),
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(`${GH_NOT_AUTHED}\n${msg}`);
        if (msg.includes("pull_request_review_thread.line") || msg.includes("is not part of the pull request")) {
          return error(
            `One or more inline comment lines are not part of the diff. ` +
            `Only lines present in the diff can receive inline comments. ` +
            `Try posting without inline comments or verify line numbers against the diff.\n${msg}`,
          );
        }
        return error(`Failed to post review: ${msg}`);
      }

      let reviewData: Record<string, unknown> = {};
      try {
        reviewData = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      } catch {
        // Non-fatal — return what we know
      }

      return success({
        reviewId: reviewData.id ?? null,
        url: reviewData.html_url ?? `https://github.com/${repo}/pull/${prNumber}`,
        event: eventArg,
        commentsPosted: inlineComments.length,
      });
    },
    timeoutMs: 30_000,
  };
}
