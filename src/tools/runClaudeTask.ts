import { ToolErrorCodes } from "../errors.js";
import type { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import type { ProgressFn } from "../transport.js";
import { resolveFilePath, error, success } from "./utils.js";

const MAX_CONTEXT_FILES = 20;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;
/** 32 KB prompt cap — prevents ARG_MAX exhaustion and queue memory abuse */
const MAX_PROMPT_BYTES = 32 * 1024;

export function createRunClaudeTaskTool(
  orchestrator: ClaudeOrchestrator,
  sessionId: string,
  workspace: string,
) {
  return {
    schema: {
      name: "runClaudeTask",
      description:
        "Enqueue a task for Claude to run as a subprocess. Returns a taskId to poll with getClaudeTaskStatus, or (if stream=true) blocks until the task completes and streams output via progress notifications.",
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
            description: "The prompt to send to Claude.",
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
        },
        required: ["prompt"],
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

      if (!stream) {
        // Non-streaming: enqueue and return taskId immediately
        try {
          const taskId = orchestrator.enqueue({
            prompt,
            contextFiles,
            timeoutMs,
            sessionId,
          });
          return success({ taskId, status: "pending" });
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
          onChunk: (chunk: string) => {
            progressFn?.(++chunkIndex, -1, chunk);
          },
        });
        return success({
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
