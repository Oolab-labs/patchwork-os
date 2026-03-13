import {
  error,
  execSafe,
  optionalArray,
  optionalBool,
  optionalInt,
  optionalString,
  requireInt,
  requireString,
  success,
  truncateOutput,
} from "../utils.js";
import {
  GH_NOT_AUTHED,
  GH_NOT_FOUND,
  isNotAuthed,
  isNotFound,
} from "./shared.js";

const MAX_DIFF_BYTES = 256 * 1024; // 256 KB

async function resolveRepo(
  workspace: string,
  repoArg: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  if (repoArg) return repoArg;
  const result = await execSafe(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner", "--"],
    { cwd: workspace, signal, timeout: 10_000 },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

export function createGithubCreatePRTool(workspace: string) {
  return {
    schema: {
      name: "githubCreatePR",
      description:
        "Create a GitHub pull request for the current branch using the GitHub CLI (gh). " +
        "Requires gh to be installed (https://cli.github.com/) and authenticated via 'gh auth login'. " +
        "When no body is provided, uses commit messages to fill the description (--fill). " +
        "Returns the PR URL and number.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["title"],
        properties: {
          title: {
            type: "string",
            description: "Pull request title",
          },
          body: {
            type: "string",
            description:
              "Pull request description. If omitted, uses commit messages to fill the body.",
          },
          base: {
            type: "string",
            description:
              "Base branch to merge into (default: repository default branch)",
          },
          draft: {
            type: "boolean",
            description: "Create as a draft pull request. Default: false.",
          },
          assignee: {
            type: "string",
            description: "GitHub username to assign the PR to",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const title = requireString(args, "title", 256);
      const body = optionalString(args, "body", 65_536);
      const base = optionalString(args, "base", 256);
      const draft = optionalBool(args, "draft") ?? false;
      const assignee = optionalString(args, "assignee", 256);

      const prArgs = ["pr", "create", "--title", title];

      if (body !== undefined) {
        prArgs.push("--body", body);
      } else {
        prArgs.push("--fill");
      }

      if (base) prArgs.push("--base", base);
      if (draft) prArgs.push("--draft");
      if (assignee) prArgs.push("--assignee", assignee);
      prArgs.push("--");

      const result = await execSafe("gh", prArgs, {
        cwd: workspace,
        signal,
        timeout: 60_000,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(`${GH_NOT_AUTHED}\n${msg}`);
        if (msg.includes("already exists")) {
          return error(
            `A pull request already exists for this branch.\n${msg}`,
          );
        }
        if (msg.includes("No commits between")) {
          return error(
            `No commits between head branch and base — nothing to open a PR for.\n${msg}`,
          );
        }
        return error(`gh pr create failed: ${msg}`);
      }

      const url = result.stdout.trim();
      const numberMatch = url.match(/\/pull\/(\d+)/);
      const number = numberMatch
        ? Number.parseInt(numberMatch[1] ?? "0", 10)
        : null;

      return success({ url, number, title });
    },
  };
}

export function createGithubListPRsTool(workspace: string) {
  return {
    schema: {
      name: "githubListPRs",
      description:
        "List pull requests for the current GitHub repository using the GitHub CLI (gh). " +
        "Requires gh to be installed and authenticated.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          state: {
            type: "string",
            enum: ["open", "closed", "merged", "all"],
            description: "Filter by PR state. Default: open.",
          },
          limit: {
            type: "integer",
            description:
              "Maximum number of PRs to return (default: 20, max: 100)",
          },
          author: {
            type: "string",
            description: "Filter by author GitHub username",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const state = optionalString(args, "state", 32) ?? "open";
      const limit = optionalInt(args, "limit", 1, 100) ?? 20;
      const author = optionalString(args, "author", 256);

      if (!["open", "closed", "merged", "all"].includes(state)) {
        return error(
          `Invalid state "${state}". Must be: open, closed, merged, or all.`,
        );
      }

      const listArgs = [
        "pr",
        "list",
        "--state",
        state,
        "--limit",
        String(limit),
        "--json",
        "number,title,state,url,headRefName,baseRefName,author,createdAt,isDraft",
      ];
      if (author) listArgs.push("--author", author);

      const result = await execSafe("gh", listArgs, {
        cwd: workspace,
        signal,
        timeout: 30_000,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(GH_NOT_AUTHED);
        return error(`gh pr list failed: ${msg}`);
      }

      let prs: unknown;
      try {
        prs = JSON.parse(result.stdout.trim());
      } catch {
        return error(`Failed to parse gh output: ${result.stdout.trim()}`);
      }

      return success({ prs, count: Array.isArray(prs) ? prs.length : 0 });
    },
  };
}

export function createGithubViewPRTool(workspace: string) {
  return {
    schema: {
      name: "githubViewPR",
      description:
        "View details of a GitHub pull request using the GitHub CLI (gh). " +
        "Omit number to view the PR for the current branch. " +
        "Requires gh to be installed and authenticated.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          number: {
            type: "integer",
            description:
              "PR number to view. Omit to view the PR associated with the current branch.",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const number =
        typeof args.number === "number" ? Math.floor(args.number) : undefined;

      const viewArgs = [
        "pr",
        "view",
        "--json",
        "number,title,state,url,body,author,createdAt,updatedAt,baseRefName,headRefName,isDraft,mergeable,reviewDecision,reviews",
      ];
      if (number !== undefined) viewArgs.splice(2, 0, String(number));

      const result = await execSafe("gh", viewArgs, {
        cwd: workspace,
        signal,
        timeout: 30_000,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(GH_NOT_AUTHED);
        if (
          msg.includes("no pull requests found") ||
          msg.includes("no open pull request")
        ) {
          return error(
            number
              ? `PR #${number} not found.`
              : "No open pull request for the current branch. Create one with githubCreatePR.",
          );
        }
        return error(`gh pr view failed: ${msg}`);
      }

      let pr: unknown;
      try {
        pr = JSON.parse(result.stdout.trim());
      } catch {
        return error(`Failed to parse gh output: ${result.stdout.trim()}`);
      }

      return success(pr);
    },
  };
}

export function createGithubGetPRDiffTool(workspace: string) {
  return {
    schema: {
      name: "githubGetPRDiff",
      description:
        "Fetch the full diff and metadata for a GitHub pull request. " +
        "Returns the PR title, description, branch info, per-file change list, and the unified diff text — " +
        "everything needed to analyze the changes and identify bugs. " +
        "Inline review comments must target lines present in the diff; use the diff output to identify valid line numbers. " +
        "Diffs larger than 256 KB are truncated (truncated: true in response). " +
        "Requires gh to be installed (https://cli.github.com/) and authenticated via 'gh auth login'.",
      annotations: { readOnlyHint: true, openWorldHint: true },
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
            description:
              "Repository in owner/repo format. Defaults to the repository of the current workspace.",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const prNumber = requireInt(args, "prNumber", 1);
      const repoArg = optionalString(args, "repo", 256);

      const repoFlags = repoArg ? ["--repo", repoArg] : [];

      const [metaResult, diffResult] = await Promise.all([
        execSafe(
          "gh",
          [
            "pr",
            "view",
            String(prNumber),
            ...repoFlags,
            "--json",
            "number,title,body,state,baseRefName,headRefName,additions,deletions,changedFiles,files,author,createdAt,isDraft,mergeable",
            "--",
          ],
          { cwd: workspace, signal, timeout: 30_000 },
        ),
        execSafe("gh", ["pr", "diff", String(prNumber), ...repoFlags, "--"], {
          cwd: workspace,
          signal,
          timeout: 30_000,
        }),
      ]);

      if (metaResult.exitCode !== 0) {
        const msg = metaResult.stderr.trim() || metaResult.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(`${GH_NOT_AUTHED}\n${msg}`);
        if (msg.includes("Could not resolve") || msg.includes("not found")) {
          return error(
            `PR #${prNumber} not found. Check the PR number and repository.`,
          );
        }
        return error(`gh pr view failed: ${msg}`);
      }

      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(metaResult.stdout.trim()) as Record<string, unknown>;
      } catch {
        return error(
          `Failed to parse PR metadata: ${metaResult.stdout.trim()}`,
        );
      }

      const files = Array.isArray(meta.files) ? meta.files : [];
      const changedFiles =
        typeof meta.changedFiles === "number" ? meta.changedFiles : 0;
      const filesIncomplete = changedFiles > 0 && files.length < changedFiles;

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
        diff = `(diff unavailable: ${diffErr || "unknown error"})`;
      }

      return success({
        ...meta,
        diff,
        ...(diffTruncated
          ? {
              truncated: true,
              note: "Diff truncated at 256 KB — use getGitDiff or gh pr diff for the full output.",
            }
          : {}),
        ...(filesIncomplete
          ? {
              filesIncomplete: true,
              filesNote: `Only ${files.length} of ${changedFiles} changed files returned. Use 'gh pr view ${prNumber} --json files' for the full list.`,
            }
          : {}),
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
        "Inline comments MUST target lines that appear in the diff — comments on lines outside the diff hunks will cause the entire review to fail. " +
        "Use side:'RIGHT' for added/context lines (default) and side:'LEFT' for deleted lines. " +
        "Set event to 'REQUEST_CHANGES' to request changes, or leave as 'COMMENT' for a non-blocking review. " +
        "Approving PRs is intentionally not supported — that remains a human decision. " +
        "Requires gh to be installed and authenticated.",
      annotations: { destructiveHint: false, openWorldHint: true },
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
            description:
              "Overview review comment in Markdown. Summarize findings, severity, and any patterns noticed.",
          },
          comments: {
            type: "array",
            description:
              "Inline comments on specific diff lines. Only lines present in the diff can be annotated.",
            items: {
              type: "object",
              required: ["path", "line", "body"],
              properties: {
                path: {
                  type: "string",
                  description:
                    "File path relative to repo root (e.g. src/foo.ts)",
                },
                line: {
                  type: "integer",
                  description: "Line number in the file",
                },
                side: {
                  type: "string",
                  enum: ["LEFT", "RIGHT"],
                  description:
                    "Diff side: RIGHT for added/context lines (default), LEFT for deleted lines.",
                },
                body: {
                  type: "string",
                  description:
                    "Comment text describing the issue found on this line",
                },
              },
              additionalProperties: false,
            },
          },
          event: {
            type: "string",
            enum: ["COMMENT", "REQUEST_CHANGES"],
            description:
              "Review event. COMMENT (default) leaves a non-blocking review. REQUEST_CHANGES blocks merging until resolved.",
          },
          repo: {
            type: "string",
            description:
              "Repository in owner/repo format. Defaults to the repository of the current workspace.",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const prNumber = requireInt(args, "prNumber", 1);
      const body = requireString(args, "body", 65_535);
      const comments = optionalArray(args, "comments");
      const repoArg = optionalString(args, "repo", 256);
      const eventArg = optionalString(args, "event", 32) ?? "COMMENT";

      if (!["COMMENT", "REQUEST_CHANGES"].includes(eventArg)) {
        return error(
          `Invalid event "${eventArg}". Must be COMMENT or REQUEST_CHANGES.`,
        );
      }

      const inlineComments: Array<{
        path: string;
        line: number;
        side: string;
        body: string;
      }> = [];
      if (comments) {
        for (const c of comments) {
          if (typeof c !== "object" || c === null)
            return error("Each comment must be an object.");
          const obj = c as Record<string, unknown>;
          if (typeof obj.path !== "string" || !obj.path)
            return error("Each comment must have a non-empty 'path' string.");
          if (obj.path.includes("..") || obj.path.startsWith("/")) {
            return error(
              "Comment path must be relative to the repo root and cannot contain '..' or start with '/'.",
            );
          }
          if (
            typeof obj.line !== "number" ||
            !Number.isInteger(obj.line) ||
            obj.line < 1
          ) {
            return error("Each comment must have a positive integer 'line'.");
          }
          if (typeof obj.body !== "string" || !obj.body)
            return error("Each comment must have a non-empty 'body' string.");
          const side =
            typeof obj.side === "string" && obj.side === "LEFT"
              ? "LEFT"
              : "RIGHT";
          inlineComments.push({
            path: obj.path,
            line: obj.line,
            side,
            body: obj.body,
          });
        }
      }

      const repo = await resolveRepo(workspace, repoArg, signal);
      if (!repo) {
        return error(
          "Could not determine repository. Pass 'repo' as owner/repo or run from inside a git repository.",
        );
      }

      const payload = {
        body,
        event: eventArg,
        comments: inlineComments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body,
        })),
      };

      const apiArgs = [
        "api",
        `repos/${repo}/pulls/${prNumber}/reviews`,
        "-X",
        "POST",
        "--input",
        "-",
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
        if (msg.includes("HTTP 429") || msg.includes("secondary rate limit")) {
          return error(
            `GitHub API rate limited. Wait a few minutes and retry.\n${msg}`,
          );
        }
        if (msg.includes("HTTP 403") && !isNotAuthed(msg)) {
          return error(
            `GitHub API access forbidden. Check repository permissions or secondary rate limits.\n${msg}`,
          );
        }
        if (
          msg.includes("pull_request_review_thread.line") ||
          msg.includes("is not part of the pull request")
        ) {
          return error(
            `One or more inline comment lines are not part of the diff. Only lines that appear in the diff hunks can receive inline comments. Verify line numbers against the diff returned by githubGetPRDiff, and ensure side:'LEFT' is used for deleted lines.\n${msg}`,
          );
        }
        return error(`Failed to post review: ${msg}`);
      }

      let reviewData: Record<string, unknown> = {};
      try {
        reviewData = JSON.parse(result.stdout.trim()) as Record<
          string,
          unknown
        >;
      } catch {
        // Non-fatal — return what we know
      }

      return success({
        reviewId: reviewData.id ?? null,
        url:
          reviewData.html_url ?? `https://github.com/${repo}/pull/${prNumber}`,
        event: eventArg,
        commentsPosted: inlineComments.length,
      });
    },
    timeoutMs: 30_000,
  };
}
