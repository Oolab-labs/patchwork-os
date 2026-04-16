/**
 * policyParser — converts a validated AutomationPolicy object into an
 * AutomationProgram[] (the functional DSL).
 *
 * Pure function — no I/O, no Date.now().
 */
import type { AutomationPolicy, PromptSource } from "../automation.js";
import {
  type AutomationProgram,
  type HookExtras,
  type HookNode,
  type HookType,
  hook,
  type PromptSourceNode,
  type WhenCondition,
  withCooldown,
  withDedup,
  withRateLimit,
  withRetry,
} from "./automationProgram.js";
import { err, ok, type ToolResult } from "./result.js";

// ── Cooldown key per hook type ────────────────────────────────────────────────

function cooldownKey(hookType: HookType, condition?: string): string {
  switch (hookType) {
    case "onFileSave":
      return `save:${condition ?? "*"}`;
    case "onFileChanged":
      return `change:${condition ?? "*"}`;
    case "onDiagnosticsError":
      return `diagnostics:${condition ?? "*"}`;
    case "onDiagnosticsCleared":
      return `cleared:${condition ?? "*"}`;
    case "onGitCommit":
      return "gitcommit";
    case "onGitPush":
      return "gitpush";
    case "onGitPull":
      return "gitpull";
    case "onBranchCheckout":
      return "checkout";
    case "onPullRequest":
      return "pr";
    case "onTestRun":
      return "testrun";
    case "onTestPassAfterFailure":
      return "testpass";
    case "onTaskCreated":
      return "taskcreated";
    case "onTaskSuccess":
      return "tasksuccess";
    case "onPermissionDenied":
      return "permdenied";
    case "onCwdChanged":
      return "cwdchanged";
    case "onPreCompact":
      return "precompact";
    case "onPostCompact":
      return "postcompact";
    case "onInstructionsLoaded":
      return "instructions";
    case "onDebugSessionStart":
      return "debugstart";
    case "onDebugSessionEnd":
      return "debugend";
  }
}

// ── PromptSource → PromptSourceNode ──────────────────────────────────────────

function buildPromptSource(src: PromptSource): ToolResult<PromptSourceNode> {
  if (src.prompt !== undefined) {
    return ok({ kind: "inline" as const, prompt: src.prompt });
  }
  if (src.promptName !== undefined) {
    return ok({
      kind: "named" as const,
      promptName: src.promptName,
      promptArgs: src.promptArgs,
    });
  }
  return err(
    "invalid_arg",
    "Hook must specify either `prompt` or `promptName`",
  );
}

// ── WhenCondition mapping ─────────────────────────────────────────────────────

function buildWhen(src: PromptSource): WhenCondition | undefined {
  if (!src.when) return undefined;
  const w = src.when;
  const parts: Record<string, unknown> = {};
  if (w.minDiagnosticCount !== undefined)
    parts.minDiagnosticCount = w.minDiagnosticCount;
  if (w.diagnosticsMinSeverity !== undefined)
    parts.diagnosticsMinSeverity = w.diagnosticsMinSeverity;
  if (w.testRunnerLastStatus !== undefined)
    parts.testRunnerLastStatus = w.testRunnerLastStatus;
  return Object.keys(parts).length > 0
    ? (parts as unknown as WhenCondition)
    : undefined;
}

// ── Hook builder ──────────────────────────────────────────────────────────────

function buildHook(
  hookType: HookType,
  src: PromptSource,
  enabled: boolean,
  cooldownMs: number,
  condition: string | undefined,
  patterns: string[] | undefined,
  extras: HookExtras | undefined,
  model: string | undefined,
  effort: "low" | "medium" | "high" | "max" | undefined,
  systemPrompt: string | undefined,
): ToolResult<AutomationProgram> {
  const promptSourceResult = buildPromptSource(src);
  if (!promptSourceResult.ok) return promptSourceResult;

  const hookNode: HookNode = hook({
    hookType,
    enabled,
    condition,
    patterns,
    when: buildWhen(src),
    promptSource: promptSourceResult.value,
    model,
    effort,
    systemPrompt,
    extras,
  });

  const key = cooldownKey(hookType, condition);
  let program: AutomationProgram = withCooldown(key, cooldownMs, hookNode);

  // Wrap WithRetry around WithCooldown if retryCount > 0
  const retryCount = src.retryCount ?? 0;
  if (retryCount > 0) {
    const retryDelayMs = Math.max(5_000, src.retryDelayMs ?? 30_000);
    program = withRetry(key, retryCount, retryDelayMs, program);
  }

  // Wrap WithDedup for diagnostics error with dedupeByContent
  if (
    hookType === "onDiagnosticsError" &&
    extras?.kind === "diagnosticsError" &&
    extras.dedupeByContent
  ) {
    const dedupCooldown = Math.max(
      5_000,
      extras.dedupeContentCooldownMs ?? 900_000,
    );
    program = withDedup(`dedup:${key}`, dedupCooldown, program);
  }

  return ok(program);
}

// ── Main parser ───────────────────────────────────────────────────────────────

/**
 * Parse an already-validated AutomationPolicy into an AutomationProgram[].
 *
 * Returns ok([]) for an empty policy.
 * Returns err("invalid_arg", ...) if any hook is misconfigured.
 */
export function parsePolicy(
  policy: AutomationPolicy,
): ToolResult<AutomationProgram[]> {
  const programs: AutomationProgram[] = [];

  const defaultModel = policy.defaultModel;
  const defaultEffort = policy.defaultEffort;
  const defaultSystemPrompt = policy.automationSystemPrompt;

  // Helper to push a hook or return early on error
  function push(result: ToolResult<AutomationProgram>): boolean {
    if (!result.ok) return false;
    programs.push(result.value);
    return true;
  }

  // onDiagnosticsError
  if (policy.onDiagnosticsError?.enabled) {
    const p = policy.onDiagnosticsError;
    const extras: HookExtras = {
      kind: "diagnosticsError",
      diagnosticTypes: p.diagnosticTypes,
      diagnosticsMinSeverity: p.minSeverity as
        | "error"
        | "warning"
        | "info"
        | "hint",
      dedupeByContent: p.dedupeByContent,
      dedupeContentCooldownMs: p.dedupeContentCooldownMs,
    };
    const result = buildHook(
      "onDiagnosticsError",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      extras,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onDiagnosticsCleared
  if (policy.onDiagnosticsCleared?.enabled) {
    const p = policy.onDiagnosticsCleared;
    const result = buildHook(
      "onDiagnosticsCleared",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onFileSave
  if (policy.onFileSave?.enabled) {
    const p = policy.onFileSave;
    const result = buildHook(
      "onFileSave",
      p,
      true,
      p.cooldownMs,
      p.condition,
      p.patterns,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onFileChanged
  if (policy.onFileChanged?.enabled) {
    const p = policy.onFileChanged;
    const result = buildHook(
      "onFileChanged",
      p,
      true,
      p.cooldownMs,
      p.condition,
      p.patterns,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onPreCompact
  if (policy.onPreCompact?.enabled) {
    const p = policy.onPreCompact;
    const result = buildHook(
      "onPreCompact",
      p,
      true,
      p.cooldownMs,
      undefined,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onPostCompact
  if (policy.onPostCompact?.enabled) {
    const p = policy.onPostCompact;
    const result = buildHook(
      "onPostCompact",
      p,
      true,
      p.cooldownMs,
      undefined,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onInstructionsLoaded
  if (policy.onInstructionsLoaded?.enabled) {
    const p = policy.onInstructionsLoaded;
    const result = buildHook(
      "onInstructionsLoaded",
      p,
      true,
      p.cooldownMs ?? 60_000,
      undefined,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onCwdChanged
  if (policy.onCwdChanged?.enabled) {
    const p = policy.onCwdChanged;
    const result = buildHook(
      "onCwdChanged",
      p,
      true,
      p.cooldownMs,
      undefined,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onTestRun
  if (policy.onTestRun?.enabled) {
    const p = policy.onTestRun;
    const extras: HookExtras = {
      kind: "testRun",
      onFailureOnly: p.onFailureOnly,
    };
    const result = buildHook(
      "onTestRun",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      extras,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onTestPassAfterFailure
  if (policy.onTestPassAfterFailure?.enabled) {
    const p = policy.onTestPassAfterFailure;
    const result = buildHook(
      "onTestPassAfterFailure",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onGitCommit
  if (policy.onGitCommit?.enabled) {
    const p = policy.onGitCommit;
    const result = buildHook(
      "onGitCommit",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onGitPush
  if (policy.onGitPush?.enabled) {
    const p = policy.onGitPush;
    const result = buildHook(
      "onGitPush",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onGitPull
  if (policy.onGitPull?.enabled) {
    const p = policy.onGitPull;
    const result = buildHook(
      "onGitPull",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onBranchCheckout
  if (policy.onBranchCheckout?.enabled) {
    const p = policy.onBranchCheckout;
    const result = buildHook(
      "onBranchCheckout",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onPullRequest
  if (policy.onPullRequest?.enabled) {
    const p = policy.onPullRequest;
    const result = buildHook(
      "onPullRequest",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onTaskCreated
  if (policy.onTaskCreated?.enabled) {
    const p = policy.onTaskCreated;
    const result = buildHook(
      "onTaskCreated",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onPermissionDenied
  if (policy.onPermissionDenied?.enabled) {
    const p = policy.onPermissionDenied;
    const result = buildHook(
      "onPermissionDenied",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onTaskSuccess
  if (policy.onTaskSuccess?.enabled) {
    const p = policy.onTaskSuccess;
    const result = buildHook(
      "onTaskSuccess",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onDebugSessionStart
  if (policy.onDebugSessionStart?.enabled) {
    const p = policy.onDebugSessionStart;
    const result = buildHook(
      "onDebugSessionStart",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // onDebugSessionEnd
  if (policy.onDebugSessionEnd?.enabled) {
    const p = policy.onDebugSessionEnd;
    const result = buildHook(
      "onDebugSessionEnd",
      p,
      true,
      p.cooldownMs,
      p.condition,
      undefined,
      undefined,
      p.model ?? defaultModel,
      p.effort ?? defaultEffort,
      defaultSystemPrompt,
    );
    if (!result.ok) return result;
    push(result);
  }

  // Wrap entire array in WithRateLimit if maxTasksPerHour > 0
  if (programs.length === 0) return ok([]);

  const maxPerHour = policy.maxTasksPerHour ?? 0;
  if (maxPerHour > 0) {
    // Wrap each program individually so each fires through the shared rate limiter
    const wrapped = programs.map((p) => withRateLimit(maxPerHour, p));
    return ok(wrapped);
  }

  return ok(programs);
}
