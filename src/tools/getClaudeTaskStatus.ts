import type { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import { ToolErrorCodes } from "../errors.js";
import { error, successStructured } from "./utils.js";

export function createGetClaudeTaskStatusTool(
  orchestrator: ClaudeOrchestrator,
  sessionId: string,
) {
  return {
    schema: {
      name: "getClaudeTaskStatus",
      description:
        "Get the status and output of a Claude task enqueued with runClaudeTask.",
      annotations: {
        title: "Get Claude Task Status",
        readOnlyHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The task ID returned by runClaudeTask.",
          },
        },
        required: ["taskId"],
      },
      outputSchema: {
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
        },
        required: ["taskId", "status", "createdAt"],
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
        return error(
          `Task "${taskId}" not found`,
          ToolErrorCodes.TASK_NOT_FOUND,
        );
      }

      // Authorization: sessions may only query their own tasks
      if (task.sessionId !== sessionId) {
        return error(
          `Task "${taskId}" not found`,
          ToolErrorCodes.TASK_NOT_FOUND,
        );
      }

      return successStructured({
        taskId: task.id,
        status: task.status,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        doneAt: task.doneAt,
        // Truncate output to 500 chars in the response — full output in task.output (50KB cap)
        output: task.output ? task.output.slice(0, 500) : undefined,
        errorMessage: task.errorMessage,
        timeoutMs: task.timeoutMs,
      });
    },
  };
}
