import type { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import { ToolErrorCodes } from "../errors.js";
import { error, success } from "./utils.js";

export function createResumeClaudeTaskTool(
  orchestrator: ClaudeOrchestrator,
  sessionId: string,
) {
  return {
    schema: {
      name: "resumeClaudeTask",
      description:
        "Resume a previously failed, cancelled, or completed Claude task by re-running it with the same prompt. Returns a new task ID.",
      annotations: {
        title: "Resume Claude Task",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description:
              "The ID of the task to resume (must be in done, error, or cancelled state).",
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

      const original = orchestrator.getTask(taskId);
      if (!original) {
        return error(
          `Task "${taskId}" not found`,
          ToolErrorCodes.TASK_NOT_FOUND,
        );
      }

      // Authorization: sessions may only resume their own tasks
      if (original.sessionId !== sessionId) {
        return error(
          `Task "${taskId}" not found`,
          ToolErrorCodes.TASK_NOT_FOUND,
        );
      }

      if (original.status === "running" || original.status === "pending") {
        return error(
          `Task "${taskId}" is still ${original.status} — cannot resume a task that has not yet reached a terminal state`,
          ToolErrorCodes.INVALID_ARGS,
        );
      }

      try {
        const newTaskId = orchestrator.enqueue({
          prompt: original.prompt,
          contextFiles: original.contextFiles,
          timeoutMs: original.timeoutMs,
          sessionId,
          model: original.model,
        });
        return success({
          newTaskId,
          originalTaskId: taskId,
          prompt: original.prompt,
          status: "pending",
        });
      } catch (e) {
        return error(
          `Failed to enqueue resumed task: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}
