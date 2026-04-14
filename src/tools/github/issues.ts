import {
  error,
  execSafe,
  optionalInt,
  optionalString,
  requireString,
  successStructured,
} from "../utils.js";
import {
  GH_NOT_AUTHED,
  GH_NOT_FOUND,
  isNotAuthed,
  isNotFound,
} from "./shared.js";

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
      outputSchema: {
        type: "object",
        properties: {
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                number: { type: "integer" },
                title: { type: "string" },
                state: { type: "string" },
                url: { type: "string" },
                author: { type: "object" },
                assignees: { type: "array" },
                labels: { type: "array" },
                createdAt: { type: "string" },
                updatedAt: { type: "string" },
              },
            },
          },
          count: { type: "integer" },
        },
        required: ["issues", "count"],
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

      return successStructured({
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
      outputSchema: {
        type: "object",
        properties: {
          number: { type: "integer" },
          title: { type: "string" },
          state: { type: "string" },
          url: { type: "string" },
          body: { type: ["string", "null"] },
          author: { type: "object" },
          assignees: { type: "array" },
          labels: { type: "array" },
          createdAt: { type: "string" },
          updatedAt: { type: "string" },
          comments: { type: "array" },
          milestone: { type: ["object", "null"] },
        },
        required: ["number", "title", "state", "url"],
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

      return successStructured(issue);
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
      outputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          number: { type: ["integer", "null"] },
          title: { type: "string" },
        },
        required: ["url", "number", "title"],
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
      const number = numberMatch
        ? Number.parseInt(numberMatch[1] ?? "0", 10)
        : null;

      return successStructured({ url, number, title });
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
      outputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          issueNumber: { type: "integer" },
        },
        required: ["url", "issueNumber"],
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

      const url = result.stdout.trim();
      return successStructured({ url, issueNumber: number });
    },
  };
}
