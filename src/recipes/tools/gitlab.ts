/**
 * GitLab tools — read-only wrappers (projects, issues, merge requests, user).
 *
 * Self-registering tool module for the recipe tool registry. Read-list tools
 * use `{count, items, error}` — single-object lookups (`get_issue`,
 * `get_current_user`) return the object spread with an optional `error`.
 *
 * Write tools (createIssue, createMergeRequestNote) are intentionally deferred
 * to a follow-up PR; this module only registers read-only methods.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// gitlab.get_current_user
// ============================================================================

registerTool({
  id: "gitlab.get_current_user",
  namespace: "gitlab",
  description: "Fetch the authenticated GitLab user (id, username, email).",
  paramsSchema: {
    type: "object",
    properties: {
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
      username: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async () => {
    const { getGitLabConnector } = await import("../../connectors/gitlab.js");
    try {
      const connector = getGitLabConnector();
      const user = await connector.getCurrentUser();
      return JSON.stringify({ ...user });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// gitlab.list_projects
// ============================================================================

registerTool({
  id: "gitlab.list_projects",
  namespace: "gitlab",
  description:
    "List GitLab projects. Defaults to the authenticated user's memberships.",
  paramsSchema: {
    type: "object",
    properties: {
      membership: {
        type: "boolean",
        description:
          "If true (default), only return projects the user is a member of.",
      },
      owned: {
        type: "boolean",
        description: "If true, only return projects owned by the user.",
      },
      search: {
        type: "string",
        description: "Optional substring search applied to project name/path.",
      },
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      items: { type: "array", items: { type: "object" } },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getGitLabConnector } = await import("../../connectors/gitlab.js");
    const limit = typeof params.max === "number" ? params.max : 50;
    try {
      const connector = getGitLabConnector();
      const projects = await connector.listProjects({
        membership:
          typeof params.membership === "boolean"
            ? params.membership
            : undefined,
        owned: typeof params.owned === "boolean" ? params.owned : undefined,
        search: typeof params.search === "string" ? params.search : undefined,
        limit,
      });
      return JSON.stringify({ count: projects.length, items: projects });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        items: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// gitlab.list_issues
// ============================================================================

registerTool({
  id: "gitlab.list_issues",
  namespace: "gitlab",
  description:
    "List GitLab issues. Pass projectId to scope to a project, or omit for issues across the user's projects.",
  paramsSchema: {
    type: "object",
    properties: {
      projectId: {
        type: ["string", "number"],
        description:
          "GitLab project id or URL-encoded path (e.g. 'group/repo').",
      },
      assignedToMe: {
        type: "boolean",
        description:
          "When projectId is omitted, restrict to issues assigned to the current user.",
      },
      state: {
        type: "string",
        enum: ["opened", "closed", "all"],
        description: "Filter by state. Default: GitLab returns 'opened'.",
      },
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      items: { type: "array", items: { type: "object" } },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getGitLabConnector } = await import("../../connectors/gitlab.js");
    const limit = typeof params.max === "number" ? params.max : 50;
    try {
      const connector = getGitLabConnector();
      const issues = await connector.listIssues({
        projectId: params.projectId as string | number | undefined,
        assignedToMe:
          typeof params.assignedToMe === "boolean"
            ? params.assignedToMe
            : undefined,
        state: params.state as "opened" | "closed" | "all" | undefined,
        limit,
      });
      return JSON.stringify({ count: issues.length, items: issues });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        items: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// gitlab.get_issue
// ============================================================================

registerTool({
  id: "gitlab.get_issue",
  namespace: "gitlab",
  description: "Fetch a single GitLab issue by project + issue iid.",
  paramsSchema: {
    type: "object",
    properties: {
      projectId: {
        type: ["string", "number"],
        description: "GitLab project id or URL-encoded path.",
      },
      issueIid: {
        type: "number",
        description: "Per-project issue iid (the number you see in URLs).",
      },
      into: CommonSchemas.into,
    },
    required: ["projectId", "issueIid"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
      iid: { type: "number" },
      title: { type: "string" },
      state: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getGitLabConnector } = await import("../../connectors/gitlab.js");
    try {
      const connector = getGitLabConnector();
      const issue = await connector.getIssue(
        params.projectId as string | number,
        params.issueIid as number,
      );
      return JSON.stringify({ ...issue });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// gitlab.list_merge_requests
// ============================================================================

registerTool({
  id: "gitlab.list_merge_requests",
  namespace: "gitlab",
  description:
    "List GitLab merge requests. Pass projectId to scope to a project, or omit for cross-project queries.",
  paramsSchema: {
    type: "object",
    properties: {
      projectId: {
        type: ["string", "number"],
        description: "GitLab project id or URL-encoded path.",
      },
      state: {
        type: "string",
        enum: ["opened", "closed", "merged", "all"],
        description: "Filter by state. Default: GitLab returns 'opened'.",
      },
      scope: {
        type: "string",
        enum: ["created_by_me", "assigned_to_me", "all"],
        description:
          "Cross-project scope when projectId is omitted. Default: 'created_by_me'.",
      },
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      items: { type: "array", items: { type: "object" } },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getGitLabConnector } = await import("../../connectors/gitlab.js");
    const limit = typeof params.max === "number" ? params.max : 50;
    try {
      const connector = getGitLabConnector();
      const mrs = await connector.listMergeRequests({
        projectId: params.projectId as string | number | undefined,
        state: params.state as
          | "opened"
          | "closed"
          | "merged"
          | "all"
          | undefined,
        scope: params.scope as
          | "created_by_me"
          | "assigned_to_me"
          | "all"
          | undefined,
        limit,
      });
      return JSON.stringify({ count: mrs.length, items: mrs });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        items: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
