import { ToolErrorCodes } from "../errors.js";
import {
  buildQuickTaskPrompt,
  PRESET_COOLDOWN_MS,
  type PresetContext,
  QUICK_TASK_PRESET_IDS,
} from "../quickTaskPresets.js";
import { error, successStructured } from "./utils.js";

/** Bridge-global cooldown tracker shared across sidebar + CLI + MCP invocations. */
const _lastInvokedAt = new Map<string, { at: number; source: string }>();

/** Reset for tests only. */
export function _resetQuickTaskCooldown(): void {
  _lastInvokedAt.clear();
}

/** Deps: tool handler fns that launchQuickTask composes. */
export interface LaunchQuickTaskDeps {
  runTask: (args: Record<string, unknown>) => Promise<unknown>;
  resumeTask: (args: Record<string, unknown>) => Promise<unknown>;
  getHandoff: () => Promise<unknown>;
  getContext: () => Promise<unknown>;
  getDiagnostics: () => Promise<unknown>;
  getPerfReport?: () => Promise<unknown>;
  getAnalyticsReport?: () => Promise<unknown>;
  /** Monotonic clock for cooldown; test override. */
  now?: () => number;
}

/** Extract the structuredContent payload from a tool handler result. */
function unwrap<T = Record<string, unknown>>(result: unknown): T | null {
  if (
    result !== null &&
    typeof result === "object" &&
    "structuredContent" in result
  ) {
    const sc = (result as { structuredContent?: unknown }).structuredContent;
    return (sc ?? null) as T | null;
  }
  // Fallback: parse content[0].text
  if (
    result !== null &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as { content: unknown[] }).content)
  ) {
    const c = (result as { content: Array<{ text?: string }> }).content[0];
    if (c?.text) {
      try {
        return JSON.parse(c.text) as T;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function createLaunchQuickTaskTool(deps: LaunchQuickTaskDeps) {
  const now = deps.now ?? Date.now;

  return {
    schema: {
      name: "launchQuickTask",
      description:
        "Launch context-aware Claude task from named preset. Same dispatch path as sidebar + CLI. 5s cooldown per preset.",
      annotations: {
        title: "Launch Quick Task",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          presetId: {
            type: "string",
            enum: [...QUICK_TASK_PRESET_IDS],
            description: "Preset id. Must be one of the enum values.",
          },
          source: {
            type: "string",
            enum: ["cli", "sidebar", "mcp", "dashboard"],
            description: "Caller source for cooldown telemetry. Default: mcp.",
          },
        },
        required: ["presetId"],
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          taskId: { type: "string" },
          presetId: { type: "string" },
          status: { type: "string" },
          resumed: { type: "boolean" },
          startedAt: { type: "number" },
        },
        required: ["taskId", "presetId", "status", "startedAt"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const presetId = args.presetId;
      if (
        typeof presetId !== "string" ||
        !(QUICK_TASK_PRESET_IDS as readonly string[]).includes(presetId)
      ) {
        return error(
          `presetId must be one of: ${QUICK_TASK_PRESET_IDS.join(", ")}`,
          ToolErrorCodes.INVALID_ARGS,
        );
      }
      const source = typeof args.source === "string" ? args.source : "mcp";

      // Cooldown check — bridge-global, shared across invokers.
      const last = _lastInvokedAt.get(presetId);
      const t = now();
      if (last && t - last.at < PRESET_COOLDOWN_MS) {
        const remainingMs = PRESET_COOLDOWN_MS - (t - last.at);
        return error(
          `Preset "${presetId}" on cooldown — triggered ${Math.round((t - last.at) / 1000)}s ago via ${last.source}. Retry in ${Math.ceil(remainingMs / 1000)}s.`,
          ToolErrorCodes.COOLDOWN_ACTIVE,
        );
      }

      // Gather context via existing tool handlers (in-process, no HTTP).
      const ctx: PresetContext = {};
      try {
        const ctxResult = unwrap<{
          brief?: PresetContext["brief"];
          activeFile?: string;
          recentCommits?: Array<{ message: string }>;
        }>(await deps.getContext());
        if (ctxResult) {
          ctx.activeFile = ctxResult.activeFile;
          ctx.brief = ctxResult.brief;
          ctx.recentCommits = ctxResult.recentCommits;
        }
      } catch {
        // non-fatal
      }
      try {
        const diagResult = unwrap<PresetContext["diagnostics"]>(
          await deps.getDiagnostics(),
        );
        ctx.diagnostics = diagResult ?? null;
      } catch {
        ctx.diagnostics = null;
      }
      if (deps.getPerfReport) {
        try {
          ctx.perfReport = unwrap<PresetContext["perfReport"]>(
            await deps.getPerfReport(),
          );
        } catch {
          ctx.perfReport = null;
        }
      }
      if (deps.getAnalyticsReport) {
        try {
          ctx.report = unwrap<PresetContext["report"]>(
            await deps.getAnalyticsReport(),
          );
        } catch {
          ctx.report = null;
        }
      }

      const built = buildQuickTaskPrompt(presetId, ctx);
      if (!built) {
        return error(
          `Unknown preset "${presetId}"`,
          ToolErrorCodes.INVALID_ARGS,
        );
      }

      // Mark cooldown BEFORE dispatch — reserves the slot even if downstream fails.
      _lastInvokedAt.set(presetId, { at: t, source });

      if (built.resumeTaskId) {
        const resumeResult = unwrap<{
          newTaskId?: string;
          status?: string;
        }>(await deps.resumeTask({ taskId: built.resumeTaskId }));
        return successStructured({
          taskId: resumeResult?.newTaskId ?? "unknown",
          presetId,
          status: resumeResult?.status ?? "pending",
          resumed: true,
          startedAt: t,
        });
      }

      // Build prompt with handoff context if present
      let prompt = built.prompt;
      try {
        const handoff = unwrap<{ note?: string }>(await deps.getHandoff());
        const note = handoff?.note;
        if (note && typeof note === "string" && note.trim()) {
          const isAutoSnap = note.trimStart().startsWith("[auto-snapshot");
          if (!isAutoSnap) {
            prompt = `${prompt}\n\nPrior context:\n${note.slice(0, 400)}`;
          }
        }
      } catch {
        // non-fatal
      }

      const runResult = unwrap<{ taskId?: string; status?: string }>(
        await deps.runTask({ prompt }),
      );
      if (!runResult?.taskId) {
        return error("runClaudeTask did not return a taskId");
      }
      return successStructured({
        taskId: runResult.taskId,
        presetId,
        status: runResult.status ?? "pending",
        resumed: false,
        startedAt: t,
      });
    },
  };
}
