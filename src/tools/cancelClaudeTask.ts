import { ToolErrorCodes } from "../errors.js";
import type { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import { error, success } from "./utils.js";

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
            description: "The task ID to cancel.",
          },
        },
        required: ["taskId"],
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

      const task = orchestrator.getTask(taskId);
      if (!task) {
        return error(`Task "${taskId}" not found`, ToolErrorCodes.TASK_NOT_FOUND);
      }

      // Authorization: sessions may only cancel their own tasks
      if (task.sessionId !== sessionId) {
        return error(`Task "${taskId}" not found`, ToolErrorCodes.TASK_NOT_FOUND);
      }

      const cancelled = orchestrator.cancel(taskId);
      return success({ cancelled, taskId });
    },
  };
}
