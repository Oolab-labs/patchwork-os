/**
 * Todoist tools — list/create/close tasks and list projects via the Todoist
 * REST API v2 connector.
 *
 * Self-registering tool module for the recipe tool registry. Mirrors the
 * positional signatures of `TodoistConnector` (src/connectors/todoist.ts):
 *   - getTasks(projectId?, filter?, limit?)        → TodoistTask[]
 *   - createTask(content, projectId?, description?, dueString?, priority?, labels?) → TodoistTask
 *   - closeTask(id)                                → void
 *   - getProjects()                                → TodoistProject[]
 *
 * Read tools declare `isWrite: false`; mutating tools declare `isWrite: true`
 * so the approval queue / kill-switch gate them appropriately.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { wrapConnectorExecute } from "./wrapConnectorExecute.js";

// ============================================================================
// todoist.list_tasks
// ============================================================================

registerTool({
  id: "todoist.list_tasks",
  namespace: "todoist",
  description:
    "List active Todoist tasks, optionally filtered by project, a Todoist filter query, or a result limit.",
  paramsSchema: {
    type: "object",
    properties: {
      projectId: {
        type: "string",
        description: "Filter to tasks in this Todoist project id",
      },
      filter: {
        type: "string",
        description:
          "Todoist filter query (e.g. 'today | overdue', 'p1 & #Work')",
      },
      limit: {
        type: "number",
        description: "Max number of tasks to return",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        content: { type: "string" },
        description: { type: "string" },
        project_id: { type: "string" },
        section_id: { type: ["string", "null"] },
        parent_id: { type: ["string", "null"] },
        order: { type: "number" },
        priority: { type: "number" },
        due: { type: ["object", "null"] },
        labels: { type: "array", items: { type: "string" } },
        is_completed: { type: "boolean" },
        created_at: { type: "string" },
        url: { type: "string" },
        assignee_id: { type: ["string", "null"] },
        assigner_id: { type: ["string", "null"] },
        comment_count: { type: "number" },
        creator_id: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getTodoistConnector } = await import("../../connectors/todoist.js");
    const connector = getTodoistConnector();
    const result = await connector.getTasks(
      typeof params.projectId === "string" ? params.projectId : undefined,
      typeof params.filter === "string" ? params.filter : undefined,
      typeof params.limit === "number" ? params.limit : undefined,
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// todoist.create_task  (write-gated)
// ============================================================================

registerTool({
  id: "todoist.create_task",
  namespace: "todoist",
  description:
    "Create a new Todoist task with the given content, optionally placed in a project, described, due-dated, prioritised, or labelled.",
  paramsSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Task content / title (required)",
      },
      projectId: {
        type: "string",
        description: "Optional project id to create the task in",
      },
      description: {
        type: "string",
        description: "Optional task description / notes",
      },
      dueString: {
        type: "string",
        description:
          "Optional natural-language due date (e.g. 'tomorrow at 5pm')",
      },
      priority: {
        type: "number",
        description: "Optional priority 1 (normal) to 4 (urgent)",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of label names",
      },
      into: CommonSchemas.into,
    },
    required: ["content"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      content: { type: "string" },
      description: { type: "string" },
      project_id: { type: "string" },
      section_id: { type: ["string", "null"] },
      parent_id: { type: ["string", "null"] },
      order: { type: "number" },
      priority: { type: "number" },
      due: { type: ["object", "null"] },
      labels: { type: "array", items: { type: "string" } },
      is_completed: { type: "boolean" },
      created_at: { type: "string" },
      url: { type: "string" },
      comment_count: { type: "number" },
      creator_id: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getTodoistConnector } = await import("../../connectors/todoist.js");
    const connector = getTodoistConnector();
    const result = await connector.createTask(
      params.content as string,
      typeof params.projectId === "string" ? params.projectId : undefined,
      typeof params.description === "string" ? params.description : undefined,
      typeof params.dueString === "string" ? params.dueString : undefined,
      typeof params.priority === "number" ? params.priority : undefined,
      Array.isArray(params.labels) ? (params.labels as string[]) : undefined,
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// todoist.close_task  (write-gated)
// ============================================================================

registerTool({
  id: "todoist.close_task",
  namespace: "todoist",
  description:
    "Close (complete) a Todoist task by id. Recurring tasks advance to their next occurrence.",
  paramsSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Todoist task id to close (required)",
      },
      into: CommonSchemas.into,
    },
    required: ["id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      id: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getTodoistConnector } = await import("../../connectors/todoist.js");
    const connector = getTodoistConnector();
    const id = params.id as string;
    await connector.closeTask(id);
    // closeTask resolves to void; surface a small structured ack so the tool
    // satisfies the `string | null` execute contract and downstream
    // `{{steps.x.ok}}` references stay coherent.
    return JSON.stringify({ ok: true, id });
  }),
});

// ============================================================================
// todoist.list_projects
// ============================================================================

registerTool({
  id: "todoist.list_projects",
  namespace: "todoist",
  description: "List all Todoist projects for the authenticated account.",
  paramsSchema: {
    type: "object",
    properties: {
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        color: { type: "string" },
        parent_id: { type: ["string", "null"] },
        order: { type: "number" },
        is_favorite: { type: "boolean" },
        is_inbox_project: { type: "boolean" },
        is_team_inbox: { type: "boolean" },
        is_shared: { type: "boolean" },
        url: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async () => {
    const { getTodoistConnector } = await import("../../connectors/todoist.js");
    const connector = getTodoistConnector();
    const result = await connector.getProjects();
    return JSON.stringify(result);
  }),
});
