/**
 * Jira tools — read wrappers (search/fetch/list_projects) plus writes
 * (create_issue, update_status, add_comment).
 *
 * Self-registering tool module for the recipe tool registry. Read tools wrap
 * connector throws into the `{count, items, error}` shape so the runner's
 * silent-fail detector catches connector failures as a step error rather than
 * a silent empty list. Write tools use a single-object response shape and
 * surface failures via an `error` field.
 *
 * Mirrors the asana.ts / linear.ts pattern so recipe authors get a uniform
 * surface across issue trackers.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// jira.list_issues
// ============================================================================

registerTool({
  id: "jira.list_issues",
  namespace: "jira",
  description:
    "Search Jira issues by JQL. If `project` is supplied without `jql`, scopes to that project's open issues by ORDER BY created DESC.",
  paramsSchema: {
    type: "object",
    properties: {
      jql: {
        type: "string",
        description:
          "JQL query (e.g., 'project = ENG AND status = \"In Progress\"'). Takes precedence over `project`.",
      },
      project: {
        type: "string",
        description:
          "Project key shortcut (e.g., 'ENG'). Used to build a default JQL when `jql` not supplied.",
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
    const { getJiraConnector } = await import("../../connectors/jira.js");
    const limit = typeof params.max === "number" ? params.max : 50;
    const jqlInput = typeof params.jql === "string" ? params.jql.trim() : "";
    const projectInput =
      typeof params.project === "string" ? params.project.trim() : "";
    const jql = jqlInput
      ? jqlInput
      : projectInput
        ? `project = ${projectInput} ORDER BY created DESC`
        : "ORDER BY created DESC";

    try {
      const connector = getJiraConnector();
      await connector.authenticate();
      const result = await connector.searchIssues(jql, limit);
      return JSON.stringify({
        count: result.issues.length,
        items: result.issues,
      });
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
// jira.get_issue
// ============================================================================

registerTool({
  id: "jira.get_issue",
  namespace: "jira",
  description: "Fetch a single Jira issue by ID or key (e.g., 'ENG-42').",
  paramsSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Issue ID or key (e.g., 'ENG-42')",
      },
      into: CommonSchemas.into,
    },
    required: ["key"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      key: { type: "string" },
      self: { type: "string" },
      fields: { type: "object" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getJiraConnector } = await import("../../connectors/jira.js");
    try {
      const connector = getJiraConnector();
      await connector.authenticate();
      const issue = await connector.fetchIssue(params.key as string);
      if (!issue) {
        return JSON.stringify({ error: `Jira issue not found: ${params.key}` });
      }
      return JSON.stringify(issue);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// jira.list_projects
// ============================================================================

registerTool({
  id: "jira.list_projects",
  namespace: "jira",
  description: "List Jira projects visible to the authenticated user.",
  paramsSchema: {
    type: "object",
    properties: {
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
    const { getJiraConnector } = await import("../../connectors/jira.js");
    const limit = typeof params.max === "number" ? params.max : 50;
    try {
      const connector = getJiraConnector();
      await connector.authenticate();
      const projects = await connector.listProjects();
      const sliced = projects.slice(0, limit);
      return JSON.stringify({ count: sliced.length, items: sliced });
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
// jira.create_issue  (write-gated)
// ============================================================================

registerTool({
  id: "jira.create_issue",
  namespace: "jira",
  description:
    "Create a new Jira issue in a project. Defaults issue type to 'Bug' if not supplied.",
  paramsSchema: {
    type: "object",
    properties: {
      project_key: {
        type: "string",
        description: "Jira project key (required, e.g., 'ENG')",
      },
      summary: {
        type: "string",
        description: "Issue summary / title (required)",
      },
      description: {
        type: "string",
        description: "Issue description (plain text)",
      },
      issue_type: {
        type: "string",
        description:
          "Issue type name (e.g., 'Bug', 'Task'). Defaults to 'Bug'.",
      },
      priority: {
        type: "string",
        description: "Priority name (e.g., 'High')",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Optional labels to attach",
      },
      assignee: {
        type: "string",
        description:
          "Account ID (cloud) or username (server/data-center) to assign",
      },
      into: CommonSchemas.into,
    },
    required: ["project_key", "summary"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      id: { type: "string" },
      key: { type: "string" },
      self: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getJiraConnector } = await import("../../connectors/jira.js");
    try {
      const connector = getJiraConnector();
      await connector.authenticate();
      const issue = await connector.createIssue({
        projectKey: params.project_key as string,
        summary: params.summary as string,
        description:
          typeof params.description === "string"
            ? params.description
            : undefined,
        issueType:
          typeof params.issue_type === "string" ? params.issue_type : undefined,
        priority:
          typeof params.priority === "string" ? params.priority : undefined,
        labels: Array.isArray(params.labels)
          ? (params.labels as string[])
          : undefined,
        assignee:
          typeof params.assignee === "string" ? params.assignee : undefined,
      });
      return JSON.stringify({
        ok: true,
        id: issue.id,
        key: issue.key,
        self: issue.self,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// jira.update_status  (write-gated)
// ============================================================================

registerTool({
  id: "jira.update_status",
  namespace: "jira",
  description:
    "Transition a Jira issue to a new status using a workflow transition ID.",
  paramsSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Issue ID or key (e.g., 'ENG-42')",
      },
      transition_id: {
        type: "string",
        description:
          "Workflow transition ID (lookup via /rest/api/3/issue/{key}/transitions)",
      },
      into: CommonSchemas.into,
    },
    required: ["key", "transition_id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      key: { type: "string" },
      transition_id: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getJiraConnector } = await import("../../connectors/jira.js");
    try {
      const connector = getJiraConnector();
      await connector.authenticate();
      await connector.updateStatus(
        params.key as string,
        params.transition_id as string,
      );
      return JSON.stringify({
        ok: true,
        key: params.key as string,
        transition_id: params.transition_id as string,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// jira.add_comment  (write-gated)
// ============================================================================

registerTool({
  id: "jira.add_comment",
  namespace: "jira",
  description: "Append a comment to a Jira issue.",
  paramsSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Issue ID or key (e.g., 'ENG-42')",
      },
      body: {
        type: "string",
        description: "Comment body (plain text, non-empty)",
        minLength: 1,
      },
      into: CommonSchemas.into,
    },
    required: ["key", "body"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      key: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const body = typeof params.body === "string" ? params.body : "";
    if (!body) {
      return JSON.stringify({
        ok: false,
        error: "add_comment requires non-empty body",
      });
    }
    try {
      const { getJiraConnector } = await import("../../connectors/jira.js");
      const connector = getJiraConnector();
      await connector.authenticate();
      await connector.addComment(params.key as string, body);
      return JSON.stringify({ ok: true, key: params.key as string });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
