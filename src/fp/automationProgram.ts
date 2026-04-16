/**
 * AutomationProgram — discriminated union (algebraic DSL) for automation policy nodes.
 *
 * All nodes use `_tag` discriminant. All fields readonly.
 * Smart constructors at the bottom of this file.
 */

// ── Hook types ────────────────────────────────────────────────────────────────

export type HookType =
  | "onDiagnosticsError"
  | "onDiagnosticsCleared"
  | "onFileSave"
  | "onFileChanged"
  | "onCwdChanged"
  | "onPreCompact"
  | "onPostCompact"
  | "onInstructionsLoaded"
  | "onTestRun"
  | "onTestPassAfterFailure"
  | "onGitCommit"
  | "onGitPush"
  | "onGitPull"
  | "onBranchCheckout"
  | "onPullRequest"
  | "onTaskCreated"
  | "onPermissionDenied"
  | "onTaskSuccess"
  | "onDebugSessionStart"
  | "onDebugSessionEnd";

// ── Prompt source ─────────────────────────────────────────────────────────────

export type PromptSourceNode =
  | { readonly kind: "inline"; readonly prompt: string }
  | {
      readonly kind: "named";
      readonly promptName: string;
      readonly promptArgs?: Record<string, string>;
    };

// ── When condition ────────────────────────────────────────────────────────────

export interface WhenCondition {
  readonly minDiagnosticCount?: number;
  readonly diagnosticsMinSeverity?: "error" | "warning" | "info" | "hint";
  readonly testRunnerLastStatus?: "passed" | "failed" | "any";
}

// ── Hook-type-specific extras ─────────────────────────────────────────────────

export interface DiagnosticsErrorExtras {
  readonly kind: "diagnosticsError";
  readonly minDiagnosticCount?: number;
  readonly diagnosticTypes?: string[];
  readonly diagnosticsMinSeverity?: "error" | "warning" | "info" | "hint";
  readonly dedupeByContent?: boolean;
  readonly dedupeContentCooldownMs?: number;
}

export interface TestRunExtras {
  readonly kind: "testRun";
  readonly onFailureOnly?: boolean;
  readonly minDuration?: number;
}

export type HookExtras =
  | DiagnosticsErrorExtras
  | TestRunExtras
  | { readonly kind: "none" };

// ── Node types ────────────────────────────────────────────────────────────────

export interface HookNode {
  readonly _tag: "Hook";
  readonly hookType: HookType;
  readonly enabled: boolean;
  readonly condition?: string;
  readonly patterns?: string[];
  readonly when?: WhenCondition;
  readonly promptSource: PromptSourceNode;
  readonly model?: string;
  readonly effort?: "low" | "medium" | "high" | "max";
  readonly systemPrompt?: string;
  readonly extras?: HookExtras;
}

export interface SequenceNode {
  readonly _tag: "Sequence";
  readonly programs: readonly AutomationProgram[];
}

export interface ParallelNode {
  readonly _tag: "Parallel";
  readonly programs: readonly AutomationProgram[];
}

export interface WithCooldownNode {
  readonly _tag: "WithCooldown";
  readonly cooldownMs: number;
  readonly key: string;
  readonly program: AutomationProgram;
}

export interface WithDedupNode {
  readonly _tag: "WithDedup";
  readonly key: string;
  readonly cooldownMs: number;
  readonly program: AutomationProgram;
}

export interface WithRateLimitNode {
  readonly _tag: "WithRateLimit";
  readonly maxPerHour: number;
  readonly program: AutomationProgram;
}

export interface WithRetryNode {
  readonly _tag: "WithRetry";
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly key: string;
  readonly program: AutomationProgram;
}

export type AutomationProgram =
  | HookNode
  | SequenceNode
  | ParallelNode
  | WithCooldownNode
  | WithDedupNode
  | WithRateLimitNode
  | WithRetryNode;

// ── Smart constructors ────────────────────────────────────────────────────────

export function hook(fields: Omit<HookNode, "_tag">): HookNode {
  return { _tag: "Hook", ...fields };
}

export function sequence(programs: readonly AutomationProgram[]): SequenceNode {
  return { _tag: "Sequence", programs };
}

export function parallel(programs: readonly AutomationProgram[]): ParallelNode {
  return { _tag: "Parallel", programs };
}

export function withCooldown(
  key: string,
  cooldownMs: number,
  program: AutomationProgram,
): WithCooldownNode {
  return { _tag: "WithCooldown", key, cooldownMs, program };
}

export function withDedup(
  key: string,
  cooldownMs: number,
  program: AutomationProgram,
): WithDedupNode {
  return { _tag: "WithDedup", key, cooldownMs, program };
}

export function withRateLimit(
  maxPerHour: number,
  program: AutomationProgram,
): WithRateLimitNode {
  return { _tag: "WithRateLimit", maxPerHour, program };
}

export function withRetry(
  key: string,
  maxRetries: number,
  retryDelayMs: number,
  program: AutomationProgram,
): WithRetryNode {
  return { _tag: "WithRetry", key, maxRetries, retryDelayMs, program };
}
