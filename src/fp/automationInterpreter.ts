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
  recordDedup,
  recordPendingRetry,
  recordTrigger,
  recordWebhookFired,
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

const PLACEHOLDER_KEYS: readonly string[] = [
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
const MULTI_LINE_KEYS = new Set(["diagnostics", "failures", "files", "output"]);

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
 *
 * On Windows, file paths arrive as `C:\Users\foo\src\bar.ts` while users
 * write POSIX-style globs (`src/**\/*.ts`). minimatch is strict on `/` and
 * NTFS is case-insensitive, so without normalisation onFileSave/onFileChanged
 * hooks silently never fire on Windows. Normalise backslashes to forward
 * slashes on both sides and pass `nocase` on win32.
 */
export function matchesCondition(
  pattern: string | undefined,
  value: string,
): boolean {
  if (pattern === undefined || pattern === "") return true;
  const isWin = process.platform === "win32";
  const normValue = isWin ? value.replace(/\\/g, "/") : value;
  const opts = isWin ? { dot: true, nocase: true } : { dot: true };
  try {
    if (pattern.startsWith("!")) {
      const inner = isWin
        ? pattern.slice(1).replace(/\\/g, "/")
        : pattern.slice(1);
      return !minimatch(normValue, inner, opts);
    }
    const normPattern = isWin ? pattern.replace(/\\/g, "/") : pattern;
    return minimatch(normValue, normPattern, opts);
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
 *
 * When `source.kind === "none"`, returns the symbol `NO_PROMPT` so callers
 * can distinguish "no inline prompt configured" (webhook-only hook) from
 * "named prompt failed to resolve" (skip silently).
 */
export const NO_PROMPT = Symbol("no-prompt");
export type ResolvedPrompt = string | null | typeof NO_PROMPT;

export function resolvePromptSource(
  source:
    | { kind: "inline"; prompt: string }
    | {
        kind: "named";
        promptName: string;
        promptArgs?: Record<string, string>;
      }
    | { kind: "none" },
  eventData: Readonly<Record<string, string>>,
): ResolvedPrompt {
  if (source.kind === "none") return NO_PROMPT;
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
  const parts: string[] = [];
  for (const m of result.messages) {
    if (m.role === "user") parts.push(m.content.text);
  }
  const text = parts.join("\n\n");
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

  let resolved = promptTemplate;
  for (const key of PLACEHOLDER_KEYS) {
    const val = eventData[key];
    if (val !== undefined && resolved.includes(`{{${key}}}`)) {
      // Truncate user-controlled values at 500 chars (10 000 for structured multi-line outputs)
      const limit = MULTI_LINE_KEYS.has(key) ? 10_000 : 500;
      const truncatedVal = val.replace(/[\x00-\x1F\x7F]/g, "").slice(0, limit);
      resolved = resolved.replaceAll(
        `{{${key}}}`,
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

      // When promptTemplate is a string, enqueue a Claude task. When it is
      // NO_PROMPT, the hook is webhook-only — skip the enqueue but still
      // proceed to webhook fan-out below. A webhook-only hook still records
      // a trigger in state so cooldown gating can observe its firing.
      let working = acc;
      if (promptTemplate !== NO_PROMPT) {
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
            working.state,
            program.hookType,
            taskId,
            ctx.now,
          );
          working = {
            ...working,
            taskIds: [...working.taskIds, taskId],
            state: newState,
          };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          ctx.log(
            `[interpreter] hook ${program.hookType} enqueue failed: ${message}`,
          );
          return {
            ...working,
            errors: [...working.errors, { message, hook: program.hookType }],
          };
        }
      }

      // Webhook fan-out — runs AFTER the inline prompt enqueue (if any).
      // Failures are recorded as interpreter errors and do not throw, so
      // other hooks in the same run continue to fire. Always records
      // `lastWebhookFiredAt` regardless of HTTP outcome — operators
      // debugging webhook delivery want "we attempted X" telemetry.
      if (program.webhook) {
        const phase =
          program.hookType === "onPreCompact"
            ? "pre"
            : program.hookType === "onPostCompact"
              ? "post"
              : undefined;
        const body: Record<string, unknown> = {
          hookType: program.hookType,
          timestamp: ctx.now,
          ...ctx.eventData,
        };
        if (phase) body.phase = phase;

        try {
          const result = await ctx.backend.postWebhook({
            url: program.webhook.url,
            method: program.webhook.method ?? "POST",
            headers: program.webhook.headers ?? {},
            body,
            hookKey: program.hookType,
          });
          working = {
            ...working,
            state: recordWebhookFired(working.state, program.hookType, ctx.now),
          };
          if (!result.ok) {
            const message = `webhook fan-out failed: ${result.error ?? "unknown"}${result.status !== undefined ? ` (status=${result.status})` : ""}`;
            ctx.log(`[interpreter] hook ${program.hookType} ${message}`);
            working = {
              ...working,
              errors: [...working.errors, { message, hook: program.hookType }],
            };
          }
        } catch (e) {
          // Defensive: postWebhook contract is "never rejects", but a buggy
          // backend could still throw. Log + record but do not propagate.
          const message = e instanceof Error ? e.message : String(e);
          ctx.log(
            `[interpreter] hook ${program.hookType} webhook threw: ${message}`,
          );
          working = {
            ...working,
            state: recordWebhookFired(working.state, program.hookType, ctx.now),
            errors: [
              ...working.errors,
              {
                message: `webhook fan-out threw: ${message}`,
                hook: program.hookType,
              },
            ],
          };
        }
      }

      return working;
    }

    case "Sequence": {
      let current = acc;
      for (const p of program.programs) {
        current = await interpret(p, ctx, current);
      }
      return current;
    }

    case "Parallel": {
      // Walk Parallel children sequentially, threading state forward exactly
      // like Sequence. Prior implementation used Promise.allSettled with each
      // branch seeded from the same `initialState`, which meant both branches
      // observed cooldown/dedup state BEFORE either branch had recorded its
      // trigger — so both bypassed cooldown and fired. The "merge max
      // timestamp per key" reconciliation then arbitrarily picked one
      // recorded trigger and threw the other away.
      //
      // Sequential semantics are correct: each branch reads state mutated by
      // the previous branch, so a cooldown recorded in branch A is visible
      // to branch B. The wall-clock cost is small in practice — the
      // expensive work (LLM dispatch) happens inside the orchestrator queue,
      // which is already serialized; only the synchronous predicate /
      // state-update pass changes from parallel to sequential.
      let current = acc;
      for (const p of program.programs) {
        try {
          current = await interpret(p, ctx, current);
        } catch (err) {
          current = {
            ...current,
            errors: [
              ...current.errors,
              { message: String(err), hook: "parallel" },
            ],
          };
        }
      }
      return current;
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

      // If we produced new task IDs, record the cooldown trigger.
      // For webhook-only hooks (kind: "none") no taskId is produced, but the
      // webhook firing still counts as a trigger — detected via a delta in
      // `lastWebhookFiredAt`. Without this branch, cooldowns never apply to
      // webhook-only hooks, defeating the cooldown gate the operator
      // configured.
      const newTaskIds = innerAcc.taskIds.slice(acc.taskIds.length);
      let webhookFired =
        innerAcc.state.lastWebhookFiredAt.size >
        acc.state.lastWebhookFiredAt.size;
      if (!webhookFired) {
        for (const [k, v] of innerAcc.state.lastWebhookFiredAt) {
          if ((acc.state.lastWebhookFiredAt.get(k) ?? -1) < v) {
            webhookFired = true;
            break;
          }
        }
      }
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
      if (webhookFired) {
        const newState = recordTrigger(
          innerAcc.state,
          program.key,
          "webhook",
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

          // Schedule retry: re-run the wrapped program when the timer
          // fires. The work runs INSIDE AutomationHooks' mutation lock
          // (`runRetryUnderLock`) so:
          //   1. Read of live state is atomic w.r.t. concurrent _runInterpreter
          //      calls — the retry sees their cooldown / dedup / rateLimit
          //      writes, can't clobber them.
          //   2. Write of post-retry state is atomic w.r.t. the same chain,
          //      so the retry's effects can't be lost to a concurrent run
          //      that started between scheduling and merge.
          //   3. `clearPendingRetry` is in a try/finally so the
          //      pendingRetries entry is dropped even if the inner
          //      interpret() throws (otherwise the retry leaks the entry
          //      forever).
          //
          // TestBackend records the call but does not actually fire the timer.
          // Tests that exercise retry dispatch synchronously override
          // `scheduleRetry`.
          const wrappedProgram = program.program;
          const retrySnapshot = innerAcc.state;
          const liveStateFn = ctx.getLiveState;
          const runUnderLock = ctx.runRetryUnderLock;
          ctx.backend.scheduleRetry(program.key, program.retryDelayMs, () => {
            ctx.log(
              `[interpreter] retry attempt ${nextAttempt} for ${program.key}`,
            );
            const doRetry = async (
              live: AutomationState,
            ): Promise<AutomationState> => {
              try {
                const retryCtx: InterpreterContext = {
                  ...ctx,
                  state: live,
                  now: Date.now(),
                };
                const retryResult = await interpret(
                  wrappedProgram,
                  retryCtx,
                  emptyAcc(live),
                );
                return clearPendingRetry(retryResult.state, program.key);
              } catch (e) {
                const m = e instanceof Error ? e.message : String(e);
                ctx.log(`[interpreter] retry ${program.key} failed: ${m}`);
                // Drop the pending entry even on error — leaving it would
                // make `pendingRetries.get(key)` look truthy forever.
                return clearPendingRetry(live, program.key);
              }
            };
            if (runUnderLock) {
              runUnderLock(doRetry);
            } else {
              // Fallback for tests that didn't supply a lock executor:
              // run against the snapshot (or live read if available),
              // discard result. Not atomic, but tests don't observe the
              // chain anyway.
              void (async () => {
                const seed = liveStateFn ? liveStateFn() : retrySnapshot;
                await doRetry(seed);
              })();
            }
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
