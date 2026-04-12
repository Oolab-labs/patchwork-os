import type { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import { ToolErrorCodes } from "../errors.js";
import { error, successStructured } from "./utils.js";

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
          timeoutMs: {
            type: "integer",
            description:
              "Override the timeout for the resumed task (ms, 5000–600000). Defaults to the original task's timeoutMs.",
          },
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "max"],
            description:
              "Override the effort level for the resumed task. Defaults to the original task's effort.",
          },
          fallbackModel: {
            type: "string",
            description:
              "Override the fallback model for the resumed task. Defaults to the original task's fallbackModel.",
          },
          maxBudgetUsd: {
            type: "number",
            description:
              "Override the spend cap in USD for the resumed task. Defaults to the original task's maxBudgetUsd.",
          },
          startupTimeoutMs: {
            type: "integer",
            description:
              "Override the startup timeout for the resumed task. Defaults to the original task's startupTimeoutMs.",
          },
        },
        required: ["taskId"],
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          newTaskId: { type: "string" },
          originalTaskId: { type: "string" },
          prompt: { type: "string" },
          status: { type: "string" },
        },
        required: ["newTaskId", "originalTaskId", "prompt", "status"],
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

      // Validate optional overrides
      const MIN_TIMEOUT_MS = 5_000;
      const MAX_TIMEOUT_MS = 600_000;
      let timeoutMs = original.timeoutMs;
      if (args.timeoutMs !== undefined) {
        const t = args.timeoutMs;
        if (
          typeof t !== "number" ||
          !Number.isInteger(t) ||
          t < MIN_TIMEOUT_MS ||
          t > MAX_TIMEOUT_MS
        ) {
          return error(
            `timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
            ToolErrorCodes.INVALID_ARGS,
          );
        }
        timeoutMs = t;
      }

      const VALID_EFFORT = ["low", "medium", "high", "max"] as const;
      type Effort = (typeof VALID_EFFORT)[number];
      let effort: Effort | undefined = original.effort;
      if (args.effort !== undefined) {
        if (
          typeof args.effort !== "string" ||
          !(VALID_EFFORT as readonly string[]).includes(args.effort)
        ) {
          return error(
            `effort must be one of: ${VALID_EFFORT.join(", ")}`,
            ToolErrorCodes.INVALID_ARGS,
          );
        }
        effort = args.effort as Effort;
      }

      const fallbackModel =
        args.fallbackModel !== undefined
          ? typeof args.fallbackModel === "string" &&
            args.fallbackModel.trim() !== ""
            ? args.fallbackModel.trim()
            : original.fallbackModel
          : original.fallbackModel;

      let maxBudgetUsd = original.maxBudgetUsd;
      if (args.maxBudgetUsd !== undefined) {
        if (typeof args.maxBudgetUsd !== "number" || args.maxBudgetUsd <= 0) {
          return error(
            "maxBudgetUsd must be a positive number",
            ToolErrorCodes.INVALID_ARGS,
          );
        }
        maxBudgetUsd = args.maxBudgetUsd;
      }

      let startupTimeoutMs = original.startupTimeoutMs;
      if (args.startupTimeoutMs !== undefined) {
        const s = args.startupTimeoutMs;
        if (
          typeof s !== "number" ||
          !Number.isInteger(s) ||
          s < MIN_TIMEOUT_MS ||
          s > MAX_TIMEOUT_MS
        ) {
          return error(
            `startupTimeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
            ToolErrorCodes.INVALID_ARGS,
          );
        }
        startupTimeoutMs = s;
      }

      try {
        const newTaskId = orchestrator.enqueue({
          prompt: original.prompt,
          contextFiles: original.contextFiles,
          timeoutMs,
          sessionId,
          model: original.model,
          effort,
          fallbackModel,
          maxBudgetUsd,
          startupTimeoutMs,
        });
        return successStructured({
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
