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
          cancelReason: { type: "string" },
          createdAt: { type: "number" },
          startedAt: { type: "number" },
          doneAt: { type: "number" },
          output: { type: "string" },
          stderrTail: { type: "string" },
          wasAborted: { type: "boolean" },
          errorMessage: { type: "string" },
          timeoutMs: { type: "number" },
          startupMs: { type: "number" },
          hint: { type: "string" },
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

      // Authorization: sessions may query their own tasks, plus automation-spawned tasks (sessionId === "")
      if (task.sessionId !== sessionId && task.sessionId !== "") {
        return error(
          `Task "${taskId}" not found`,
          ToolErrorCodes.TASK_NOT_FOUND,
        );
      }

      const hint =
        task.status === "cancelled" && task.cancelReason === "startup_timeout"
          ? "Task timed out before producing any output (startup hang). Use resumeClaudeTask to retry, optionally with a longer startupTimeoutMs."
          : task.status === "cancelled" && task.cancelReason === "timeout"
            ? "Task timed out. Use resumeClaudeTask to retry with a longer timeoutMs."
            : undefined;

      return successStructured({
        taskId: task.id,
        status: task.status,
        cancelReason: task.cancelReason,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        doneAt: task.doneAt,
        // Truncate output to 500 chars in the response — full output in task.output (50KB cap)
        output: task.output ? task.output.slice(0, 500) : undefined,
        stderrTail: task.stderrTail ? task.stderrTail.slice(-500) : undefined,
        wasAborted: task.wasAborted,
        errorMessage: task.errorMessage,
        timeoutMs: task.timeoutMs,
        startupMs: task.startupMs,
        hint,
      });
    },
  };
}
