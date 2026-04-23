import { error } from "../utils.js";
import {
  createGithubGetRunLogsTool,
  createGithubListRunsTool,
} from "./actions.js";
import {
  createGithubCommentIssueTool,
  createGithubCreateIssueTool,
  createGithubGetIssueTool,
  createGithubListIssuesTool,
} from "./issues.js";
import type { PullRequestCallbackResult } from "./pr.js";
import {
  createGithubApprovePRTool,
  createGithubCreatePRTool,
  createGithubGetPRDiffTool,
  createGithubListPRsTool,
  createGithubMergePRTool,
  createGithubPostPRReviewTool,
  createGithubViewPRTool,
} from "./pr.js";

export function createGithubPRTool(
  workspace: string,
  onPullRequest?: (result: PullRequestCallbackResult) => void,
  _defaultRepo: string | null = null,
) {
  const createPR = createGithubCreatePRTool(workspace, onPullRequest);
  const viewPR = createGithubViewPRTool(workspace);
  const listPRs = createGithubListPRsTool(workspace);
  const getDiff = createGithubGetPRDiffTool(workspace);
  const postReview = createGithubPostPRReviewTool(workspace);
  const approvePR = createGithubApprovePRTool(workspace);
  const mergePR = createGithubMergePRTool(workspace);

  return {
    schema: {
      name: "githubPR",
      description:
        "Composite GitHub pull request tool. Dispatches to the appropriate operation based on 'operation' field.\n" +
        "Operations:\n" +
        "  create — Create a PR (title required; optional: body, base, draft, assignee)\n" +
        "  view   — View PR details (optional: number — omit for current branch)\n" +
        "  list   — List PRs (optional: state, limit, author)\n" +
        "  getDiff — Fetch full diff + metadata (prNumber required; optional: repo)\n" +
        "  postReview — Post a code review COMMENT or REQUEST_CHANGES (prNumber, body required; optional: comments, event, repo)\n" +
        "  approve — Approve a PR (prNumber required; optional: body, repo)\n" +
        "  merge  — Merge a PR (prNumber required; optional: mergeMethod, commitTitle, commitMessage, repo)",
      annotations: { openWorldHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["operation"],
        properties: {
          operation: {
            type: "string",
            enum: [
              "create",
              "view",
              "list",
              "getDiff",
              "postReview",
              "approve",
              "merge",
            ],
            description: "Which PR operation to perform",
          },
          // create
          title: { type: "string", description: "PR title (create)" },
          body: {
            type: "string",
            description: "PR body / review body (create, postReview, approve)",
          },
          base: { type: "string", description: "Base branch (create)" },
          draft: {
            type: "boolean",
            description: "Draft PR flag (create)",
          },
          assignee: {
            type: "string",
            description: "Assignee username (create)",
          },
          // view / approve / merge / getDiff / postReview
          number: {
            type: "integer",
            description: "PR number (view — omit for current branch)",
          },
          prNumber: {
            type: "integer",
            description: "PR number (getDiff, postReview, approve, merge)",
          },
          repo: {
            type: "string",
            description:
              "owner/repo override (getDiff, postReview, approve, merge)",
          },
          // list
          state: {
            type: "string",
            enum: ["open", "closed", "merged", "all"],
            description: "PR state filter (list)",
          },
          limit: {
            type: "integer",
            description: "Max results (list)",
          },
          author: {
            type: "string",
            description: "Filter by author (list)",
          },
          // postReview
          comments: {
            type: "array",
            description: "Inline review comments (postReview)",
            items: { type: "object" },
          },
          event: {
            type: "string",
            enum: ["COMMENT", "REQUEST_CHANGES"],
            description: "Review event type (postReview)",
          },
          // merge
          mergeMethod: {
            type: "string",
            enum: ["merge", "squash", "rebase"],
            description: "Merge strategy (merge)",
          },
          commitTitle: {
            type: "string",
            description: "Merge commit title (merge)",
          },
          commitMessage: {
            type: "string",
            description: "Merge commit message (merge)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        description:
          "Result shape varies by operation — see individual tool outputSchemas",
        properties: {
          // create
          url: { type: "string" },
          number: { type: ["integer", "null"] },
          title: { type: "string" },
          // list
          prs: { type: "array" },
          count: { type: "integer" },
          // view
          state: { type: "string" },
          body: { type: "string" },
          // getDiff
          diff: { type: "string" },
          truncated: { type: "boolean" },
          // postReview / approve
          reviewId: { type: ["integer", "null"] },
          commentsPosted: { type: "integer" },
          event: { type: "string" },
          // merge
          merged: { type: "boolean" },
          sha: { type: "string" },
          message: { type: "string" },
        },
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const operation = args.operation as string;
      const rest = { ...args };
      delete rest.operation;

      switch (operation) {
        case "create":
          return createPR.handler(rest, signal);
        case "view":
          return viewPR.handler(rest, signal);
        case "list":
          return listPRs.handler(rest, signal);
        case "getDiff":
          return getDiff.handler(rest, signal);
        case "postReview":
          return postReview.handler(rest, signal);
        case "approve":
          return approvePR.handler(rest, signal);
        case "merge":
          return mergePR.handler(rest, signal);
        default:
          return error(
            `Unknown operation "${operation}". Must be one of: create, view, list, getDiff, postReview, approve, merge.`,
          );
      }
    },
  };
}

export function createGithubIssueTool(workspace: string) {
  const listIssues = createGithubListIssuesTool(workspace);
  const getIssue = createGithubGetIssueTool(workspace);
  const createIssue = createGithubCreateIssueTool(workspace);
  const commentIssue = createGithubCommentIssueTool(workspace);

  return {
    schema: {
      name: "githubIssue",
      description:
        "Composite GitHub issue tool. Dispatches to the appropriate operation based on 'operation' field.\n" +
        "Operations:\n" +
        "  list    — List issues (optional: state, limit, assignee, label, milestone)\n" +
        "  get     — View full issue details (number required)\n" +
        "  create  — Create a new issue (title required; optional: body, assignee, label, milestone)\n" +
        "  comment — Add a comment to an issue (number, body required)",
      annotations: { openWorldHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["operation"],
        properties: {
          operation: {
            type: "string",
            enum: ["list", "get", "create", "comment"],
            description: "Which issue operation to perform",
          },
          // get / comment
          number: {
            type: "integer",
            description: "Issue number (get, comment)",
          },
          // create
          title: { type: "string", description: "Issue title (create)" },
          body: {
            type: "string",
            description: "Issue body or comment body (create, comment)",
          },
          assignee: {
            type: "string",
            description: "Assignee username (create, list)",
          },
          label: {
            type: "string",
            description: "Label filter or label to apply (list, create)",
          },
          milestone: {
            type: "string",
            description: "Milestone filter or title (list, create)",
          },
          // list
          state: {
            type: "string",
            enum: ["open", "closed", "all"],
            description: "Issue state filter (list)",
          },
          limit: {
            type: "integer",
            description: "Max results (list)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        description: "Result shape varies by operation",
        properties: {
          // list
          issues: { type: "array" },
          count: { type: "integer" },
          // get
          number: { type: "integer" },
          title: { type: "string" },
          state: { type: "string" },
          url: { type: "string" },
          body: { type: ["string", "null"] },
          // comment
          issueNumber: { type: "integer" },
        },
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const operation = args.operation as string;
      const rest = { ...args };
      delete rest.operation;

      switch (operation) {
        case "list":
          return listIssues.handler(rest, signal);
        case "get":
          return getIssue.handler(rest, signal);
        case "create":
          return createIssue.handler(rest, signal);
        case "comment":
          return commentIssue.handler(rest, signal);
        default:
          return error(
            `Unknown operation "${operation}". Must be one of: list, get, create, comment.`,
          );
      }
    },
  };
}

export function createGithubActionsTool(
  workspace: string,
  defaultRepo: string | null = null,
) {
  const listRuns = createGithubListRunsTool(workspace, defaultRepo);
  const getRunLogs = createGithubGetRunLogsTool(workspace, defaultRepo);

  return {
    schema: {
      name: "githubActions",
      description:
        "Composite GitHub Actions tool. Dispatches to the appropriate operation based on 'operation' field.\n" +
        "Operations:\n" +
        "  listRuns   — List workflow runs (optional: branch, workflow, status, limit)\n" +
        "  getRunLogs — Fetch run logs (runId required; optional: failedOnly)",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["operation"],
        properties: {
          operation: {
            type: "string",
            enum: ["listRuns", "getRunLogs"],
            description: "Which Actions operation to perform",
          },
          // listRuns
          branch: {
            type: "string",
            description: "Filter by branch (listRuns)",
          },
          workflow: {
            type: "string",
            description: "Filter by workflow file or name (listRuns)",
          },
          status: {
            type: "string",
            description: "Filter by status (listRuns)",
          },
          limit: {
            type: "integer",
            description: "Max results (listRuns)",
          },
          // getRunLogs
          runId: {
            type: "integer",
            description: "Workflow run databaseId (getRunLogs)",
          },
          failedOnly: {
            type: "boolean",
            description: "Only failed step logs (getRunLogs, default: true)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        description: "Result shape varies by operation",
        properties: {
          // listRuns
          runs: { type: "array" },
          count: { type: "integer" },
          // getRunLogs
          runId: { type: "integer" },
          failedOnly: { type: "boolean" },
          logs: { type: "string" },
          truncated: { type: "boolean" },
          note: { type: "string" },
        },
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const operation = args.operation as string;
      const rest = { ...args };
      delete rest.operation;

      switch (operation) {
        case "listRuns":
          return listRuns.handler(rest, signal);
        case "getRunLogs":
          return getRunLogs.handler(rest, signal);
        default:
          return error(
            `Unknown operation "${operation}". Must be one of: listRuns, getRunLogs.`,
          );
      }
    },
  };
}
