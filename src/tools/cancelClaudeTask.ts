import type { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import { ToolErrorCodes } from "../errors.js";
import { error, successStructured } from "./utils.js";

export function createCancelClaudeTaskTool(
  orchestrator: ClaudeOrchestrator,
  sessionId: string,
) {
  return {
    schema: {
      name: "cancelClaudeTask",
      description: "Cancel a pending or running Claude task.",
      annotations: {
        title: "Cancel Claude Task",
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "Task ID to cancel",
          },
        },
        required: ["taskId"],
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          cancelled: { type: "boolean" },
          taskId: { type: "string" },
        },
        required: ["cancelled", "taskId"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const taskId = args.taskId;
      if (typeof taskId !== "string" || taskId.trim() === "") {
        return error(
          "taskId must be a non-empty string",
          ToolErrorCodes.INVALID_ARGS,
        );
      }

      // Cancel auth is strict: only own session's tasks are visible.
      const resolved = orchestrator.findTaskByPrefix(
        taskId,
        (t) => t.sessionId === sessionId,
      );
      if (resolved.ambiguous) {
        return error(
          `Task ID prefix "${taskId}" is ambiguous — matches ${resolved.candidates?.length ?? 0} tasks: ${(resolved.candidates ?? []).map((c) => c.slice(0, 8)).join(", ")}. Provide a longer prefix.`,
          ToolErrorCodes.AMBIGUOUS_TASK_ID,
        );
      }
      const task = resolved.task;
      if (!task) {
        return error(
          `Task "${taskId}" not found`,
          ToolErrorCodes.TASK_NOT_FOUND,
        );
      }

      // Authorization: sessions may only cancel their own tasks
      if (task.sessionId !== sessionId) {
        return error(
          `Task "${taskId}" not found`,
          ToolErrorCodes.TASK_NOT_FOUND,
        );
      }

      const cancelled = orchestrator.cancel(task.id);
      return successStructured({ cancelled, taskId: task.id });
    },
  };
}
