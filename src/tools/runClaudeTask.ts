import type { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import { ToolErrorCodes } from "../errors.js";
import type { ProgressFn } from "../transport.js";
import { error, resolveFilePath, successStructured } from "./utils.js";

const MAX_CONTEXT_FILES = 20;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;
/** 32 KB prompt cap — prevents ARG_MAX exhaustion and queue memory abuse */
const MAX_PROMPT_BYTES = 32 * 1024;
/** 4 KB system prompt cap — matches automationSystemPrompt validation in loadPolicy() */
const MAX_SYSTEM_PROMPT_CHARS = 4096;

export function createRunClaudeTaskTool(
  orchestrator: ClaudeOrchestrator,
  sessionId: string,
  workspace: string,
) {
  return {
    schema: {
      name: "runClaudeTask",
      description:
        "Enqueue Claude subprocess task. Returns taskId for getClaudeTaskStatus, or stream=true to block.",
      annotations: {
        title: "Run Claude Task",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Prompt to send to Claude",
          },
          contextFiles: {
            type: "array",
            items: { type: "string" },
            description: `Workspace-relative or absolute paths to add as context (max ${MAX_CONTEXT_FILES}).`,
          },
          timeoutMs: {
            type: "integer",
            description: `Task timeout in ms (${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}). Default: 120000.`,
          },
          stream: {
            type: "boolean",
            description:
              "If true, block and stream output via progress notifications. If false (default), return immediately with taskId.",
          },
          model: {
            type: "string",
            description:
              'Optional model override for this task, e.g. "claude-haiku-4-5-20251001". Defaults to the Claude CLI default.',
          },
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "max"],
            description:
              "Effort level for the task. Controls thinking budget: low=minimal, medium=default, high=extended, max=maximum. Omit to use the Claude CLI default.",
          },
          fallbackModel: {
            type: "string",
            description:
              'Fallback model to use when the primary model is overloaded or unavailable. E.g. "claude-haiku-4-5-20251001".',
          },
          maxBudgetUsd: {
            type: "number",
            description:
              "Maximum spend cap in USD for this task. Passed as --max-budget-usd to the subprocess. Omit for no cap.",
          },
          startupTimeoutMs: {
            type: "integer",
            description:
              "Abort the task if no assistant output arrives within this many ms of spawn. Useful for detecting hung subprocesses early. Omit to disable.",
          },
          systemPrompt: {
            type: "string",
            maxLength: MAX_SYSTEM_PROMPT_CHARS,
            description: `Custom system prompt passed via --system-prompt to the subprocess. Replaces the default Claude Code system prompt. Max ${MAX_SYSTEM_PROMPT_CHARS} characters. Omit to use the default.`,
          },
          useAnt: {
            type: "boolean",
            description:
              "Run this task with the ant binary instead of claude. Requires ant on PATH or --ant-binary configured.",
          },
        },
        required: ["prompt"],
      },
      outputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          status: { type: "string" },
          output: { type: "string" },
        },
        required: ["taskId", "status"],
      },
    },
    handler: async (
      args: Record<string, unknown>,
      _signal?: AbortSignal,
      progressFn?: ProgressFn,
    ) => {
      const prompt = args.prompt;
      if (typeof prompt !== "string" || prompt.trim() === "") {
        return error(
          "prompt must be a non-empty string",
          ToolErrorCodes.INVALID_ARGS,
        );
      }
      if (Buffer.byteLength(prompt, "utf-8") > MAX_PROMPT_BYTES) {
        return error(
          `prompt exceeds maximum size of ${MAX_PROMPT_BYTES / 1024} KB`,
          ToolErrorCodes.INVALID_ARGS,
        );
      }

      // Validate contextFiles
      const rawFiles = args.contextFiles;
      const contextFiles: string[] = [];
      if (rawFiles !== undefined) {
        if (!Array.isArray(rawFiles)) {
          return error(
            "contextFiles must be an array",
            ToolErrorCodes.INVALID_ARGS,
          );
        }
        if (rawFiles.length > MAX_CONTEXT_FILES) {
          return error(
            `contextFiles must have at most ${MAX_CONTEXT_FILES} entries`,
            ToolErrorCodes.INVALID_ARGS,
          );
        }
        for (const f of rawFiles) {
          if (typeof f !== "string") {
            return error(
              "contextFiles entries must be strings",
              ToolErrorCodes.INVALID_ARGS,
            );
          }
          try {
            // Resolve and validate against workspace (read-only — no write: true)
            const resolved = resolveFilePath(f, workspace, { write: false });
            contextFiles.push(resolved);
          } catch (e) {
            return error(
              `Invalid contextFile "${f}": ${e instanceof Error ? e.message : String(e)}`,
              ToolErrorCodes.WORKSPACE_ESCAPE,
            );
          }
        }
      }

      // Validate timeoutMs
      let timeoutMs: number | undefined;
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

      const stream = args.stream === true;
      const model =
        typeof args.model === "string" && args.model.trim() !== ""
          ? args.model.trim()
          : undefined;

      const VALID_EFFORT = ["low", "medium", "high", "max"] as const;
      type Effort = (typeof VALID_EFFORT)[number];
      const effort: Effort | undefined =
        typeof args.effort === "string" &&
        (VALID_EFFORT as readonly string[]).includes(args.effort)
          ? (args.effort as Effort)
          : undefined;
      if (args.effort !== undefined && effort === undefined) {
        return error(
          `effort must be one of: ${VALID_EFFORT.join(", ")}`,
          ToolErrorCodes.INVALID_ARGS,
        );
      }

      const fallbackModel =
        typeof args.fallbackModel === "string" &&
        args.fallbackModel.trim() !== ""
          ? args.fallbackModel.trim()
          : undefined;

      let maxBudgetUsd: number | undefined;
      if (args.maxBudgetUsd !== undefined) {
        if (typeof args.maxBudgetUsd !== "number" || args.maxBudgetUsd <= 0) {
          return error(
            "maxBudgetUsd must be a positive number",
            ToolErrorCodes.INVALID_ARGS,
          );
        }
        maxBudgetUsd = args.maxBudgetUsd;
      }

      let startupTimeoutMs: number | undefined;
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

      const useAnt = args.useAnt === true ? true : undefined;

      let systemPrompt: string | undefined;
      if (args.systemPrompt !== undefined) {
        if (
          typeof args.systemPrompt !== "string" ||
          args.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS
        ) {
          return error(
            `systemPrompt must be a string of at most ${MAX_SYSTEM_PROMPT_CHARS} characters`,
            ToolErrorCodes.INVALID_ARGS,
          );
        }
        systemPrompt = args.systemPrompt;
      }

      if (!stream) {
        // Non-streaming: enqueue and return taskId immediately
        try {
          const taskId = orchestrator.enqueue({
            prompt,
            contextFiles,
            timeoutMs,
            sessionId,
            model,
            effort,
            fallbackModel,
            maxBudgetUsd,
            startupTimeoutMs,
            systemPrompt,
            useAnt,
          });
          return successStructured({ taskId, status: "pending" });
        } catch (e) {
          return error(
            `Failed to enqueue task: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // Streaming: block until done, send chunks via progressFn
      let chunkIndex = 0;
      try {
        const task = await orchestrator.runAndWait({
          prompt,
          contextFiles,
          timeoutMs,
          sessionId,
          model,
          effort,
          fallbackModel,
          maxBudgetUsd,
          startupTimeoutMs,
          systemPrompt,
          useAnt,
          onChunk: (chunk: string) => {
            progressFn?.(++chunkIndex, -1, chunk);
          },
        });
        return successStructured({
          taskId: task.id,
          status: task.status,
          output: task.output,
        });
      } catch (e) {
        return error(
          `Task execution failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}
