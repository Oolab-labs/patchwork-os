/**
 * Asana tools — read wrappers (workspaces, projects, tasks, user) plus writes
 * (create_task, update_task, complete_task, add_task_comment).
 *
 * Self-registering tool module for the recipe tool registry. Read tools wrap
 * connector throws into the `{count, items, error}` shape that the runner's
 * silent-fail detector (PR #75) catches as a step error rather than a silent
 * empty list. Write tools use a single-object response shape (no count/items)
 * but still surface failures via an `error` field.
 *
 * Note: Asana's only OAuth scope (`default`) grants read+write combined —
 * there is no read-only-only scope. Defense lives here at the recipe-tool
 * layer: read tools declare `isWrite: false`, write tools declare
 * `isWrite: true` so the approval queue gates them appropriately.
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

// ============================================================================
// asana.create_task  (write-gated)
// ============================================================================

registerTool({
  id: "asana.create_task",
  namespace: "asana",
  description:
    "Create a new Asana task in a workspace, optionally attached to a project, assigned, due-dated, or nested under a parent task.",
  paramsSchema: {
    type: "object",
    properties: {
      workspace_gid: {
        type: "string",
        description: "Asana workspace gid (required)",
      },
      name: { type: "string", description: "Task title (required)" },
      project_gid: {
        type: "string",
        description: "Optional project gid to attach the task to",
      },
      notes: {
        type: "string",
        description: "Optional task body / notes (free-form text)",
      },
      assignee_gid: {
        type: "string",
        description: "Optional Asana user gid to assign the task to",
      },
      due_on: {
        type: "string",
        description: "Optional ISO date YYYY-MM-DD",
      },
      parent_task_gid: {
        type: "string",
        description: "Optional parent task gid (creates a subtask)",
      },
      into: CommonSchemas.into,
    },
    required: ["workspace_gid", "name"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      gid: { type: "string" },
      name: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getAsanaConnector } = await import("../../connectors/asana.js");
    try {
      const connector = getAsanaConnector();
      const task = await connector.createTask({
        workspaceGid: params.workspace_gid as string,
        name: params.name as string,
        projectGid:
          typeof params.project_gid === "string"
            ? params.project_gid
            : undefined,
        notes: typeof params.notes === "string" ? params.notes : undefined,
        assigneeGid:
          typeof params.assignee_gid === "string"
            ? params.assignee_gid
            : undefined,
        dueOn: typeof params.due_on === "string" ? params.due_on : undefined,
        parentTaskGid:
          typeof params.parent_task_gid === "string"
            ? params.parent_task_gid
            : undefined,
      });
      return JSON.stringify({ ok: true, gid: task.gid, name: task.name });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// asana.update_task  (write-gated)
// ============================================================================

registerTool({
  id: "asana.update_task",
  namespace: "asana",
  description:
    "Update fields on an Asana task. At least one of name/notes/completed/assignee_gid/due_on must be supplied.",
  paramsSchema: {
    type: "object",
    properties: {
      task_gid: { type: "string", description: "Asana task gid (required)" },
      name: { type: "string", description: "New task title" },
      notes: { type: "string", description: "New task notes / body" },
      completed: {
        type: "boolean",
        description: "Mark task completed/uncompleted",
      },
      assignee_gid: {
        type: "string",
        description: "New assignee user gid",
      },
      due_on: {
        type: "string",
        description: "ISO date YYYY-MM-DD",
      },
      into: CommonSchemas.into,
    },
    required: ["task_gid"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      gid: { type: "string" },
      name: { type: "string" },
      completed: { type: "boolean" },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getAsanaConnector } = await import("../../connectors/asana.js");
    // Defense at wrapper level — refuse when no update fields supplied so the
    // recipe author sees a clear error rather than an Asana 400.
    const updates: Record<string, unknown> = {};
    if (typeof params.name === "string") updates.name = params.name;
    if (typeof params.notes === "string") updates.notes = params.notes;
    if (typeof params.completed === "boolean") {
      updates.completed = params.completed;
    }
    if (typeof params.assignee_gid === "string") {
      updates.assigneeGid = params.assignee_gid;
    }
    if (typeof params.due_on === "string") updates.dueOn = params.due_on;

    if (Object.keys(updates).length === 0) {
      return JSON.stringify({
        ok: false,
        error:
          "update_task requires at least one of name/notes/completed/assignee_gid/due_on",
      });
    }

    try {
      const connector = getAsanaConnector();
      const task = await connector.updateTask(
        params.task_gid as string,
        updates as {
          name?: string;
          notes?: string;
          completed?: boolean;
          assigneeGid?: string;
          dueOn?: string;
        },
      );
      return JSON.stringify({
        ok: true,
        gid: task.gid,
        name: task.name,
        completed: task.completed,
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
// asana.complete_task  (write-gated)
// ============================================================================

registerTool({
  id: "asana.complete_task",
  namespace: "asana",
  description: "Mark an Asana task completed (sets completed: true).",
  paramsSchema: {
    type: "object",
    properties: {
      task_gid: { type: "string", description: "Asana task gid (required)" },
      into: CommonSchemas.into,
    },
    required: ["task_gid"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      gid: { type: "string" },
      completed: { type: "boolean" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getAsanaConnector } = await import("../../connectors/asana.js");
    try {
      const connector = getAsanaConnector();
      const task = await connector.completeTask(params.task_gid as string);
      return JSON.stringify({
        ok: true,
        gid: task.gid,
        completed: task.completed,
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
// asana.add_task_comment  (write-gated)
// ============================================================================

registerTool({
  id: "asana.add_task_comment",
  namespace: "asana",
  description: "Append a comment story to an Asana task's timeline.",
  paramsSchema: {
    type: "object",
    properties: {
      task_gid: { type: "string", description: "Asana task gid (required)" },
      text: {
        type: "string",
        description: "Comment text (non-empty, plain text)",
        minLength: 1,
      },
      into: CommonSchemas.into,
    },
    required: ["task_gid", "text"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      gid: { type: "string" },
      text: { type: "string" },
      created_at: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getAsanaConnector } = await import("../../connectors/asana.js");
    const text = typeof params.text === "string" ? params.text : "";
    if (!text) {
      return JSON.stringify({
        ok: false,
        error: "add_task_comment requires non-empty text",
      });
    }
    try {
      const connector = getAsanaConnector();
      const story = await connector.addTaskComment(params.task_gid as string, {
        text,
      });
      return JSON.stringify({
        ok: true,
        gid: story.gid,
        text: story.text,
        created_at: story.created_at,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
