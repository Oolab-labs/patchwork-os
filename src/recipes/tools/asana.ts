/**
 * Asana tools — read-only wrappers for workspaces, projects, tasks, user.
 *
 * Self-registering tool module for the recipe tool registry. Read-only this PR;
 * write methods (createTask, updateTask) are deferred.
 *
 * Each tool wraps connector throws into the `{count, items, error}` shape that
 * the runner's silent-fail detector (PR #75) catches as a step error rather
 * than a silent empty list.
 *
 * Note: Asana's only OAuth scope (`default`) grants read+write combined — there
 * is no read-only-only scope. Defense lives here at the recipe-tool layer where
 * every tool declares `isWrite: false`.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// asana.get_current_user
// ============================================================================

registerTool({
  id: "asana.get_current_user",
  namespace: "asana",
  description: "Fetch the authenticated Asana user (gid, name, email).",
  paramsSchema: {
    type: "object",
    properties: {
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
  execute: async () => {
    const { getAsanaConnector } = await import("../../connectors/asana.js");
    try {
      const connector = getAsanaConnector();
      const user = await connector.getCurrentUser();
      return JSON.stringify({ count: 1, items: [user] });
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
// asana.list_workspaces
// ============================================================================

registerTool({
  id: "asana.list_workspaces",
  namespace: "asana",
  description: "List Asana workspaces the authenticated user belongs to.",
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
    const { getAsanaConnector } = await import("../../connectors/asana.js");
    const limit = typeof params.max === "number" ? params.max : 50;
    try {
      const connector = getAsanaConnector();
      const workspaces = await connector.listWorkspaces({ limit });
      return JSON.stringify({ count: workspaces.length, items: workspaces });
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
// asana.list_projects
// ============================================================================

registerTool({
  id: "asana.list_projects",
  namespace: "asana",
  description: "List projects within an Asana workspace.",
  paramsSchema: {
    type: "object",
    properties: {
      workspaceGid: {
        type: "string",
        description: "Asana workspace gid",
      },
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
    required: ["workspaceGid"],
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
    const { getAsanaConnector } = await import("../../connectors/asana.js");
    const limit = typeof params.max === "number" ? params.max : 50;
    try {
      const connector = getAsanaConnector();
      const projects = await connector.listProjects({
        workspaceGid: params.workspaceGid as string,
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
// asana.list_tasks
// ============================================================================

registerTool({
  id: "asana.list_tasks",
  namespace: "asana",
  description:
    "List Asana tasks. Requires either projectGid, or assignee + workspaceGid.",
  paramsSchema: {
    type: "object",
    properties: {
      projectGid: {
        type: "string",
        description: "Asana project gid (filter by project)",
      },
      assignee: {
        type: "string",
        description: "Asana user gid or 'me' (filter by assignee)",
      },
      workspaceGid: {
        type: "string",
        description:
          "Asana workspace gid (required when filtering by assignee)",
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
    const { getAsanaConnector } = await import("../../connectors/asana.js");
    const limit = typeof params.max === "number" ? params.max : 50;
    try {
      const connector = getAsanaConnector();
      const tasks = await connector.listTasks({
        projectGid: params.projectGid as string | undefined,
        assignee: params.assignee as string | undefined,
        workspaceGid: params.workspaceGid as string | undefined,
        limit,
      });
      return JSON.stringify({ count: tasks.length, items: tasks });
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
// asana.get_task
// ============================================================================

registerTool({
  id: "asana.get_task",
  namespace: "asana",
  description: "Fetch a single Asana task by gid.",
  paramsSchema: {
    type: "object",
    properties: {
      taskGid: {
        type: "string",
        description: "Asana task gid",
      },
      into: CommonSchemas.into,
    },
    required: ["taskGid"],
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
    const { getAsanaConnector } = await import("../../connectors/asana.js");
    try {
      const connector = getAsanaConnector();
      const task = await connector.getTask(params.taskGid as string);
      return JSON.stringify({ count: 1, items: [task] });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        items: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
