/**
 * Linear tools — linear.list_issues, linear.createIssue, linear.updateIssue,
 * linear.addComment.
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// linear.list_issues
// ============================================================================

registerTool({
  id: "linear.list_issues",
  namespace: "linear",
  description:
    "List Linear issues assigned to the current user, optionally filtered by team and state.",
  paramsSchema: {
    type: "object",
    properties: {
      team: {
        type: "string",
        description: "Team key to filter by (e.g., 'ENG', 'PROD')",
      },
      assignee: {
        type: "string",
        description:
          "Use '@me' for current user (default), or omit for all assignees",
        default: "@me",
      },
      state: {
        type: "string",
        description: "Comma-separated state names (e.g., 'started,unstarted')",
        default: "started,unstarted",
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
    const { loadTokens, listIssues: listLinearIssues } = await import(
      "../../connectors/linear.js"
    );

    if (!loadTokens()) {
      return JSON.stringify({
        count: 0,
        issues: [],
        error: "Linear not connected",
      });
    }

    const teamKey = params.team ? String(params.team) : undefined;
    const assigneeMe =
      params.assignee === "@me" || params.assignee === undefined;
    const stateFilter = params.state
      ? String(params.state)
      : "started,unstarted";
    const limit = typeof params.max === "number" ? params.max : 20;
    const states = stateFilter
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);

    try {
      const issues = await listLinearIssues({
        team: teamKey,
        assigneeMe,
        states,
        limit,
      });
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
// linear.createIssue
// ============================================================================

registerTool({
  id: "linear.createIssue",
  namespace: "linear",
  description:
    "Create a new Linear issue. Returns the created issue's id, identifier, url, and title.",
  paramsSchema: {
    type: "object",
    required: ["team", "title"],
    properties: {
      team: {
        type: "string",
        description: "Team name or ID (e.g., 'Engineering', 'Sales')",
      },
      title: { type: "string", description: "Issue title" },
      description: {
        type: "string",
        description: "Issue description (Markdown supported)",
      },
      priority: {
        type: "number",
        description: "Priority: 1=urgent, 2=high, 3=medium, 4=low",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Label names or IDs to attach",
      },
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      identifier: { type: "string" },
      title: { type: "string" },
      url: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { loadTokens, createIssue } = await import(
      "../../connectors/linear.js"
    );
    if (!loadTokens()) {
      return JSON.stringify({ error: "Linear not connected" });
    }
    try {
      const result = await createIssue({
        team: String(params.team),
        title: String(params.title),
        description: params.description
          ? String(params.description)
          : undefined,
        priority:
          typeof params.priority === "number" ? params.priority : undefined,
        labels: Array.isArray(params.labels)
          ? (params.labels as string[])
          : undefined,
      });
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// linear.updateIssue
// ============================================================================

registerTool({
  id: "linear.updateIssue",
  namespace: "linear",
  description:
    "Update an existing Linear issue (title, description, priority, state, assignee, labels).",
  paramsSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: {
        type: "string",
        description: "Issue identifier (e.g., 'ENG-42') or UUID",
      },
      title: { type: "string" },
      description: { type: "string" },
      priority: {
        type: "number",
        description: "Priority: 1=urgent, 2=high, 3=medium, 4=low",
      },
      state: {
        type: "string",
        description: "State name (e.g., 'In Progress')",
      },
      assignee: {
        type: "string",
        description: "Assignee name or email",
      },
      labels: {
        type: "array",
        items: { type: "string" },
      },
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      identifier: { type: "string" },
      title: { type: "string" },
      url: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { loadTokens, updateIssue } = await import(
      "../../connectors/linear.js"
    );
    if (!loadTokens()) {
      return JSON.stringify({ error: "Linear not connected" });
    }
    try {
      const result = await updateIssue({
        id: String(params.id),
        title: params.title ? String(params.title) : undefined,
        description: params.description
          ? String(params.description)
          : undefined,
        priority:
          typeof params.priority === "number" ? params.priority : undefined,
        state: params.state ? String(params.state) : undefined,
        assignee: params.assignee ? String(params.assignee) : undefined,
        labels: Array.isArray(params.labels)
          ? (params.labels as string[])
          : undefined,
      });
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// linear.addComment  (write-gated)
// ============================================================================

registerTool({
  id: "linear.addComment",
  namespace: "linear",
  description:
    "Append a comment to a Linear issue's timeline. Body supports Markdown.",
  paramsSchema: {
    type: "object",
    required: ["issue_id", "body"],
    properties: {
      issue_id: {
        type: "string",
        description: "Issue identifier (e.g., 'ENG-42'), UUID, or full URL",
      },
      body: {
        type: "string",
        description: "Comment body (Markdown supported, non-empty)",
        minLength: 1,
      },
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      id: { type: "string" },
      body: { type: "string" },
      url: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { loadTokens, addComment } = await import(
      "../../connectors/linear.js"
    );
    if (!loadTokens()) {
      return JSON.stringify({ ok: false, error: "Linear not connected" });
    }
    const issueId = typeof params.issue_id === "string" ? params.issue_id : "";
    const body = typeof params.body === "string" ? params.body : "";
    if (!issueId) {
      return JSON.stringify({
        ok: false,
        error: "addComment requires issue_id",
      });
    }
    if (!body) {
      return JSON.stringify({
        ok: false,
        error: "addComment requires non-empty body",
      });
    }
    try {
      const comment = await addComment(issueId, body);
      return JSON.stringify({
        ok: true,
        id: comment.id,
        body: comment.body,
        url: comment.url,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
