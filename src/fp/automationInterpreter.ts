/**
 * automationInterpreter — recursive interpreter for the AutomationProgram DSL.
 *
 * Single entry point: executeAutomationPolicy(programs, ctx)
 */

import crypto from "node:crypto";
import { minimatch } from "minimatch";
import type {
  AutomationProgram,
  HookType,
  WhenCondition,
} from "./automationProgram.js";
import type { AutomationState } from "./automationState.js";
import {
  clearPendingRetry,
  isDeduped,
  isOnCooldown,
  recordDedup,
  recordPendingRetry,
  recordTrigger,
  tasksInLastHour,
} from "./automationState.js";
import {
  buildHookMetadata,
  truncatePrompt,
  untrustedBlock,
} from "./automationUtils.js";
import type {
  InterpreterContext,
  InterpreterResult,
} from "./interpreterContext.js";
import { err, ok, type ToolResult } from "./result.js";

// ── Accumulator ───────────────────────────────────────────────────────────────

interface Acc {
  taskIds: string[];
  skipped: Array<{ reason: string; hook: string }>;
  errors: Array<{ message: string; hook: string }>;
  state: AutomationState;
}

function emptyAcc(state: AutomationState): Acc {
  return { taskIds: [], skipped: [], errors: [], state };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true if `value` matches the condition pattern.
 * Negation via "!" prefix. Missing pattern → always true.
 */
export function matchesCondition(
  pattern: string | undefined,
  value: string,
): boolean {
  if (pattern === undefined || pattern === "") return true;
  try {
    if (pattern.startsWith("!")) {
      return !minimatch(value, pattern.slice(1), { dot: true });
    }
    return minimatch(value, pattern, { dot: true });
  } catch {
    return false;
  }
}

/**
 * Severity string to number (lower = more severe).
 * error=0, warning=1, info=2, hint=3, information=2
 */
function severityToNumber(
  sev: "error" | "warning" | "info" | "hint" | "information",
): number {
  switch (sev) {
    case "error":
      return 0;
    case "warning":
      return 1;
    case "info":
    case "information":
      return 2;
    case "hint":
      return 3;
  }
}

/**
 * Evaluate a WhenCondition against current state + event data.
 * All specified fields must pass.
 */
export function evaluateWhen(
  when: WhenCondition | undefined,
  _hookType: HookType,
  state: AutomationState,
  eventData: Readonly<Record<string, string>>,
): boolean {
  if (!when) return true;

  if (when.minDiagnosticCount !== undefined) {
    const file = eventData.file ?? "";
    const entry = state.latestDiagnosticsByFile.get(file);
    const count = entry?.count ?? 0;
    if (count < when.minDiagnosticCount) return false;
  }

  if (when.diagnosticsMinSeverity !== undefined) {
    const file = eventData.file ?? "";
    const entry = state.latestDiagnosticsByFile.get(file);
    if (!entry) return false;
    const required = severityToNumber(when.diagnosticsMinSeverity);
    // entry.severity should be a number (lower = more severe); pass if at least as severe
    if (entry.severity > required) return false;
  }

  if (
    when.testRunnerLastStatus !== undefined &&
    when.testRunnerLastStatus !== "any"
  ) {
    const runner = eventData.runner ?? "";
    const outcome = state.lastTestRunnerStatusByRunner.get(runner);
    if (!outcome) return false;
    const expected = when.testRunnerLastStatus === "passed" ? "pass" : "fail";
    if (outcome !== expected) return false;
  }

  return true;
}

/**
 * Get the primary event value for condition matching.
 */
export function primaryValue(
  hookType: HookType,
  eventData: Readonly<Record<string, string>>,
): string {
  switch (hookType) {
    case "onFileSave":
    case "onFileChanged":
    case "onDiagnosticsError":
    case "onDiagnosticsCleared":
      return eventData.file ?? "";
    case "onBranchCheckout":
      return eventData.branch ?? "";
    case "onGitCommit":
      return eventData.branch ?? "";
    case "onGitPush":
      return eventData.branch ?? "";
    case "onGitPull":
      return eventData.branch ?? "";
    case "onTestRun":
    case "onTestPassAfterFailure":
      return eventData.runner ?? "";
    case "onPermissionDenied":
      return eventData.tool ?? "";
    case "onTaskCreated":
    case "onTaskSuccess":
      return eventData.taskId ?? "";
    case "onCwdChanged":
      return eventData.cwd ?? "";
    case "onDebugSessionStart":
    case "onDebugSessionEnd":
      return eventData.sessionName ?? "";
    case "onPreCompact":
    case "onPostCompact":
    case "onInstructionsLoaded":
    case "onPullRequest":
      return "";
  }
}

/**
 * Resolve a PromptSourceNode to a string (inline only; named = placeholder).
 */
export function resolvePromptSource(
  source:
    | { kind: "inline"; prompt: string }
    | {
        kind: "named";
        promptName: string;
        promptArgs?: Record<string, string>;
      },
  _eventData: Readonly<Record<string, string>>,
): string {
  if (source.kind === "inline") return source.prompt;
  return `[named:${source.promptName}]`;
}

/**
 * Build the final prompt for a hook node.
 */
function buildFinalPrompt(
  promptTemplate: string,
  hookType: HookType,
  eventData: Readonly<Record<string, string>>,
  nonce: string,
): string {
  const file = eventData.file;
  const meta = buildHookMetadata(hookType, new Date().toISOString(), file);

  // Replace placeholders with untrusted-wrapped values
  const PLACEHOLDER_KEYS: string[] = [
    "file",
    "branch",
    "runner",
    "taskId",
    "output",
    "tool",
    "reason",
    "cwd",
    "prompt",
    "hash",
    "message",
    "files",
    "count",
    "remote",
    "failed",
    "passed",
    "total",
    "failures",
    "sessionName",
    "sessionType",
    "breakpointCount",
    "activeFile",
    "previousBranch",
    "created",
    "url",
    "number",
    "title",
  ];

  let resolved = promptTemplate;
  for (const key of PLACEHOLDER_KEYS) {
    const val = eventData[key];
    if (val !== undefined && resolved.includes(`{{${key}}}`)) {
      resolved = resolved.split(`{{${key}}}`).join(
        untrustedBlock(
          key
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, " ")
            .trim(),
          val,
          nonce,
        ),
      );
    }
  }

  return truncatePrompt(meta + resolved);
}

// ── Interpreter ───────────────────────────────────────────────────────────────

async function interpret(
  program: AutomationProgram,
  ctx: InterpreterContext,
  acc: Acc,
): Promise<Acc> {
  switch (program._tag) {
    case "Hook": {
      if (!program.enabled) {
        return {
          ...acc,
          skipped: [
            ...acc.skipped,
            { reason: "disabled", hook: program.hookType },
          ],
        };
      }

      const primary = primaryValue(program.hookType, ctx.eventData);
      if (!matchesCondition(program.condition, primary)) {
        return {
          ...acc,
          skipped: [
            ...acc.skipped,
            { reason: "condition_mismatch", hook: program.hookType },
          ],
        };
      }

      if (
        !evaluateWhen(program.when, program.hookType, acc.state, ctx.eventData)
      ) {
        return {
          ...acc,
          skipped: [
            ...acc.skipped,
            { reason: "when_condition", hook: program.hookType },
          ],
        };
      }

      const promptTemplate = resolvePromptSource(
        program.promptSource,
        ctx.eventData,
      );
      const nonce = crypto.randomBytes(8).toString("hex");
      const finalPrompt = buildFinalPrompt(
        promptTemplate,
        program.hookType,
        ctx.eventData,
        nonce,
      );

      try {
        const taskId = await ctx.backend.enqueueTask({
          prompt: finalPrompt,
          triggerSource: program.hookType,
          sessionId: "",
          isAutomationTask: true,
          model: program.model,
          effort: program.effort,
          systemPrompt: program.systemPrompt,
        });
        const newState = recordTrigger(
          acc.state,
          program.hookType,
          taskId,
          ctx.now,
        );
        return {
          ...acc,
          taskIds: [...acc.taskIds, taskId],
          state: newState,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        ctx.log(
          `[interpreter] hook ${program.hookType} enqueue failed: ${message}`,
        );
        return {
          ...acc,
          errors: [...acc.errors, { message, hook: program.hookType }],
        };
      }
    }

    case "Sequence": {
      let current = acc;
      for (const p of program.programs) {
        current = await interpret(p, ctx, current);
      }
      return current;
    }

    case "Parallel": {
      const initialState = acc.state;
      const results = await Promise.allSettled(
        program.programs.map((p) =>
          interpret(p, { ...ctx, state: initialState }, emptyAcc(initialState)),
        ),
      );

      let merged = acc;
      for (const result of results) {
        if (result.status === "fulfilled") {
          merged = {
            taskIds: [...merged.taskIds, ...result.value.taskIds],
            skipped: [...merged.skipped, ...result.value.skipped],
            errors: [...merged.errors, ...result.value.errors],
            state:
              result.value.taskIds.length > 0
                ? result.value.state
                : merged.state,
          };
        } else {
          merged = {
            ...merged,
            errors: [
              ...merged.errors,
              { message: String(result.reason), hook: "parallel" },
            ],
          };
        }
      }
      return merged;
    }

    case "WithCooldown": {
      if (isOnCooldown(acc.state, program.key, ctx.now, program.cooldownMs)) {
        const hookLabel =
          program.program._tag === "Hook"
            ? program.program.hookType
            : program.key;
        return {
          ...acc,
          skipped: [
            ...acc.skipped,
            { reason: `cooldown:${program.key}`, hook: hookLabel },
          ],
        };
      }

      const innerAcc = await interpret(program.program, ctx, acc);

      // If we produced new task IDs, record the cooldown trigger
      const newTaskIds = innerAcc.taskIds.slice(acc.taskIds.length);
      if (newTaskIds.length > 0) {
        const lastTaskId = newTaskIds[newTaskIds.length - 1] ?? "";
        const newState = recordTrigger(
          innerAcc.state,
          program.key,
          lastTaskId,
          ctx.now,
        );
        return { ...innerAcc, state: newState };
      }

      return innerAcc;
    }

    case "WithDedup": {
      const sig = ctx.eventData.diagnosticSig ?? ctx.eventData.file ?? "";
      const dedupKey = `dedup:${program.key}:${sig}`;

      if (isDeduped(acc.state, dedupKey, ctx.now, program.cooldownMs)) {
        const hookLabel =
          program.program._tag === "Hook"
            ? program.program.hookType
            : program.key;
        return {
          ...acc,
          skipped: [
            ...acc.skipped,
            { reason: `dedup:${program.key}`, hook: hookLabel },
          ],
        };
      }

      const innerAcc = await interpret(program.program, ctx, acc);

      const newTaskIds = innerAcc.taskIds.slice(acc.taskIds.length);
      if (newTaskIds.length > 0) {
        const newState = recordDedup(innerAcc.state, dedupKey, ctx.now);
        return { ...innerAcc, state: newState };
      }

      return innerAcc;
    }

    case "WithRateLimit": {
      if (tasksInLastHour(acc.state, ctx.now) >= program.maxPerHour) {
        const hookLabel =
          program.program._tag === "Hook"
            ? program.program.hookType
            : "rate_limited";
        return {
          ...acc,
          skipped: [...acc.skipped, { reason: "rate_limit", hook: hookLabel }],
        };
      }

      return interpret(program.program, ctx, acc);
    }

    case "WithRetry": {
      const innerAcc = await interpret(program.program, ctx, acc);

      const newTaskIds = innerAcc.taskIds.slice(acc.taskIds.length);
      if (newTaskIds.length > 0) {
        // Success — clear any pending retry record
        const newState = clearPendingRetry(innerAcc.state, program.key);
        return { ...innerAcc, state: newState };
      }

      // Inner produced no tasks AND has errors — consider retry
      if (innerAcc.errors.length > acc.errors.length) {
        const existing = innerAcc.state.pendingRetries.get(program.key);
        const attempt = existing ? existing.attempt : 0;

        if (attempt < program.maxRetries) {
          const nextAttempt = attempt + 1;
          const nextRetryAt = ctx.now + program.retryDelayMs;

          // Schedule retry (backend records it; in tests no actual timer fires)
          ctx.backend.scheduleRetry(program.key, program.retryDelayMs, () => {
            ctx.log(
              `[interpreter] retry attempt ${nextAttempt} for ${program.key}`,
            );
          });

          const newState = recordPendingRetry(
            innerAcc.state,
            program.key,
            nextAttempt,
            nextRetryAt,
            "",
          );
          return { ...innerAcc, state: newState };
        }
      }

      return innerAcc;
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function executeAutomationPolicy(
  programs: AutomationProgram[],
  ctx: InterpreterContext,
): Promise<ToolResult<InterpreterResult>> {
  try {
    let acc = emptyAcc(ctx.state);
    for (const p of programs) {
      acc = await interpret(p, ctx, acc);
    }
    return ok({
      taskIds: acc.taskIds,
      skipped: acc.skipped,
      errors: acc.errors,
      updatedState: acc.state,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err("unknown", `Interpreter error: ${message}`);
  }
}
