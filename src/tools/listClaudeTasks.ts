import type { ClaudeOrchestrator, TaskStatus } from "../claudeOrchestrator.js";
import { ToolErrorCodes } from "../errors.js";
import { error, successStructured } from "./utils.js";

const VALID_STATUSES = new Set<string>([
  "pending",
  "running",
  "done",
  "error",
  "cancelled",
]);

export function createListClaudeTasksTool(
  orchestrator: ClaudeOrchestrator,
  sessionId: string,
) {
  return {
    schema: {
      name: "listClaudeTasks",
      description: "List your Claude tasks, optionally filtered by status.",
      annotations: {
        title: "List Claude Tasks",
        readOnlyHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "running", "done", "error", "cancelled"],
            description: "Filter by status. Omit for all tasks.",
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          count: { type: "integer" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                taskId: { type: "string" },
                status: { type: "string" },
                createdAt: { type: "number" },
                startedAt: { type: "number" },
                doneAt: { type: "number" },
                output: { type: "string" },
                errorMessage: { type: "string" },
                timeoutMs: { type: "number" },
                origin: { type: "string", enum: ["session", "automation"] },
                triggerSource: { type: "string" },
              },
              required: ["taskId", "status", "createdAt", "origin"],
            },
          },
        },
        required: ["count", "tasks"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const statusFilter = args.status;
      if (statusFilter !== undefined) {
        if (
          typeof statusFilter !== "string" ||
          !VALID_STATUSES.has(statusFilter)
        ) {
          return error(
            `status must be one of: ${[...VALID_STATUSES].join(", ")}`,
            ToolErrorCodes.INVALID_ARGS,
          );
        }
      }

      // Return tasks belonging to this session, plus automation-spawned tasks (sessionId === "")
      const tasks = orchestrator
        .list(statusFilter as TaskStatus | undefined)
        .filter((t) => t.sessionId === sessionId || t.sessionId === "");

      return successStructured({
        count: tasks.length,
        tasks: tasks.map((t) => ({
          taskId: t.id,
          status: t.status,
          createdAt: t.createdAt,
          startedAt: t.startedAt,
          doneAt: t.doneAt,
          // Truncate output to 100 chars per task in list view
          output: t.output ? t.output.slice(0, 100) : undefined,
          errorMessage: t.errorMessage,
          timeoutMs: t.timeoutMs,
          origin: t.isAutomationTask ? "automation" : "session",
          triggerSource: t.triggerSource,
        })),
      });
    },
  };
}
