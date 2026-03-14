import { ToolErrorCodes } from "../errors.js";
import type { ClaudeOrchestrator, TaskStatus } from "../claudeOrchestrator.js";
import { error, success } from "./utils.js";

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
            description: "Filter by task status. Omit to list all tasks.",
          },
        },
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

      // Only return tasks belonging to this session
      const tasks = orchestrator
        .list(statusFilter as TaskStatus | undefined)
        .filter((t) => t.sessionId === sessionId);

      return success({
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
        })),
      });
    },
  };
}
