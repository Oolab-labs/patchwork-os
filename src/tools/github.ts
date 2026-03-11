import {
  error,
  execSafe,
  optionalInt,
  optionalString,
  requireString,
  success,
} from "./utils.js";

const GH_NOT_FOUND =
  "GitHub CLI (gh) not found. Install it from https://cli.github.com/ and run 'gh auth login'.";

const GH_NOT_AUTHED =
  "Not authenticated with GitHub. Run 'gh auth login' first.";

function isNotFound(msg: string): boolean {
  return msg.includes("ENOENT") || msg.includes("executable file not found");
}

function isNotAuthed(msg: string): boolean {
  return (
    msg.includes("not authenticated") ||
    msg.includes("auth login") ||
    msg.includes("GITHUB_TOKEN")
  );
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
      const draft = (args.draft as boolean) ?? false;
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

      // gh prints the PR URL on success
      const url = result.stdout.trim();
      const numberMatch = url.match(/\/pull\/(\d+)/);
      const number = numberMatch ? Number.parseInt(numberMatch[1]!, 10) : null;

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

export function createGithubListIssuesTool(workspace: string) {
  return {
    schema: {
      name: "githubListIssues",
      description:
        "List issues for the current GitHub repository using the GitHub CLI (gh). " +
        "Requires gh to be installed and authenticated.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          state: {
            type: "string",
            enum: ["open", "closed", "all"],
            description: "Filter by issue state. Default: open.",
          },
          limit: {
            type: "integer",
            description:
              "Maximum number of issues to return (default: 20, max: 100)",
          },
          assignee: {
            type: "string",
            description:
              "Filter by assignee GitHub username. Use '@me' for issues assigned to you.",
          },
          label: {
            type: "string",
            description: "Filter by label name",
          },
          milestone: {
            type: "string",
            description: "Filter by milestone title or number",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const state = optionalString(args, "state", 32) ?? "open";
      const limit = optionalInt(args, "limit", 1, 100) ?? 20;
      const assignee = optionalString(args, "assignee", 256);
      const label = optionalString(args, "label", 256);
      const milestone = optionalString(args, "milestone", 256);

      if (!["open", "closed", "all"].includes(state)) {
        return error(
          `Invalid state "${state}". Must be: open, closed, or all.`,
        );
      }

      const listArgs = [
        "issue",
        "list",
        "--state",
        state,
        "--limit",
        String(limit),
        "--json",
        "number,title,state,url,author,assignees,labels,createdAt,updatedAt",
      ];
      if (assignee) listArgs.push("--assignee", assignee);
      if (label) listArgs.push("--label", label);
      if (milestone) listArgs.push("--milestone", milestone);

      const result = await execSafe("gh", listArgs, {
        cwd: workspace,
        signal,
        timeout: 30_000,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(GH_NOT_AUTHED);
        return error(`gh issue list failed: ${msg}`);
      }

      let issues: unknown;
      try {
        issues = JSON.parse(result.stdout.trim());
      } catch {
        return error(`Failed to parse gh output: ${result.stdout.trim()}`);
      }

      return success({
        issues,
        count: Array.isArray(issues) ? issues.length : 0,
      });
    },
  };
}

export function createGithubGetIssueTool(workspace: string) {
  return {
    schema: {
      name: "githubGetIssue",
      description:
        "View full details of a GitHub issue including body and comments. " +
        "Requires gh to be installed and authenticated.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["number"],
        properties: {
          number: {
            type: "integer",
            description: "Issue number to view",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const number =
        typeof args.number === "number" ? Math.floor(args.number) : undefined;
      if (!number || number < 1)
        return error("number must be a positive integer");

      const viewArgs = [
        "issue",
        "view",
        String(number),
        "--json",
        "number,title,state,url,body,author,assignees,labels,createdAt,updatedAt,comments,milestone",
      ];

      const result = await execSafe("gh", viewArgs, {
        cwd: workspace,
        signal,
        timeout: 30_000,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(GH_NOT_AUTHED);
        if (msg.includes("Could not resolve") || msg.includes("not found")) {
          return error(`Issue #${number} not found.`);
        }
        return error(`gh issue view failed: ${msg}`);
      }

      let issue: unknown;
      try {
        issue = JSON.parse(result.stdout.trim());
      } catch {
        return error(`Failed to parse gh output: ${result.stdout.trim()}`);
      }

      return success(issue);
    },
  };
}

export function createGithubCreateIssueTool(workspace: string) {
  return {
    schema: {
      name: "githubCreateIssue",
      description:
        "Create a GitHub issue using the GitHub CLI (gh). " +
        "Requires gh to be installed and authenticated. Returns the issue URL and number.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["title"],
        properties: {
          title: {
            type: "string",
            description: "Issue title",
          },
          body: {
            type: "string",
            description: "Issue body / description (Markdown supported)",
          },
          assignee: {
            type: "string",
            description:
              "GitHub username to assign the issue to. Use '@me' to self-assign.",
          },
          label: {
            type: "string",
            description: "Label to apply to the issue",
          },
          milestone: {
            type: "string",
            description: "Milestone title or number to add the issue to",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const title = requireString(args, "title", 256);
      const body = optionalString(args, "body", 65_536);
      const assignee = optionalString(args, "assignee", 256);
      const label = optionalString(args, "label", 256);
      const milestone = optionalString(args, "milestone", 256);

      const issueArgs = ["issue", "create", "--title", title];
      if (body !== undefined) {
        issueArgs.push("--body", body);
      } else {
        issueArgs.push("--body", "");
      }
      if (assignee) issueArgs.push("--assignee", assignee);
      if (label) issueArgs.push("--label", label);
      if (milestone) issueArgs.push("--milestone", milestone);
      issueArgs.push("--");

      const result = await execSafe("gh", issueArgs, {
        cwd: workspace,
        signal,
        timeout: 30_000,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(`${GH_NOT_AUTHED}\n${msg}`);
        return error(`gh issue create failed: ${msg}`);
      }

      const url = result.stdout.trim();
      const numberMatch = url.match(/\/issues\/(\d+)/);
      const number = numberMatch ? Number.parseInt(numberMatch[1]!, 10) : null;

      return success({ url, number, title });
    },
  };
}

export function createGithubCommentIssueTool(workspace: string) {
  return {
    schema: {
      name: "githubCommentIssue",
      description:
        "Add a comment to a GitHub issue using the GitHub CLI (gh). " +
        "Requires gh to be installed and authenticated. Returns the comment URL.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["number", "body"],
        properties: {
          number: {
            type: "integer",
            description: "Issue number to comment on",
          },
          body: {
            type: "string",
            description: "Comment body (Markdown supported)",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const number =
        typeof args.number === "number" ? Math.floor(args.number) : undefined;
      if (!number || number < 1)
        return error("number must be a positive integer");
      const body = requireString(args, "body", 65_536);

      const commentArgs = [
        "issue",
        "comment",
        String(number),
        "--body",
        body,
        "--",
      ];

      const result = await execSafe("gh", commentArgs, {
        cwd: workspace,
        signal,
        timeout: 30_000,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(`${GH_NOT_AUTHED}\n${msg}`);
        if (msg.includes("Could not resolve") || msg.includes("not found")) {
          return error(`Issue #${number} not found.`);
        }
        return error(`gh issue comment failed: ${msg}`);
      }

      // gh prints the comment URL on success
      const url = result.stdout.trim();
      return success({ url, issueNumber: number });
    },
  };
}

export function createGithubListRunsTool(workspace: string) {
  return {
    schema: {
      name: "githubListRuns",
      description:
        "List GitHub Actions workflow runs for the current repository using the GitHub CLI (gh). " +
        "Use this to check CI status after a push or PR. The run ID (databaseId) can be passed to " +
        "githubGetRunLogs to retrieve failure details. Requires gh to be installed and authenticated.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          branch: {
            type: "string",
            description:
              "Filter by branch name. Omit to see runs across all branches.",
          },
          workflow: {
            type: "string",
            description:
              "Filter by workflow file name (e.g. 'ci.yml') or workflow name",
          },
          status: {
            type: "string",
            description:
              "Filter by run status: queued, in_progress, completed, failure, success, cancelled. " +
              "Omit to see all statuses.",
          },
          limit: {
            type: "integer",
            description:
              "Maximum number of runs to return (default: 10, max: 50)",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const branch = optionalString(args, "branch", 256);
      const workflow = optionalString(args, "workflow", 256);
      const status = optionalString(args, "status", 64);
      const limit = optionalInt(args, "limit", 1, 50) ?? 10;

      const listArgs = [
        "run",
        "list",
        "--limit",
        String(limit),
        "--json",
        "databaseId,name,status,conclusion,headBranch,headSha,url,createdAt,updatedAt,workflowName,event",
      ];
      if (branch) listArgs.push("--branch", branch);
      if (workflow) listArgs.push("--workflow", workflow);
      if (status) listArgs.push("--status", status);

      const result = await execSafe("gh", listArgs, {
        cwd: workspace,
        signal,
        timeout: 30_000,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(GH_NOT_AUTHED);
        return error(`gh run list failed: ${msg}`);
      }

      let runs: unknown;
      try {
        runs = JSON.parse(result.stdout.trim());
      } catch {
        return error(`Failed to parse gh output: ${result.stdout.trim()}`);
      }

      return success({ runs, count: Array.isArray(runs) ? runs.length : 0 });
    },
  };
}

const MAX_RUN_LOG_BYTES = 100 * 1024; // 100 KB — gh run logs can be enormous

export function createGithubGetRunLogsTool(workspace: string) {
  return {
    schema: {
      name: "githubGetRunLogs",
      description:
        "Get logs from a GitHub Actions workflow run using the GitHub CLI (gh). " +
        "By default returns only the failed steps' logs (most useful for diagnosing CI failures). " +
        "Pass the databaseId from githubListRuns as the runId. " +
        "Requires gh to be installed and authenticated.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["runId"],
        properties: {
          runId: {
            type: "integer",
            description: "Workflow run ID (databaseId from githubListRuns)",
          },
          failedOnly: {
            type: "boolean",
            description:
              "Return only logs from failed steps (default: true). Set false for full logs.",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const runId =
        typeof args.runId === "number" ? Math.floor(args.runId) : undefined;
      if (!runId || runId < 1) return error("runId must be a positive integer");
      const failedOnly = (args.failedOnly as boolean) ?? true;

      const viewArgs = [
        "run",
        "view",
        String(runId),
        `--log${failedOnly ? "-failed" : ""}`,
      ];

      const result = await execSafe("gh", viewArgs, {
        cwd: workspace,
        signal,
        timeout: 60_000,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(GH_NOT_AUTHED);
        if (msg.includes("no failed") || msg.includes("no logs")) {
          return success({
            logs: "",
            note: "No failed step logs found — the run may have succeeded or logs may have expired.",
          });
        }
        if (msg.includes("Could not find") || msg.includes("not found")) {
          return error(`Run #${runId} not found.`);
        }
        // gh exits non-zero when run is still in progress for --log-failed
        if (msg.includes("in progress") || msg.includes("still running")) {
          return error(
            `Run #${runId} is still in progress. Wait for it to complete before fetching logs.`,
          );
        }
        return error(`gh run view failed: ${msg}`);
      }

      let logs = result.stdout;
      let truncated = false;
      if (Buffer.byteLength(logs, "utf8") > MAX_RUN_LOG_BYTES) {
        // Keep the tail — failure details are usually at the end
        logs = `...[truncated — showing last portion]\n${logs.slice(-MAX_RUN_LOG_BYTES)}`;
        truncated = true;
      }

      return success({
        runId,
        failedOnly,
        logs,
        truncated: truncated || undefined,
      });
    },
  };
}
