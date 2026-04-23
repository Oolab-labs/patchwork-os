/**
 * automationInterpreter — recursive interpreter for the AutomationProgram DSL.
 *
 * Single entry point: executeAutomationPolicy(programs, ctx)
 */

import crypto from "node:crypto";
import { minimatch } from "minimatch";
import { getPrompt } from "../prompts.js";
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
  mergeAutomationStates,
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
    case "onRecipeSave":
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
 * Resolve a PromptSourceNode to a string.
 * For named prompts, calls getPrompt() and concatenates user messages.
 * Returns null if a named prompt cannot be resolved (unknown name / missing args).
 */
export function resolvePromptSource(
  source:
    | { kind: "inline"; prompt: string }
    | {
        kind: "named";
        promptName: string;
        promptArgs?: Record<string, string>;
      },
  eventData: Readonly<Record<string, string>>,
): string | null {
  if (source.kind === "inline") return source.prompt;
  // Substitute event placeholders into promptArgs values
  const resolvedArgs: Record<string, string> = {};
  for (const [k, v] of Object.entries(source.promptArgs ?? {})) {
    resolvedArgs[k] = v.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
      const raw = eventData[key] ?? "";
      return raw.replace(/[\x00-\x1F\x7F]/g, "").slice(0, 500);
    });
  }
  const result = getPrompt(source.promptName, resolvedArgs);
  if (!result) return null;
  const text = result.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.text)
    .join("\n\n");
  return truncatePrompt(text);
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
    "diagnostics",
  ];

  // Keys that carry pre-formatted multi-line output — higher truncation limit
  const MULTI_LINE_KEYS = new Set([
    "diagnostics",
    "failures",
    "files",
    "output",
  ]);

  let resolved = promptTemplate;
  for (const key of PLACEHOLDER_KEYS) {
    const val = eventData[key];
    if (val !== undefined && resolved.includes(`{{${key}}}`)) {
      // Truncate user-controlled values at 500 chars (10 000 for structured multi-line outputs)
      const limit = MULTI_LINE_KEYS.has(key) ? 10_000 : 500;
      const truncatedVal = val.replace(/[\x00-\x1F\x7F]/g, "").slice(0, limit);
      resolved = resolved.split(`{{${key}}}`).join(
        untrustedBlock(
          key
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, " ")
            .trim(),
          truncatedVal,
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

      // patterns[] check (onFileSave / onFileChanged): file must match at least one glob
      if (program.patterns && program.patterns.length > 0) {
        const matchesAny = program.patterns.some((pat) =>
          matchesCondition(pat, primary),
        );
        if (!matchesAny) {
          return {
            ...acc,
            skipped: [
              ...acc.skipped,
              { reason: "pattern_mismatch", hook: program.hookType },
            ],
          };
        }
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

      // onDiagnosticsError: diagnosticTypes filter — skip when no matching source/code
      if (
        program.extras?.kind === "diagnosticsError" &&
        program.extras.diagnosticTypes &&
        program.extras.diagnosticTypes.length > 0
      ) {
        const sources = (ctx.eventData.diagnosticSources ?? "")
          .split(",")
          .filter(Boolean);
        const allowed = program.extras.diagnosticTypes.map((t) =>
          t.toLowerCase(),
        );
        const hasMatch = sources.some((s) => allowed.includes(s));
        if (!hasMatch) {
          return {
            ...acc,
            skipped: [
              ...acc.skipped,
              { reason: "diagnosticTypes", hook: program.hookType },
            ],
          };
        }
      }

      // onTestRun: extras.onFailureOnly — skip when there are no failures
      if (
        program.extras?.kind === "testRun" &&
        program.extras.onFailureOnly === true
      ) {
        const failedCount = parseInt(ctx.eventData.failed ?? "0", 10);
        if (failedCount === 0) {
          return {
            ...acc,
            skipped: [
              ...acc.skipped,
              { reason: "onFailureOnly", hook: program.hookType },
            ],
          };
        }
      }

      // onTestRun: minDuration — skip when test run was shorter than threshold
      if (
        program.extras?.kind === "testRun" &&
        (program.extras as { minDuration?: number }).minDuration !== undefined
      ) {
        const durationMs = parseFloat(ctx.eventData.durationMs ?? "");
        const minDuration = (program.extras as { minDuration?: number })
          .minDuration!;
        if (!Number.isNaN(durationMs) && durationMs < minDuration) {
          return {
            ...acc,
            skipped: [
              ...acc.skipped,
              { reason: "minDuration", hook: program.hookType },
            ],
          };
        }
      }

      const promptTemplate = resolvePromptSource(
        program.promptSource,
        ctx.eventData,
      );
      if (promptTemplate === null) {
        // Named prompt could not be resolved — skip silently (unknown prompt / missing args)
        return {
          ...acc,
          skipped: [
            ...acc.skipped,
            { reason: "prompt_unresolved", hook: program.hookType },
          ],
        };
      }
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
            // Merge branch state into accumulator: keep max timestamp per key
            // and union maps so cooldowns / dedup / triggers from each branch
            // are preserved (prior code overwrote via last-wins).
            state: mergeAutomationStates(merged.state, result.value.state),
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

          // Schedule retry: re-invoke the wrapped program when the timer
          // fires. State is a snapshot of when the retry was scheduled; for
          // typical retryDelayMs (seconds) drift is negligible. TestBackend
          // records the call but does not actually fire the timer.
          const wrappedProgram = program.program;
          const retrySnapshot = innerAcc.state;
          ctx.backend.scheduleRetry(program.key, program.retryDelayMs, () => {
            ctx.log(
              `[interpreter] retry attempt ${nextAttempt} for ${program.key}`,
            );
            void (async () => {
              try {
                const retryCtx: InterpreterContext = {
                  ...ctx,
                  state: retrySnapshot,
                  now: Date.now(),
                };
                await interpret(
                  wrappedProgram,
                  retryCtx,
                  emptyAcc(retrySnapshot),
                );
              } catch (e) {
                const m = e instanceof Error ? e.message : String(e);
                ctx.log(`[interpreter] retry ${program.key} failed: ${m}`);
              }
            })();
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

/** Returns the hookType of the innermost Hook node by drilling through wrappers. */
function innerHookType(p: AutomationProgram): string | undefined {
  switch (p._tag) {
    case "Hook":
      return p.hookType;
    case "WithCooldown":
    case "WithDedup":
    case "WithRateLimit":
    case "WithRetry":
      return innerHookType(p.program);
    case "Sequence":
    case "Parallel":
      // Composite — no single hookType; always include
      return undefined;
  }
}

export async function executeAutomationPolicy(
  programs: AutomationProgram[],
  ctx: InterpreterContext,
): Promise<ToolResult<InterpreterResult>> {
  try {
    let acc = emptyAcc(ctx.state);
    for (const p of programs) {
      // Filter top-level programs by eventType. Composite nodes (Sequence,
      // Parallel) have no single hookType and are always evaluated.
      if (ctx.eventType) {
        const ht = innerHookType(p);
        if (ht !== undefined && ht !== ctx.eventType) {
          continue;
        }
      }
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
