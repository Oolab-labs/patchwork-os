/**
 * GitHub tools — github.list_issues, github.list_prs, github.list_commits
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// github.list_issues
// ============================================================================

registerTool({
  id: "github.list_issues",
  namespace: "github",
  description:
    "List GitHub issues by assignee, label, and/or state. Defaults to issues assigned to the current user; pass assignee:'any' to drop the assignee filter (e.g. label-scoped dedup queries).",
  paramsSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description:
          "Repository in 'owner/repo' format (omit for all accessible repos)",
      },
      assignee: {
        type: "string",
        description:
          "User to filter by (use '@me' for current user, or 'any'/'*' to drop the assignee filter entirely)",
        default: "@me",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description:
          "Only issues carrying ALL of these labels (GitHub AND semantics). Omit for no label filter.",
      },
      state: {
        type: "string",
        enum: ["open", "closed", "all"],
        description: "Issue state filter (default 'open').",
        default: "open",
      },
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      issues: { type: "array" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { listIssues } = await import("../../connectors/github.js");
    const repo = params.repo ? String(params.repo) : undefined;
    // `assignee` defaults to @me, but "any"/"*"/"" drops the filter so a
    // label-scoped query (e.g. dedup against worker-filed, unassigned issues)
    // sees ALL matching issues, not just the caller's.
    const rawAssignee = params.assignee ? String(params.assignee) : "@me";
    const assignee =
      rawAssignee === "any" || rawAssignee === "*" || rawAssignee === ""
        ? undefined
        : rawAssignee;
    // Accept both the YAML list form (`labels: [a, b]`) and a lone scalar
    // (`labels: test-failure`) — the latter is a common hand-authoring shape
    // that would otherwise be silently dropped (no filter → lists every issue).
    const labels = Array.isArray(params.labels)
      ? params.labels.map(String).filter(Boolean)
      : typeof params.labels === "string" && params.labels
        ? [params.labels]
        : undefined;
    const stateRaw = params.state ? String(params.state) : "open";
    const state =
      stateRaw === "open" || stateRaw === "closed" || stateRaw === "all"
        ? (stateRaw as "open" | "closed" | "all")
        : "open";
    const limit = typeof params.max === "number" ? params.max : 20;
    try {
      const issues = await listIssues({ repo, assignee, labels, state, limit });
      return JSON.stringify({ count: issues.length, issues });
    } catch (err) {
      // Translate connector throw into the {count:0, issues:[], error}
      // shape that the runner's silent-fail detector (PR #72) catches
      // as a step error. Pre-fix this just propagated as a thrown
      // error which the runner caught fine — but the connector
      // itself used to silently `[]`-swallow all failures.
      return JSON.stringify({
        count: 0,
        issues: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// github.search_issues
// ============================================================================

registerTool({
  id: "github.search_issues",
  namespace: "github",
  description:
    "Search GitHub issues using the REST Search API. Accepts a full GitHub search query string (e.g. 'repo:owner/repo label:bug state:open'). More reliable than github.list_issues for cross-repo or label-scoped queries.",
  paramsSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "GitHub issue search query (qualifiers: repo:, label:, state:, author:, assignee:, etc.)",
      },
      max: {
        type: "number",
        description: "Max issues to return (default 30, cap 100)",
      },
    },
    required: ["query"],
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      issues: { type: "array" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { searchIssues } = await import("../../connectors/github.js");
    const query = String(params.query ?? "");
    const limit = typeof params.max === "number" ? params.max : 30;
    try {
      const issues = await searchIssues({ query, limit });
      return JSON.stringify({ count: issues.length, issues });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        issues: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// github.list_prs
// ============================================================================

registerTool({
  id: "github.list_prs",
  namespace: "github",
  description: "List GitHub pull requests authored by or involving a user.",
  paramsSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description:
          "Repository in 'owner/repo' format (omit for all accessible repos)",
      },
      author: {
        type: "string",
        description: "Author to filter by (use '@me' for current user)",
        default: "@me",
      },
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      prs: { type: "array" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { listPRs } = await import("../../connectors/github.js");
    const repo = params.repo ? String(params.repo) : undefined;
    const author = params.author ? String(params.author) : "@me";
    const limit = typeof params.max === "number" ? params.max : 20;
    try {
      const prs = await listPRs({ repo, author, limit });
      return JSON.stringify({ count: prs.length, prs });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        prs: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// github.list_commits
// ============================================================================

registerTool({
  id: "github.list_commits",
  namespace: "github",
  description:
    "List commits in a GitHub repository, optionally filtered by author and time range.",
  paramsSchema: {
    type: "object",
    required: ["repo"],
    properties: {
      repo: {
        type: "string",
        description: "Repository in 'owner/repo' format",
      },
      author: {
        type: "string",
        description:
          "GitHub username to filter by (use '@me' for the connected user)",
        default: "@me",
      },
      since: {
        type: "string",
        description:
          "ISO 8601 date-time string — only commits after this date. Example: '2026-05-19T00:00:00Z'",
      },
      until: {
        type: "string",
        description:
          "ISO 8601 date-time string — only commits before this date.",
      },
      sha: {
        type: "string",
        description:
          "Branch name or SHA to list commits from (default: default branch)",
      },
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      commits: { type: "array" },
      repo: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { listCommits } = await import("../../connectors/github.js");
    const repo = String(params.repo ?? "");
    const author = params.author ? String(params.author) : "@me";
    const limit = typeof params.max === "number" ? params.max : 100;
    try {
      const commits = await listCommits({
        repo,
        author,
        since: params.since ? String(params.since) : undefined,
        until: params.until ? String(params.until) : undefined,
        sha: params.sha ? String(params.sha) : undefined,
        limit,
      });
      return JSON.stringify({ count: commits.length, commits, repo });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        commits: [],
        repo,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// github.create_issue  (WRITE — the first GitHub-write recipe tool)
// ============================================================================

registerTool({
  id: "github.create_issue",
  namespace: "github",
  description:
    "Create a GitHub issue in a repository (title + optional body, labels, assignees).",
  paramsSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: "Repository in 'owner/repo' format (required)",
      },
      title: { type: "string", description: "Issue title (required)" },
      body: { type: "string", description: "Issue body (Markdown)" },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Labels to apply",
      },
      assignees: {
        type: "array",
        items: { type: "string" },
        description: "GitHub usernames to assign",
      },
      into: CommonSchemas.into,
    },
    required: ["repo", "title"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      number: { type: "number" },
      url: { type: "string" },
      title: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "high",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { createIssue } = await import("../../connectors/github.js");
    const repo = params.repo ? String(params.repo) : "";
    const title = params.title ? String(params.title) : "";
    try {
      const issue = await createIssue({
        repo,
        title,
        ...(params.body !== undefined && { body: String(params.body) }),
        ...(Array.isArray(params.labels) && {
          labels: params.labels.map(String),
        }),
        ...(Array.isArray(params.assignees) && {
          assignees: params.assignees.map(String),
        }),
      });
      return JSON.stringify({
        ok: true,
        number: issue.number,
        url: issue.url,
        title: issue.title,
      });
    } catch (err) {
      // A WRITE that failed MUST surface as a step error — return the
      // `{ok:false,error}` envelope so the runner's hard ok:false check
      // (yamlRunner) halts the run and the worker ramp records a FAILURE.
      // (The list_* read tools use a `{count:0,...,error}` shape instead;
      // a bare `{error}` would read as success here — review #1029 HIGH.)
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
