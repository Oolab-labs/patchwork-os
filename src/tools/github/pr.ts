import { execSafe, requireString, optionalString, optionalInt, optionalBool, success, error } from "../utils.js";
import { GH_NOT_FOUND, GH_NOT_AUTHED, isNotFound, isNotAuthed } from "./shared.js";

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
            description: "Pull request description. If omitted, uses commit messages to fill the body.",
          },
          base: {
            type: "string",
            description: "Base branch to merge into (default: repository default branch)",
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

      const result = await execSafe("gh", prArgs, { cwd: workspace, signal, timeout: 60_000 });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(`${GH_NOT_AUTHED}\n${msg}`);
        if (msg.includes("already exists")) {
          return error(`A pull request already exists for this branch.\n${msg}`);
        }
        if (msg.includes("No commits between")) {
          return error(`No commits between head branch and base — nothing to open a PR for.\n${msg}`);
        }
        return error(`gh pr create failed: ${msg}`);
      }

      const url = result.stdout.trim();
      const numberMatch = url.match(/\/pull\/(\d+)/);
      const number = numberMatch ? parseInt(numberMatch[1]!, 10) : null;

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
            description: "Maximum number of PRs to return (default: 20, max: 100)",
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
        return error(`Invalid state "${state}". Must be: open, closed, merged, or all.`);
      }

      const listArgs = [
        "pr", "list",
        "--state", state,
        "--limit", String(limit),
        "--json", "number,title,state,url,headRefName,baseRefName,author,createdAt,isDraft",
      ];
      if (author) listArgs.push("--author", author);

      const result = await execSafe("gh", listArgs, { cwd: workspace, signal, timeout: 30_000 });

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
            description: "PR number to view. Omit to view the PR associated with the current branch.",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const number = typeof args.number === "number" ? Math.floor(args.number) : undefined;

      const viewArgs = [
        "pr", "view",
        "--json",
        "number,title,state,url,body,author,createdAt,updatedAt,baseRefName,headRefName,isDraft,mergeable,reviewDecision,reviews",
      ];
      if (number !== undefined) viewArgs.splice(2, 0, String(number));

      const result = await execSafe("gh", viewArgs, { cwd: workspace, signal, timeout: 30_000 });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim();
        if (isNotFound(msg)) return error(GH_NOT_FOUND);
        if (isNotAuthed(msg)) return error(GH_NOT_AUTHED);
        if (msg.includes("no pull requests found") || msg.includes("no open pull request")) {
          return error(
            number
              ? `PR #${number} not found.`
              : `No open pull request for the current branch. Create one with githubCreatePR.`,
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
