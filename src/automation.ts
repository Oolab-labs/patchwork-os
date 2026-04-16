import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ClaudeOrchestrator } from "./claudeOrchestrator.js";
import type { ExtensionClient } from "./extensionClient.js";
import { executeAutomationPolicy } from "./fp/automationInterpreter.js";
import type { AutomationProgram } from "./fp/automationProgram.js";
import {
  type AutomationState,
  EMPTY_AUTOMATION_STATE,
  setLatestDiagnostics,
  setTestRunnerStatus,
  tasksInLastHour,
} from "./fp/automationState.js";
import type { InterpreterContext } from "./fp/interpreterContext.js";
import { VsCodeBackend } from "./fp/interpreterContext.js";
import { parsePolicy } from "./fp/policyParser.js";

/** Maximum length (chars) of an automation policy prompt template (matches runClaudeTask cap) */
const MAX_POLICY_PROMPT_CHARS = 32_768;

/** Default system prompt for automation subprocesses when none is set in policy. */
const DEFAULT_AUTOMATION_SYSTEM_PROMPT =
  "You are a concise automation assistant. " +
  "Respond in \u22645 lines. No preamble. No markdown headers. " +
  "Call the tools listed in the task prompt, then report results only.";

// ── Policy schema ─────────────────────────────────────────────────────────────

/**
 * Shared fields for prompt resolution in any automation hook.
 * Exactly one of `prompt` or `promptName` must be provided.
 *
 * - `prompt`: inline instruction string with `{{placeholder}}` tokens.
 * - `promptName`: name of a built-in MCP prompt (e.g. `"unused-in"`, `"why-error"`).
 * - `promptArgs`: static args passed to the named prompt. Values may contain
 *   `{{placeholder}}` tokens that are substituted with sanitized event data
 *   (control chars stripped, length capped) before the prompt is resolved.
 * - `condition`: optional minimatch glob. If set, the hook only fires when the
 *   primary event value (file path, branch name, tool name, etc.) matches.
 *   Prefix with `!` to negate: `"!**\/*.test.ts"` fires for all non-test files.
 */
/**
 * Optional runtime condition checked before a hook fires.
 * All specified fields must pass for the hook to trigger.
 */
export interface AutomationCondition {
  /** Only fire if the active file's diagnostic count meets this threshold. */
  minDiagnosticCount?: number;
  /** Only fire if the active file has a diagnostic of at least this severity. */
  diagnosticsMinSeverity?: "error" | "warning";
  /** Only fire if the last test run for any runner had this outcome. */
  testRunnerLastStatus?: "passed" | "failed" | "any";
}

export interface PromptSource {
  prompt?: string;
  promptName?: string;
  promptArgs?: Record<string, string>;
  condition?: string;
  /** Optional runtime condition evaluated before the hook fires. */
  when?: AutomationCondition;
  /** Per-hook model override. Falls back to policy.defaultModel (Haiku). */
  model?: string;
  /** Per-hook effort override. Falls back to policy.defaultEffort ("low"). */
  effort?: "low" | "medium" | "high" | "max";
  /**
   * Number of times to re-enqueue on task error. Default: 0 (no retry).
   * Retries only fire when the task reaches status "error" — cancellations
   * and timeouts do not trigger a retry.
   */
  retryCount?: number;
  /**
   * Milliseconds to wait between retries. Default: 30_000.
   * Enforced minimum: 5_000.
   */
  retryDelayMs?: number;
}

export interface OnDiagnosticsErrorPolicy extends PromptSource {
  enabled: boolean;
  minSeverity: "error" | "warning";
  /**
   * Optional list of diagnostic source or code strings to match (case-insensitive).
   * If set, only diagnostics whose `source` or `code` matches any value in this
   * list will trigger the hook. Example: ["typescript", "eslint"].
   */
  diagnosticTypes?: string[];
  /** Placeholders (inline prompt only): {{file}}, {{diagnostics}} */
  /** Minimum ms between triggers for the same file. Enforced minimum: 5000. */
  cooldownMs: number;
  /**
   * When true, dedupe by (file, diagnostic-content-hash) in addition to file path.
   * Prevents re-triggering on repeated identical LSP emissions (the common "LSP
   * republishes the same error after an unrelated workspace event" thrash pattern).
   * Default: false — file-only dedupe via cooldownMs.
   */
  dedupeByContent?: boolean;
  /**
   * Cooldown (ms) for identical diagnostic content on the same file. Only used
   * when `dedupeByContent` is true. Default: 900_000 (15 minutes). Enforced minimum: 5000.
   */
  dedupeContentCooldownMs?: number;
}

export interface OnFileSavePolicy extends PromptSource {
  enabled: boolean;
  /** Minimatch glob patterns, e.g. ["**\/*.ts", "!node_modules/**"] */
  patterns: string[];
  /** Placeholders (inline prompt only): {{file}} */
  cooldownMs: number;
}

export interface OnFileChangedPolicy extends PromptSource {
  enabled: boolean;
  /** Minimatch glob patterns, e.g. ["**\/*.ts", "!node_modules/**"] */
  patterns: string[];
  /** Placeholders (inline prompt only): {{file}} */
  cooldownMs: number;
}

export interface OnPreCompactPolicy extends PromptSource {
  enabled: boolean;
  /**
   * No placeholders — fired just before Claude Code compacts the context window.
   * Use to snapshot IDE state, write a handoff note, or complete an in-flight task
   * before Claude loses context. Pairs with onPostCompact.
   */
  /** Minimum ms between triggers. Enforced minimum: 5000. */
  cooldownMs: number;
}

export interface OnPostCompactPolicy extends PromptSource {
  enabled: boolean;
  /**
   * No placeholders — fired unconditionally when compaction occurs.
   * Use promptName (e.g. "project-status") to re-snapshot IDE state.
   */
  /** Minimum ms between triggers (prevents repeated compaction storms). Enforced minimum: 5000. */
  cooldownMs: number;
}

/**
 * Unified compaction hook (v2.43.0+) — replaces `onPreCompact` and
 * `onPostCompact` with a single schema entry carrying a `phase` discriminator.
 *
 * The parser expands `onCompaction` into the internal `onPreCompact` or
 * `onPostCompact` field before downstream processing; both legacy names still
 * work but now log a deprecation warning at load time. Scheduled removal:
 * no earlier than 3 minor versions + 30 days after v2.43.0.
 */
export interface OnCompactionPolicy extends PromptSource {
  enabled: boolean;
  /** "pre" fires before Claude Code compacts context; "post" fires after. */
  phase: "pre" | "post";
  /** Minimum ms between triggers. Enforced minimum: 5000. */
  cooldownMs: number;
}

export interface OnInstructionsLoadedPolicy extends PromptSource {
  enabled: boolean;
  /**
   * No placeholders — fired once per interactive session start.
   * Use promptName (e.g. "orient-project") to inject tool capability summary.
   * cooldownMs (default 60000) prevents cascade when automation subprocesses
   * each fire their own InstructionsLoaded hook.
   */
  cooldownMs?: number;
}

export interface OnCwdChangedPolicy extends PromptSource {
  enabled: boolean;
  /**
   * Placeholders (inline prompt only): {{cwd}}
   */
  /** Minimum ms between triggers. Enforced minimum: 5000. */
  cooldownMs: number;
}

export interface OnTestRunPolicy extends PromptSource {
  enabled: boolean;
  /**
   * Unified test-run trigger (v2.43.0+) replacing `onFailureOnly` and the
   * separate `onTestPassAfterFailure` hook:
   *   - "any"             — fire after every test run
   *   - "failure"         — fire only when the run has failures (= onFailureOnly:true)
   *   - "pass-after-fail" — fire only when a runner transitions fail → pass;
   *                         routed internally to the onTestPassAfterFailure slot
   * Exactly one of `filter` or `onFailureOnly` should be set; the two are
   * mutually exclusive. If neither is set, defaults to "failure".
   */
  filter?: "any" | "failure" | "pass-after-fail";
  /**
   * @deprecated v2.43.0 — use `filter: "any"` or `filter: "failure"` instead.
   * Only trigger when there are test failures or errors.
   * Set to false to trigger after every test run regardless of outcome.
   * Default: true.
   */
  onFailureOnly?: boolean;
  /**
   * Only trigger when the test run duration meets or exceeds this threshold (ms).
   * Useful to ignore fast unit test runs and only fire on slow integration runs.
   */
  minDuration?: number;
  /**
   * Placeholders (inline prompt only): {{runner}}, {{failed}}, {{passed}}, {{total}}, {{failures}}
   */
  /** Minimum ms between triggers. Enforced minimum: 5000. */
  cooldownMs: number;
}

export interface OnTestPassAfterFailurePolicy extends PromptSource {
  enabled: boolean;
  /**
   * Fired when a test run transitions from failing → passing for the same runner.
   * Per-runner state is tracked so vitest passing after a jest failure does NOT
   * trigger — only the runner that was previously failing then passes triggers the hook.
   * Placeholders (inline prompt only): {{runner}}, {{passed}}, {{total}}
   */
  /** Minimum ms between triggers. Enforced minimum: 5000. */
  cooldownMs: number;
}

/** Minimal test run result passed to handleTestRun — avoids importing TestResult from tool files. */
export interface TestRunResult {
  runners: string[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    errored: number;
    durationMs?: number;
  };
  failures: Array<{ name: string; file: string; message: string }>;
}

export interface OnDebugSessionEndPolicy extends PromptSource {
  enabled: boolean;
  /**
   * Placeholders (inline prompt only): {{sessionName}}, {{sessionType}}
   */
  cooldownMs: number;
}

/** Minimal debug session result passed to handleDebugSessionEnd. */
export interface DebugSessionEndResult {
  sessionName: string;
  sessionType: string;
}

/**
 * Unified debug-session hook (v2.43.0+) — replaces `onDebugSessionStart`
 * and `onDebugSessionEnd`. Expanded at load time based on `phase`.
 */
export interface OnDebugSessionPolicy extends PromptSource {
  enabled: boolean;
  phase: "start" | "end";
  /** Placeholders (inline prompt only): {{sessionName}}, {{sessionType}}, plus {{breakpointCount}}/{{activeFile}} for phase: "start" */
  cooldownMs: number;
}

export interface OnDebugSessionStartPolicy extends PromptSource {
  enabled: boolean;
  /**
   * Placeholders (inline prompt only): {{sessionName}}, {{sessionType}}
   */
  cooldownMs: number;
}

/** Minimal debug session result passed to handleDebugSessionStart. */
export interface DebugSessionStartResult {
  sessionName: string;
  sessionType: string;
  /** Number of breakpoints active at session start. */
  breakpointCount: number;
  /** Active file at session start (first breakpoint file, if any). */
  activeFile: string;
}

export interface OnGitCommitPolicy extends PromptSource {
  enabled: boolean;
  /**
   * Placeholders (inline prompt only): {{hash}}, {{branch}}, {{message}}, {{files}}, {{count}}
   */
  /** Minimum ms between triggers. Enforced minimum: 5000. */
  cooldownMs: number;
}

/** Minimal commit result passed to handleGitCommit — avoids importing from gitWrite. */
export interface GitCommitResult {
  hash: string;
  branch: string;
  message: string;
  files: string[];
  count: number;
}

export interface OnGitPushPolicy extends PromptSource {
  enabled: boolean;
  /**
   * Placeholders (inline prompt only): {{remote}}, {{branch}}, {{hash}}
   */
  /** Minimum ms between triggers. Enforced minimum: 5000. */
  cooldownMs: number;
}

/** Minimal push result passed to handleGitPush — avoids importing from gitWrite. */
export interface GitPushResult {
  remote: string;
  branch: string;
  hash: string;
}

export interface OnGitPullPolicy extends PromptSource {
  enabled: boolean;
  /**
   * Placeholders (inline prompt only): {{remote}}, {{branch}}
   */
  /** Minimum ms between triggers. Enforced minimum: 5000. */
  cooldownMs: number;
}

/** Minimal pull result passed to handleGitPull — avoids importing from gitWrite. */
export interface GitPullResult {
  remote: string;
  branch: string;
  alreadyUpToDate: boolean;
}

export interface OnBranchCheckoutPolicy extends PromptSource {
  enabled: boolean;
  /**
   * Placeholders (inline prompt only): {{branch}}, {{previousBranch}}, {{created}}
   */
  /** Minimum ms between triggers. Enforced minimum: 5000. */
  cooldownMs: number;
}

/** Minimal checkout result passed to handleBranchCheckout — avoids importing from gitWrite. */
export interface BranchCheckoutResult {
  branch: string;
  previousBranch: string | null;
  created: boolean;
}

export interface OnPullRequestPolicy extends PromptSource {
  enabled: boolean;
  /**
   * Placeholders (inline prompt only): {{url}}, {{number}}, {{title}}, {{branch}}
   */
  /** Minimum ms between triggers. Enforced minimum: 5000. */
  cooldownMs: number;
}

/** Minimal PR result passed to handlePullRequest — avoids importing from github/pr. */
export interface PullRequestResult {
  url: string;
  number: number | null;
  title: string;
  branch: string;
}

export interface OnTaskCreatedPolicy extends PromptSource {
  enabled: boolean;
  /**
   * Fired by Claude Code 2.1.84+ TaskCreated hook — fires when Claude creates a subagent task.
   * Placeholders (inline prompt only): {{taskId}}, {{prompt}}
   */
  /** Minimum ms between triggers. Enforced minimum: 5000. */
  cooldownMs: number;
}

/** Minimal task-created result passed to handleTaskCreated. */
export interface TaskCreatedResult {
  taskId: string;
  prompt: string;
}

export interface OnPermissionDeniedPolicy extends PromptSource {
  enabled: boolean;
  /**
   * Fired by Claude Code 2.1.89+ PermissionDenied hook — fires when a tool call is blocked.
   * Placeholders (inline prompt only): {{tool}}, {{reason}}
   */
  /** Minimum ms between triggers. Enforced minimum: 5000. */
  cooldownMs: number;
}

/** Minimal permission-denied result passed to handlePermissionDenied. */
export interface PermissionDeniedResult {
  tool: string;
  reason: string;
}

export interface OnDiagnosticsClearedPolicy extends PromptSource {
  enabled: boolean;
  /** Placeholders (inline prompt only): {{file}} */
  cooldownMs: number;
}

/**
 * Unified diagnostics-state hook (v2.43.0+) — replaces `onDiagnosticsError`
 * and `onDiagnosticsCleared` with a single schema entry carrying a `state`
 * discriminator. Expanded at load time. Legacy names still accepted with a
 * deprecation warning. Removed no earlier than v2.46 + 30 days.
 */
export type OnDiagnosticsStateChangePolicy =
  | ({ state: "error" } & OnDiagnosticsErrorPolicy)
  | ({ state: "cleared" } & OnDiagnosticsClearedPolicy);

export interface OnTaskSuccessPolicy extends PromptSource {
  enabled: boolean;
  /** Placeholders (inline prompt only): {{taskId}}, {{output}} */
  cooldownMs: number;
}

/** Minimal task-success result passed to handleTaskSuccess. */
export interface TaskSuccessResult {
  taskId: string;
  output: string;
}

export interface AutomationPolicy {
  /**
   * Default model for all automation tasks.
   * Defaults to "claude-haiku-4-5-20251001" to minimise cost.
   * Override with "claude-sonnet-4-6" etc. for hooks that need more reasoning.
   */
  defaultModel?: string;
  /**
   * Hard cap on automation tasks spawned per hour (rolling 60-min window).
   * Defaults to 20. Set to 0 to disable.
   */
  maxTasksPerHour?: number;
  /**
   * Custom system prompt passed via --system-prompt to every automation subprocess.
   * Replaces the default Claude Code system prompt, preventing CLAUDE.md from being
   * loaded as workspace instructions. Keep it short — this is the biggest token lever.
   * Default: a lean "be brief" prompt. Max 4096 chars.
   */
  automationSystemPrompt?: string;
  /**
   * Default effort level for all automation tasks (low/medium/high/max).
   * Defaults to "low" — automation tasks rarely need deep reasoning.
   * Override per-hook via the hook's own effort field.
   */
  defaultEffort?: "low" | "medium" | "high" | "max";
  /** @deprecated v2.43.0 — use `onDiagnosticsStateChange` with `state: "error"`. */
  onDiagnosticsError?: OnDiagnosticsErrorPolicy;
  onFileSave?: OnFileSavePolicy;
  /** Fired by Claude Code 2.1.83+ FileChanged hook — reacts to any file edit, not just explicit saves. */
  onFileChanged?: OnFileChangedPolicy;
  /** Fired by Claude Code 2.1.83+ CwdChanged hook — fires when CC's working directory changes. */
  onCwdChanged?: OnCwdChangedPolicy;
  /**
   * Unified compaction hook (v2.43.0+) — replaces onPreCompact/onPostCompact.
   * Expanded at load time into the internal `onPreCompact` or `onPostCompact`
   * slot based on `phase`. Prefer this form in new policies.
   */
  onCompaction?: OnCompactionPolicy;
  /** @deprecated v2.43.0 — use `onCompaction` with `phase: "post"`. Removed no earlier than v2.46 / 30 days. */
  onPostCompact?: OnPostCompactPolicy;
  /** @deprecated v2.43.0 — use `onCompaction` with `phase: "pre"`. Removed no earlier than v2.46 / 30 days. */
  onPreCompact?: OnPreCompactPolicy;
  /** Fired by Claude Code 2.1.76+ InstructionsLoaded hook — injects bridge status at session start. */
  onInstructionsLoaded?: OnInstructionsLoadedPolicy;
  /** Fired after every runTests call. Use `filter` to target failures / pass-after-fail / all runs. */
  onTestRun?: OnTestRunPolicy;
  /** Fired when a test run transitions from failing → passing for the same runner. */
  onTestPassAfterFailure?: OnTestPassAfterFailurePolicy;
  /** Fired after every successful gitCommit call. */
  onGitCommit?: OnGitCommitPolicy;
  /** Fired after every successful gitPush call. */
  onGitPush?: OnGitPushPolicy;
  /** Fired after every successful gitPull call. */
  onGitPull?: OnGitPullPolicy;
  /** Fired after every successful gitCheckout call (branch switch or creation). */
  onBranchCheckout?: OnBranchCheckoutPolicy;
  /** Fired after every successful githubCreatePR call. */
  onPullRequest?: OnPullRequestPolicy;
  /** Fired by Claude Code 2.1.84+ TaskCreated hook — fires when Claude creates a subagent task. */
  onTaskCreated?: OnTaskCreatedPolicy;
  /** Fired by Claude Code 2.1.89+ PermissionDenied hook — fires when a tool call is blocked. */
  onPermissionDenied?: OnPermissionDeniedPolicy;
  /**
   * Unified diagnostics-state hook (v2.43.0+) — replaces onDiagnosticsError/
   * onDiagnosticsCleared. Expanded at load time based on `state`.
   */
  onDiagnosticsStateChange?: OnDiagnosticsStateChangePolicy;
  /** @deprecated v2.43.0 — use `onDiagnosticsStateChange` with `state: "cleared"`. */
  onDiagnosticsCleared?: OnDiagnosticsClearedPolicy;
  /** Fired when a Claude orchestrator task completes with status done. */
  onTaskSuccess?: OnTaskSuccessPolicy;
  /** Unified debug-session hook (v2.43.0+). Expanded to onDebugSessionStart/End based on phase. */
  onDebugSession?: OnDebugSessionPolicy;
  /** @deprecated v2.43.0 — use `onDebugSession` with `phase: "end"`. */
  onDebugSessionEnd?: OnDebugSessionEndPolicy;
  /** @deprecated v2.43.0 — use `onDebugSession` with `phase: "start"`. */
  onDebugSessionStart?: OnDebugSessionStartPolicy;
}

export interface Diagnostic {
  message: string;
  severity: "error" | "warning" | "info" | "information" | "hint";
  source?: string;
  code?: string | number;
}

/**
 * Deterministic signature over a diagnostic list — used for content-aware
 * dedupe in onDiagnosticsError. Sorting by a stable key makes the signature
 * order-independent so LSP re-emissions with the same diagnostics in a
 * different order still collide.
 */
export function diagnosticSignature(diagnostics: Diagnostic[]): string {
  const keyOf = (d: Diagnostic) =>
    `${d.severity}|${d.code ?? ""}|${(d.source ?? "").toLowerCase()}|${d.message.slice(0, 200)}`;
  const sigText = [...diagnostics].map(keyOf).sort().join("\n");
  return crypto.createHash("sha256").update(sigText).digest("hex").slice(0, 12);
}

const MIN_COOLDOWN_MS = 5_000;
/** Maximum length of a promptName value in a policy. */
const MAX_PROMPT_NAME_CHARS = 64;

// ── Policy loading ────────────────────────────────────────────────────────────

/**
 * Validates that a hook config has exactly one of `prompt` (non-empty inline string)
 * or `promptName` (reference to a built-in MCP prompt), plus optional `promptArgs`.
 * Throws a descriptive error on violation.
 */
function validatePromptSource(hookName: string, cfg: PromptSource): void {
  const hasPrompt = typeof cfg.prompt === "string" && cfg.prompt.trim() !== "";
  const hasPromptName =
    typeof cfg.promptName === "string" && cfg.promptName.trim() !== "";

  if (hasPrompt && hasPromptName) {
    throw new Error(
      `"${hookName}" must specify either "prompt" or "promptName", not both`,
    );
  }
  if (!hasPrompt && !hasPromptName) {
    throw new Error(
      `"${hookName}" must have a non-empty "prompt" or "promptName"`,
    );
  }
  if (hasPrompt && (cfg.prompt?.length ?? 0) > MAX_POLICY_PROMPT_CHARS) {
    throw new Error(
      `"${hookName}.prompt" must be ≤ ${MAX_POLICY_PROMPT_CHARS} characters`,
    );
  }
  if (hasPromptName) {
    if ((cfg.promptName?.length ?? 0) > MAX_PROMPT_NAME_CHARS) {
      throw new Error(
        `"${hookName}.promptName" must be ≤ ${MAX_PROMPT_NAME_CHARS} characters`,
      );
    }
    if (cfg.promptArgs !== undefined) {
      if (
        typeof cfg.promptArgs !== "object" ||
        cfg.promptArgs === null ||
        Array.isArray(cfg.promptArgs)
      ) {
        throw new Error(`"${hookName}.promptArgs" must be a plain object`);
      }
      for (const [k, v] of Object.entries(cfg.promptArgs)) {
        if (typeof v !== "string") {
          throw new Error(`"${hookName}.promptArgs.${k}" must be a string`);
        }
      }
    }
  }
  if (cfg.condition !== undefined) {
    if (typeof cfg.condition !== "string" || cfg.condition.length > 1024) {
      throw new Error(
        `"${hookName}.condition" must be a string ≤ 1024 characters`,
      );
    }
  }
  if (cfg.model !== undefined) {
    if (typeof cfg.model !== "string" || cfg.model.trim() === "") {
      throw new Error(`"${hookName}.model" must be a non-empty string`);
    }
  }
  if (cfg.effort !== undefined) {
    if (!["low", "medium", "high", "max"].includes(cfg.effort)) {
      throw new Error(
        `"${hookName}.effort" must be one of "low", "medium", "high", "max"`,
      );
    }
  }
}

/**
 * Expand a discriminated unified hook (e.g. onCompaction.phase="pre"|"post")
 * into the corresponding internal legacy slot, then clear the unified key.
 * Throws if the discriminator value is invalid or if both the unified hook
 * and the legacy slot are set simultaneously.
 * legacyA/legacyB may be null when there is no legacy field to guard against.
 */
function expandDiscriminatedHook(
  policy: AutomationPolicy,
  unifiedKey: string,
  discriminatorKey: string,
  valueA: string,
  slotA: string,
  legacyA: string | null,
  valueB: string,
  slotB: string,
  legacyB: string | null,
  filePath: string,
): void {
  const p = policy as Record<string, unknown>;
  const hook = p[unifiedKey];
  if (hook === undefined) return;
  if (typeof hook !== "object" || hook === null) {
    throw new Error(`"${unifiedKey}" must be an object`);
  }
  const discriminator = (hook as Record<string, unknown>)[discriminatorKey];
  if (discriminator !== valueA && discriminator !== valueB) {
    throw new Error(
      `"${unifiedKey}.${discriminatorKey}" must be "${valueA}" or "${valueB}" (got ${JSON.stringify(discriminator)})`,
    );
  }
  // Only guard the slot that matches the actual discriminator value.
  if (
    discriminator === valueA &&
    legacyA !== null &&
    p[legacyA] !== undefined
  ) {
    throw new Error(
      `Cannot set both "${unifiedKey}" (${discriminatorKey}: "${valueA}") and "${legacyA}" — use ${unifiedKey} only.`,
    );
  }
  if (
    discriminator === valueB &&
    legacyB !== null &&
    p[legacyB] !== undefined
  ) {
    throw new Error(
      `Cannot set both "${unifiedKey}" (${discriminatorKey}: "${valueB}") and "${legacyB}" — use ${unifiedKey} only.`,
    );
  }
  const { [discriminatorKey]: _disc, ...rest } = hook as Record<
    string,
    unknown
  >;
  const targetKey = discriminator === valueA ? slotA : slotB;
  p[targetKey] = rest;
  p[unifiedKey] = undefined;

  // Deprecation warnings for pre-existing legacy fields (set before expansion).
  // These are emitted after the expansion so callers can check the hadLegacy*
  // flags they captured before calling this helper.
  void filePath; // filePath passed through to callers for their warn messages
}

/** Load and validate a JSON automation policy file. Throws on any failure. */
export function loadPolicy(filePath: string): AutomationPolicy {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read automation policy file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse automation policy file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Automation policy must be a JSON object in "${filePath}"`);
  }

  const policy = parsed as AutomationPolicy;

  // ── onCompaction normalization (v2.43.0+) ───────────────────────────────
  // Expand unified `onCompaction` into internal onPreCompact/onPostCompact.
  // hadLegacy* captured BEFORE expansion so warn only for user-set values.
  const hadLegacyPreCompact = policy.onPreCompact !== undefined;
  const hadLegacyPostCompact = policy.onPostCompact !== undefined;
  expandDiscriminatedHook(
    policy,
    "onCompaction",
    "phase",
    "pre",
    "onPreCompact",
    "onPreCompact",
    "post",
    "onPostCompact",
    "onPostCompact",
    filePath,
  );
  if (hadLegacyPreCompact) {
    console.warn(
      `[automation-policy] "onPreCompact" in "${filePath}" is deprecated — migrate to "onCompaction" with phase: "pre". Legacy name removed no earlier than v2.46 + 30 days after v2.43.0 release.`,
    );
  }
  if (hadLegacyPostCompact) {
    console.warn(
      `[automation-policy] "onPostCompact" in "${filePath}" is deprecated — migrate to "onCompaction" with phase: "post". Legacy name removed no earlier than v2.46 + 30 days after v2.43.0 release.`,
    );
  }

  // ── onDiagnosticsStateChange normalization (v2.43.0+) ───────────────────
  // Expand into internal onDiagnosticsError/onDiagnosticsCleared based on state.
  const hadLegacyDiagError = policy.onDiagnosticsError !== undefined;
  const hadLegacyDiagCleared = policy.onDiagnosticsCleared !== undefined;
  expandDiscriminatedHook(
    policy,
    "onDiagnosticsStateChange",
    "state",
    "error",
    "onDiagnosticsError",
    "onDiagnosticsError",
    "cleared",
    "onDiagnosticsCleared",
    "onDiagnosticsCleared",
    filePath,
  );
  if (hadLegacyDiagError) {
    console.warn(
      `[automation-policy] "onDiagnosticsError" in "${filePath}" is deprecated — migrate to "onDiagnosticsStateChange" with state: "error". Legacy name removed no earlier than v2.46 + 30 days after v2.43.0 release.`,
    );
  }
  if (hadLegacyDiagCleared) {
    console.warn(
      `[automation-policy] "onDiagnosticsCleared" in "${filePath}" is deprecated — migrate to "onDiagnosticsStateChange" with state: "cleared". Legacy name removed no earlier than v2.46 + 30 days after v2.43.0 release.`,
    );
  }

  // ── onDebugSession normalization (v2.43.0+) ─────────────────────────────
  // Expand into internal onDebugSessionStart/onDebugSessionEnd based on phase.
  const hadLegacyDebugStart = policy.onDebugSessionStart !== undefined;
  const hadLegacyDebugEnd = policy.onDebugSessionEnd !== undefined;
  expandDiscriminatedHook(
    policy,
    "onDebugSession",
    "phase",
    "start",
    "onDebugSessionStart",
    "onDebugSessionStart",
    "end",
    "onDebugSessionEnd",
    "onDebugSessionEnd",
    filePath,
  );
  if (hadLegacyDebugStart) {
    console.warn(
      `[automation-policy] "onDebugSessionStart" in "${filePath}" is deprecated — migrate to "onDebugSession" with phase: "start". Legacy name removed no earlier than v2.46 + 30 days after v2.43.0 release.`,
    );
  }
  if (hadLegacyDebugEnd) {
    console.warn(
      `[automation-policy] "onDebugSessionEnd" in "${filePath}" is deprecated — migrate to "onDebugSession" with phase: "end". Legacy name removed no earlier than v2.46 + 30 days after v2.43.0 release.`,
    );
  }

  // ── onTestRun(filter) normalization (v2.43.0+) ──────────────────────────
  // The new canonical form is `onTestRun.filter: "any"|"failure"|"pass-after-fail"`.
  // - "any" / "failure" rewrite to onFailureOnly:false/true on the same hook.
  // - "pass-after-fail" is routed into the onTestPassAfterFailure slot (a
  //   separate internal hook with its own dispatch path).
  // Legacy `onFailureOnly` field + legacy `onTestPassAfterFailure` hook still
  // work but warn at load time.
  const hadLegacyOnFailureOnly =
    policy.onTestRun !== undefined &&
    (policy.onTestRun as { onFailureOnly?: unknown }).onFailureOnly !==
      undefined;
  const hadLegacyTestPassAfterFailure =
    policy.onTestPassAfterFailure !== undefined;
  if (
    policy.onTestRun !== undefined &&
    typeof policy.onTestRun === "object" &&
    policy.onTestRun !== null
  ) {
    const tr = policy.onTestRun as unknown as {
      filter?: unknown;
      onFailureOnly?: unknown;
    } & Record<string, unknown>;
    if (tr.filter !== undefined) {
      if (
        tr.filter !== "any" &&
        tr.filter !== "failure" &&
        tr.filter !== "pass-after-fail"
      ) {
        throw new Error(
          `"onTestRun.filter" must be one of "any", "failure", "pass-after-fail" (got ${JSON.stringify(tr.filter)})`,
        );
      }
      if (tr.onFailureOnly !== undefined) {
        throw new Error(
          `Cannot set both "onTestRun.filter" and "onTestRun.onFailureOnly" — use "filter" only.`,
        );
      }
      if (tr.filter === "pass-after-fail") {
        if (hadLegacyTestPassAfterFailure) {
          throw new Error(
            `Cannot set both "onTestRun" (filter: "pass-after-fail") and legacy "onTestPassAfterFailure" — use onTestRun.filter only.`,
          );
        }
        const { filter: _f, onFailureOnly: _ofo, ...rest } = tr;
        policy.onTestPassAfterFailure =
          rest as unknown as OnTestPassAfterFailurePolicy;
        policy.onTestRun = undefined;
      } else {
        tr.onFailureOnly = tr.filter === "failure";
        tr.filter = undefined;
      }
    }
  }
  if (hadLegacyOnFailureOnly) {
    console.warn(
      `[automation-policy] "onTestRun.onFailureOnly" in "${filePath}" is deprecated — migrate to "onTestRun.filter" ("failure" or "any"). Legacy field removed no earlier than v2.46 + 30 days after v2.43.0 release.`,
    );
  }
  if (hadLegacyTestPassAfterFailure) {
    console.warn(
      `[automation-policy] "onTestPassAfterFailure" in "${filePath}" is deprecated — migrate to "onTestRun" with filter: "pass-after-fail". Legacy hook removed no earlier than v2.46 + 30 days after v2.43.0 release.`,
    );
  }

  // Helper: throw with actual value in message for easier debugging
  function expectType(value: unknown, type: string, field: string): void {
    if (typeof value !== type) {
      throw new Error(
        `"${field}" must be ${type} (got ${typeof value}: ${JSON.stringify(value)})`,
      );
    }
  }

  // Validate top-level fields
  if (
    policy.defaultModel !== undefined &&
    typeof policy.defaultModel !== "string"
  ) {
    throw new Error(`"defaultModel" must be a string`);
  }
  if (policy.maxTasksPerHour !== undefined) {
    if (
      typeof policy.maxTasksPerHour !== "number" ||
      !Number.isInteger(policy.maxTasksPerHour) ||
      policy.maxTasksPerHour < 0
    ) {
      throw new Error(`"maxTasksPerHour" must be a non-negative integer`);
    }
  }
  if (policy.automationSystemPrompt !== undefined) {
    if (typeof policy.automationSystemPrompt !== "string") {
      throw new Error(`"automationSystemPrompt" must be a string`);
    }
    if (policy.automationSystemPrompt.length > 4096) {
      throw new Error(`"automationSystemPrompt" must be ≤ 4096 characters`);
    }
  }
  if (policy.defaultEffort !== undefined) {
    if (!["low", "medium", "high", "max"].includes(policy.defaultEffort)) {
      throw new Error(
        `"defaultEffort" must be one of "low", "medium", "high", "max"`,
      );
    }
  }

  // ── Generic hook validation fold ─────────────────────────────────────────
  //
  // Every hook that follows the standard shape (enabled boolean + cooldownMs
  // required + validatePromptSource) is covered by iterating STANDARD_HOOK_KEYS.
  // Hooks with additional fields (onDiagnosticsError, onFileSave, onFileChanged,
  // onInstructionsLoaded, onTestRun) are handled separately AFTER the fold.
  //
  // HOOK_SUBJECT_KEY documents which context field each hook's `condition` glob
  // is matched against.  This prevents accidentally applying wrong subject logic
  // to non-file hooks.
  type PolicyKey = keyof typeof policy;

  const HOOK_SUBJECT_KEY: Record<string, string> = {
    onFileSave: "file",
    onFileChanged: "file",
    onGitCommit: "message",
    onGitPush: "branch",
    onGitPull: "branch",
    onBranchCheckout: "branch",
    onPullRequest: "title",
    onTestPassAfterFailure: "runner",
    onTaskCreated: "prompt",
    onTaskSuccess: "output",
    onPermissionDenied: "tool",
    onDiagnosticsCleared: "file",
    onCwdChanged: "cwd",
    onPreCompact: "session",
    onPostCompact: "session",
    onTestRun: "runner",
    onDebugSessionStart: "sessionName",
    onDebugSessionEnd: "sessionName",
  };
  void HOOK_SUBJECT_KEY; // referenced by callers; kept for documentation

  // Standard hooks: required cooldownMs, no extra fields
  const STANDARD_HOOK_KEYS = [
    "onTestPassAfterFailure",
    "onGitCommit",
    "onGitPush",
    "onGitPull",
    "onBranchCheckout",
    "onPullRequest",
    "onTaskCreated",
    "onPermissionDenied",
    "onDiagnosticsCleared",
    "onTaskSuccess",
    "onDebugSessionStart",
    "onDebugSessionEnd",
    "onCwdChanged",
    "onPreCompact",
    "onPostCompact",
  ] as const satisfies ReadonlyArray<PolicyKey>;

  for (const key of STANDARD_HOOK_KEYS) {
    const cfg = policy[key];
    if (cfg === undefined) continue;
    if (typeof cfg !== "object" || cfg === null) {
      throw new Error(`"${key}" must be an object`);
    }
    const rec = cfg as unknown as Record<string, unknown>;
    if (typeof rec.enabled !== "boolean") {
      throw new Error(`"${key}.enabled" must be a boolean`);
    }
    validatePromptSource(key, rec);
    expectType(rec.cooldownMs, "number", `${key}.cooldownMs`);
    if (!Number.isFinite(rec.cooldownMs as number)) {
      throw new Error(`"${key}.cooldownMs" must be a finite number`);
    }
    rec.cooldownMs = Math.max(rec.cooldownMs as number, MIN_COOLDOWN_MS);
  }

  // ── Per-hook extras (after generic fold) ─────────────────────────────────

  // Validate onDiagnosticsError (extra: minSeverity required, diagnosticTypes,
  // dedupeByContent, dedupeContentCooldownMs)
  if (policy.onDiagnosticsError !== undefined) {
    const d = policy.onDiagnosticsError;
    if (typeof d !== "object" || d === null) {
      throw new Error(`"onDiagnosticsError" must be an object`);
    }
    if (typeof d.enabled !== "boolean") {
      throw new Error(`"onDiagnosticsError.enabled" must be a boolean`);
    }
    if (d.minSeverity !== "error" && d.minSeverity !== "warning") {
      throw new Error(
        `"onDiagnosticsError.minSeverity" must be "error" or "warning"`,
      );
    }
    validatePromptSource("onDiagnosticsError", d);
    expectType(d.cooldownMs, "number", "onDiagnosticsError.cooldownMs");
    if (!Number.isFinite(d.cooldownMs as number)) {
      throw new Error(
        `"onDiagnosticsError.cooldownMs" must be a finite number`,
      );
    }
    d.cooldownMs = Math.max(d.cooldownMs, MIN_COOLDOWN_MS);
    if (d.diagnosticTypes !== undefined) {
      if (
        !Array.isArray(d.diagnosticTypes) ||
        d.diagnosticTypes.length === 0 ||
        !d.diagnosticTypes.every((t: unknown) => typeof t === "string")
      ) {
        throw new Error(
          `"onDiagnosticsError.diagnosticTypes" must be a non-empty array of strings`,
        );
      }
    }
    if (
      d.dedupeByContent !== undefined &&
      typeof d.dedupeByContent !== "boolean"
    ) {
      throw new Error(`"onDiagnosticsError.dedupeByContent" must be a boolean`);
    }
    if (d.dedupeContentCooldownMs !== undefined) {
      if (
        typeof d.dedupeContentCooldownMs !== "number" ||
        !Number.isFinite(d.dedupeContentCooldownMs)
      ) {
        throw new Error(
          `"onDiagnosticsError.dedupeContentCooldownMs" must be a number`,
        );
      }
      d.dedupeContentCooldownMs = Math.max(
        d.dedupeContentCooldownMs,
        MIN_COOLDOWN_MS,
      );
    }
  }

  // Validate onFileSave (extra: patterns required)
  if (policy.onFileSave !== undefined) {
    const s = policy.onFileSave;
    if (typeof s !== "object" || s === null) {
      throw new Error(`"onFileSave" must be an object`);
    }
    if (typeof s.enabled !== "boolean") {
      throw new Error(`"onFileSave.enabled" must be a boolean`);
    }
    if (
      !Array.isArray(s.patterns) ||
      s.patterns.length > 100 ||
      s.patterns.some((p: unknown) => typeof p !== "string" || p.length > 1024)
    ) {
      throw new Error(
        "onFileSave.patterns must be an array of ≤100 strings, each ≤1024 chars",
      );
    }
    validatePromptSource("onFileSave", s);
    expectType(s.cooldownMs, "number", "onFileSave.cooldownMs");
    if (!Number.isFinite(s.cooldownMs as number)) {
      throw new Error(`"onFileSave.cooldownMs" must be a finite number`);
    }
    s.cooldownMs = Math.max(s.cooldownMs, MIN_COOLDOWN_MS);
  }

  // Validate onFileChanged (extra: patterns required)
  if (policy.onFileChanged !== undefined) {
    const fc = policy.onFileChanged;
    if (typeof fc !== "object" || fc === null) {
      throw new Error(`"onFileChanged" must be an object`);
    }
    if (typeof fc.enabled !== "boolean") {
      throw new Error(`"onFileChanged.enabled" must be a boolean`);
    }
    if (
      !Array.isArray(fc.patterns) ||
      fc.patterns.length > 100 ||
      fc.patterns.some((p: unknown) => typeof p !== "string" || p.length > 1024)
    ) {
      throw new Error(
        "onFileChanged.patterns must be an array of ≤100 strings, each ≤1024 chars",
      );
    }
    validatePromptSource("onFileChanged", fc);
    expectType(fc.cooldownMs, "number", "onFileChanged.cooldownMs");
    if (!Number.isFinite(fc.cooldownMs as number)) {
      throw new Error(`"onFileChanged.cooldownMs" must be a finite number`);
    }
    fc.cooldownMs = Math.max(fc.cooldownMs, MIN_COOLDOWN_MS);
  }

  // Validate onInstructionsLoaded (special: cooldownMs optional, min 5000)
  if (policy.onInstructionsLoaded !== undefined) {
    const il = policy.onInstructionsLoaded;
    if (typeof il !== "object" || il === null) {
      throw new Error(`"onInstructionsLoaded" must be an object`);
    }
    if (typeof il.enabled !== "boolean") {
      throw new Error(`"onInstructionsLoaded.enabled" must be a boolean`);
    }
    if (il.cooldownMs !== undefined) {
      if (typeof il.cooldownMs !== "number" || il.cooldownMs < 5000) {
        throw new Error(
          `"onInstructionsLoaded.cooldownMs" must be a number >= 5000`,
        );
      }
    }
    validatePromptSource("onInstructionsLoaded", il);
  }

  // Validate onTestRun (extra: onFailureOnly required, minDuration optional)
  if (policy.onTestRun !== undefined) {
    const tr = policy.onTestRun;
    if (typeof tr !== "object" || tr === null) {
      throw new Error(`"onTestRun" must be an object`);
    }
    if (typeof tr.enabled !== "boolean") {
      throw new Error(`"onTestRun.enabled" must be a boolean`);
    }
    // After C3 expansion, onFailureOnly is always populated (either by the
    // filter rewrite or by user-provided legacy value). Accept missing as
    // "failure" default for safety.
    if (tr.onFailureOnly === undefined) {
      tr.onFailureOnly = true;
    } else if (typeof tr.onFailureOnly !== "boolean") {
      throw new Error(`"onTestRun.onFailureOnly" must be a boolean`);
    }
    validatePromptSource("onTestRun", tr);
    expectType(tr.cooldownMs, "number", "onTestRun.cooldownMs");
    if (!Number.isFinite(tr.cooldownMs as number)) {
      throw new Error(`"onTestRun.cooldownMs" must be a finite number`);
    }
    tr.cooldownMs = Math.max(tr.cooldownMs, MIN_COOLDOWN_MS);
    if (tr.minDuration !== undefined) {
      if (
        typeof tr.minDuration !== "number" ||
        !Number.isFinite(tr.minDuration) ||
        tr.minDuration < 0
      ) {
        throw new Error(
          `"onTestRun.minDuration" must be a non-negative number`,
        );
      }
    }
  }

  return policy;
}

/**
 * CC hook events that require a settings.json entry calling a bridge notify tool.
 * Bridge-tool-triggered hooks (onFileSave, onGitCommit, etc.) need no CC wiring.
 */
const CC_HOOK_TOOL_MAP: Record<string, string> = {
  PreCompact: "notifyPreCompact",
  PostCompact: "notifyPostCompact",
  InstructionsLoaded: "notifyInstructionsLoaded",
  TaskCreated: "notifyTaskCreated",
  PermissionDenied: "notifyPermissionDenied",
  CwdChanged: "notifyCwdChanged",
};

/** Policy hook names that correspond to CC hook events (need settings.json wiring). */
const _POLICY_TO_CC_EVENT: Record<string, string> = {
  onPreCompact: "PreCompact",
  onPostCompact: "PostCompact",
  onInstructionsLoaded: "InstructionsLoaded",
  onTaskCreated: "TaskCreated",
  onPermissionDenied: "PermissionDenied",
  onCwdChanged: "CwdChanged",
};

/**
 * Check which CC hook events have at least one settings.json entry whose
 * command references the matching bridge notify tool. Returns a map of
 * CC event name → wired (boolean).
 */
export function checkCcHookWiring(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const ccEvent of Object.keys(CC_HOOK_TOOL_MAP)) {
    result[ccEvent] = false;
  }

  try {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR ??
      path.join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".claude");
    const settingsPath = path.join(configDir, "settings.json");
    const raw = fs.readFileSync(settingsPath, "utf-8");
    type FlatHook = { command?: string };
    type NestedHook = { matcher?: string; hooks?: FlatHook[] };
    const settings = JSON.parse(raw) as {
      hooks?: Record<string, Array<NestedHook | FlatHook>>;
    };
    const hooks = settings.hooks ?? {};
    const commandMatches = (
      cmd: string | undefined,
      ccEvent: string,
      toolName: string,
    ) =>
      typeof cmd === "string" &&
      (cmd.includes(toolName) || cmd.includes(`notify ${ccEvent}`));
    for (const [ccEvent, toolName] of Object.entries(CC_HOOK_TOOL_MAP)) {
      const entries = hooks[ccEvent] ?? [];
      result[ccEvent] = entries.some((e) => {
        // New format: { matcher, hooks: [{ type, command }] }
        if (e && Array.isArray((e as NestedHook).hooks)) {
          return (e as NestedHook).hooks?.some((h) =>
            commandMatches(h.command, ccEvent, toolName),
          );
        }
        // Legacy flat format: { type, command }
        return commandMatches((e as FlatHook).command, ccEvent, toolName);
      });
    }
  } catch {
    // Settings file missing or unparseable — treat all as unwired
  }

  return result;
}

// ── AutomationHooks ───────────────────────────────────────────────────────────

export class AutomationHooks {
  /** Compiled AST for the functional interpreter. Null if parse failed. */
  private _programAST: AutomationProgram[] | null = null;
  /** Backend instance for the functional interpreter. */
  private _interpreterBackend: VsCodeBackend | null = null;
  /**
   * Pure-value state holding cooldown timestamps, diagnostic error counts, and
   * test outcomes.  Mutations go through the pure-function helpers from
   * `src/fp/automationState.ts`; the class re-assigns `_automationState` on
   * each "write" to maintain immutability semantics at the value level.
   */
  private _automationState: AutomationState = EMPTY_AUTOMATION_STATE;
  /** Tracks previous error count per normalized file path for zero-transition detection. */
  private prevDiagnosticErrors = new Map<string, number>();
  /**
   * Per-runner last outcome — used to detect fail→pass transitions for onTestPassAfterFailure.
   * Key: runner name. Value: "pass" | "fail".
   */
  private lastTestOutcomeByRunner = new Map<string, "pass" | "fail">();
  private _lastFiredAt: string | null = null;
  /** Last interpreter run promise — allows tests to await completion. */
  private _lastRunPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly policy: AutomationPolicy,
    orchestrator: ClaudeOrchestrator,
    private readonly log: (msg: string) => void,
    _extensionClient?: ExtensionClient,
    _workspace?: string,
  ) {
    // Phase 4: always initialise interpreter (primary path)
    {
      const parseResult = parsePolicy(policy);
      if (parseResult.ok) {
        this._programAST = parseResult.value;
        this._interpreterBackend = new VsCodeBackend(orchestrator, {
          info: this.log.bind(this),
        });
      } else {
        this.log(
          `[automation] interpreter parse failed: ${parseResult.message}`,
        );
      }
    }
  }

  private async _runInterpreter(
    eventType: string,
    eventData: Record<string, string>,
  ): Promise<void> {
    if (!this._programAST || !this._interpreterBackend) return;
    const ctx: InterpreterContext = {
      state: this._automationState,
      now: Date.now(),
      eventType,
      eventData,
      backend: this._interpreterBackend,
      log: this.log.bind(this),
    };
    const result = await executeAutomationPolicy(this._programAST, ctx);
    if (result.ok) {
      this._automationState = result.value.updatedState;
      if (result.value.taskIds.length > 0) {
        this.log(
          `[interpreter] ${eventType}: enqueued ${result.value.taskIds.length} task(s)`,
        );
      }
      for (const s of result.value.skipped) {
        this.log(`[interpreter] ${eventType}: skipped ${s.hook} — ${s.reason}`);
      }
      for (const e of result.value.errors) {
        this.log(
          `[interpreter] ${eventType}: error in ${e.hook} — ${e.message}`,
        );
      }
    } else {
      this.log(
        `[interpreter] ${eventType}: interpreter error — ${result.message}`,
      );
    }
  }

  /**
   * Returns a Promise that resolves once all in-flight interpreter runs finish.
   * Useful in tests to await async side-effects before asserting on task counts.
   */
  async flush(): Promise<void> {
    await this._lastRunPromise;
  }

  /** Tear down the instance: nulls interpreter references. */
  destroy(): void {
    this._programAST = null;
    this._interpreterBackend = null;
  }

  handleDiagnosticsChanged(file: string, diagnostics: Diagnostic[]): void {
    const normalizedFile = path.resolve(file);

    // Track error count for zero-transition detection (onDiagnosticsCleared)
    const severityRankForClear: Record<string, number> = {
      error: 2,
      warning: 1,
      info: 0,
      information: 0,
      hint: 0,
    };
    const currentErrorCount = diagnostics.filter(
      (d) => (severityRankForClear[d.severity] ?? 0) >= 1,
    ).length;
    const prevErrorCount = this.prevDiagnosticErrors.get(normalizedFile) ?? 0;
    this.prevDiagnosticErrors.set(normalizedFile, currentErrorCount);
    // FIFO cap to bound memory
    if (this.prevDiagnosticErrors.size > 5_000) {
      const oldest = this.prevDiagnosticErrors.keys().next().value;
      if (oldest !== undefined) this.prevDiagnosticErrors.delete(oldest);
    }

    // Feed interpreter state using severity numbers where lower = more severe
    // (error=0, warning=1, info/hint=2+) matching automationState.ts / evaluateWhen convention.
    const severityToNum: Record<string, number> = {
      error: 0,
      warning: 1,
      info: 2,
      information: 2,
      hint: 3,
    };
    const maxSeverityNum = diagnostics.reduce((min, d) => {
      const rank = severityToNum[d.severity] ?? 3;
      return rank < min ? rank : min;
    }, 4); // 4 = no diagnostics / below hint
    this._automationState = setLatestDiagnostics(
      this._automationState,
      normalizedFile,
      maxSeverityNum,
      diagnostics.length,
    );

    // Build diagnostics text for {{diagnostics}} placeholder (capped at 20)
    const diagsForPrompt = diagnostics.slice(0, 20);
    const overflow = diagnostics.length - diagsForPrompt.length;
    const diagnosticsText =
      diagsForPrompt
        .map(
          (d) =>
            `[${d.severity}] ${d.message}${d.source ? ` (${d.source})` : ""}`,
        )
        .join("\n") + (overflow > 0 ? `\n… and ${overflow} more` : "");

    // Collect source/code strings for diagnosticTypes filtering
    const diagnosticSources = diagnostics
      .flatMap((d) => [
        d.source?.toLowerCase() ?? "",
        String(d.code ?? "").toLowerCase(),
      ])
      .filter(Boolean)
      .join(",");

    const diagnosticSig = diagnosticSignature(diagnostics);

    // Fire onDiagnosticsCleared if transitioning from non-zero → zero; chain
    // the interpreter runs so flush() awaits both and state is updated correctly.
    if (prevErrorCount > 0 && currentErrorCount === 0) {
      this._lastRunPromise = this._runInterpreter("onDiagnosticsCleared", {
        file: normalizedFile,
      }).then(() =>
        this._runInterpreter("onDiagnosticsError", {
          file: normalizedFile,
          diagnostics: diagnosticsText,
          diagnosticSources,
          diagnosticSig,
          count: String(diagnostics.length),
        }),
      );
    } else {
      this._lastRunPromise = this._runInterpreter("onDiagnosticsError", {
        file: normalizedFile,
        diagnostics: diagnosticsText,
        diagnosticSources,
        diagnosticSig,
        count: String(diagnostics.length),
      });
    }
  }

  /**
   * Called when Claude Code fires a CwdChanged hook (Claude Code 2.1.83+).
   * Fires when CC's working directory changes — useful for re-snapshotting workspace context.
   */
  handleCwdChanged(newCwd: string): void {
    this._lastRunPromise = this._runInterpreter("onCwdChanged", {
      cwd: newCwd,
    });
  }

  /**
   * Called when Claude Code fires a PreCompact hook.
   * Fires the onPreCompact automation hook before context trimming — use to snapshot state or
   * write a handoff note before Claude loses context.
   */
  handlePreCompact(): void {
    this._lastRunPromise = this._runInterpreter("onPreCompact", {});
  }

  /**
   * Called when Claude Code fires a PostCompact hook (Claude Code 2.1.76+).
   * Re-enqueues the configured prompt so Claude can re-snapshot IDE state after losing context.
   */
  handlePostCompact(): void {
    this._lastRunPromise = this._runInterpreter("onPostCompact", {});
  }

  /**
   * Called when Claude Code fires an InstructionsLoaded hook (Claude Code 2.1.76+).
   * Fires once per session; injects bridge status / tool capability summary at start.
   */
  handleInstructionsLoaded(): void {
    this._lastRunPromise = this._runInterpreter("onInstructionsLoaded", {});
  }

  handleFileSaved(_id: string, type: string, file: string): void {
    if (type !== "save") return;
    const normalizedFile = path.resolve(file);
    this._lastRunPromise = this._runInterpreter("onFileSave", {
      file: normalizedFile,
    });
  }

  /**
   * Called when the VS Code extension reports a file-changed event (type === "change").
   * Distinct from handleFileSaved — reacts to any editor buffer change, not just explicit saves.
   * Useful for triggering tasks on unsaved edits (e.g. lint-as-you-type workflows).
   */
  handleFileChanged(_id: string, type: string, file: string): void {
    if (type !== "change") return;
    const normalizedFile = path.resolve(file);
    this._lastRunPromise = this._runInterpreter("onFileChanged", {
      file: normalizedFile,
    });
  }

  /**
   * Called after every runTests tool invocation completes.
   * Triggers an automation task when tests fail (or on every run if onFailureOnly is false).
   */
  handleTestRun(result: TestRunResult): void {
    const failureCount = result.summary.failed + result.summary.errored;
    const current = failureCount === 0 ? "pass" : "fail";

    // Update per-runner outcome state unconditionally so onTestPassAfterFailure
    // can detect fail→pass transitions even when onTestRun is disabled/absent.
    const passAfterFailRunners: string[] = [];
    for (const runner of result.runners) {
      const prev = this.lastTestOutcomeByRunner.get(runner);
      this.lastTestOutcomeByRunner.set(runner, current);
      // Feed interpreter state
      this._automationState = setTestRunnerStatus(
        this._automationState,
        runner,
        current,
      );
      if (prev === "fail" && current === "pass") {
        passAfterFailRunners.push(runner);
      }
    }

    const testRunEventData = {
      runner: result.runners.join(", ") || "",
      failed: String(failureCount),
      passed: String(result.summary.passed),
      total: String(result.summary.total),
      failures: JSON.stringify(result.failures.slice(0, 100)),
      durationMs: String(result.summary.durationMs ?? ""),
    };

    // Chain interpreter runs so flush() awaits all of them and state is updated
    // sequentially. If any runner had a fail→pass transition, run that first so
    // its cooldown state is visible to subsequent runs within the same flush.
    if (passAfterFailRunners.length > 0) {
      let chain = Promise.resolve();
      for (const runner of passAfterFailRunners) {
        chain = chain.then(() =>
          this._runInterpreter("onTestPassAfterFailure", { runner }),
        );
      }
      this._lastRunPromise = chain.then(() =>
        this._runInterpreter("onTestRun", testRunEventData),
      );
    } else {
      this._lastRunPromise = this._runInterpreter(
        "onTestRun",
        testRunEventData,
      );
    }
  }

  /**
   * Called after a successful gitCommit tool call.
   * Fires the onGitCommit automation hook if configured.
   */
  async handleGitCommit(result: GitCommitResult): Promise<void> {
    this._lastRunPromise = this._runInterpreter("onGitCommit", {
      hash: result.hash,
      branch: result.branch,
      message: result.message,
      count: String(result.count),
      files: result.files.join(", "),
    });
  }

  /**
   * Called after a successful gitPush tool call.
   * Fires the onGitPush automation hook if configured.
   */
  handleGitPush(result: GitPushResult): void {
    this._lastRunPromise = this._runInterpreter("onGitPush", {
      branch: result.branch,
      remote: result.remote,
      hash: result.hash,
    });
  }

  /**
   * Fires the onGitPull automation hook if configured.
   */
  handleGitPull(result: GitPullResult): void {
    this._lastRunPromise = this._runInterpreter("onGitPull", {
      branch: result.branch,
      remote: result.remote,
    });
  }

  /**
   * Called after a successful gitCheckout tool call.
   * Fires the onBranchCheckout automation hook if configured.
   */
  handleBranchCheckout(result: BranchCheckoutResult): void {
    this._lastRunPromise = this._runInterpreter("onBranchCheckout", {
      branch: result.branch,
      previousBranch: result.previousBranch ?? "(detached HEAD)",
      created: String(result.created),
    });
  }

  /**
   * Fires the onPullRequest automation hook if configured.
   */
  handlePullRequest(result: PullRequestResult): void {
    this._lastRunPromise = this._runInterpreter("onPullRequest", {
      title: result.title,
      url: result.url,
      branch: result.branch,
      number: result.number != null ? String(result.number) : "",
    });
  }

  handleTaskCreated(result: TaskCreatedResult): void {
    this._lastRunPromise = this._runInterpreter("onTaskCreated", {
      taskId: result.taskId,
      prompt: result.prompt,
    });
  }

  handlePermissionDenied(result: PermissionDeniedResult): void {
    this._lastRunPromise = this._runInterpreter("onPermissionDenied", {
      tool: result.tool,
      reason: result.reason,
    });
  }

  /**
   * Fires the onDiagnosticsCleared hook when a file transitions from non-zero to zero errors.
   * Called internally by handleDiagnosticsChanged.
   */
  handleDiagnosticsCleared(normalizedFile: string): void {
    this._lastRunPromise = this._runInterpreter("onDiagnosticsCleared", {
      file: normalizedFile,
      diagnosticSig: "",
    });
  }

  /**
   * Fires the onTaskSuccess hook when a Claude orchestrator task completes with status "done".
   * Call from bridge.ts when a task transitions to done.
   */
  handleTaskSuccess(result: TaskSuccessResult): void {
    this._lastRunPromise = this._runInterpreter("onTaskSuccess", {
      taskId: result.taskId,
      output: result.output,
    });
  }

  /**
   * Called when a VS Code debug session ends (hasActiveSession transitions true→false).
   * Fires the onDebugSessionEnd automation hook if configured.
   */
  async handleDebugSessionEnd(result: DebugSessionEndResult): Promise<void> {
    this._lastRunPromise = this._runInterpreter("onDebugSessionEnd", {
      sessionName: result.sessionName,
      sessionType: result.sessionType,
    });
  }

  /**
   * Called when a VS Code debug session starts (hasActiveSession transitions false→true).
   * Fires the onDebugSessionStart automation hook if configured.
   */
  async handleDebugSessionStart(
    result: DebugSessionStartResult,
  ): Promise<void> {
    this._lastRunPromise = this._runInterpreter("onDebugSessionStart", {
      sessionName: result.sessionName,
      sessionType: result.sessionType,
      breakpointCount: String(result.breakpointCount),
      activeFile: result.activeFile,
    });
  }

  /** Summary of automation policy for getBridgeStatus. */
  getStatus(): {
    onPreCompact: { enabled: boolean; cooldownMs: number } | null;
    onPostCompact: { enabled: boolean; cooldownMs: number } | null;
    onDiagnosticsError: { enabled: boolean } | null;
    onFileSave: { enabled: boolean; patternCount: number } | null;
    onFileChanged: { enabled: boolean; patternCount: number } | null;
    onCwdChanged: { enabled: boolean; cooldownMs: number } | null;
    onTestRun: {
      enabled: boolean;
      onFailureOnly: boolean;
      cooldownMs: number;
    } | null;
    onTestPassAfterFailure: { enabled: boolean; cooldownMs: number } | null;
    onGitCommit: { enabled: boolean; cooldownMs: number } | null;
    onGitPush: { enabled: boolean; cooldownMs: number } | null;
    onBranchCheckout: { enabled: boolean; cooldownMs: number } | null;
    onPullRequest: { enabled: boolean; cooldownMs: number } | null;
    onTaskCreated: { enabled: boolean; cooldownMs: number } | null;
    onInstructionsLoaded: { enabled: boolean; cooldownMs: number } | null;
    onPermissionDenied: { enabled: boolean; cooldownMs: number } | null;
    onDiagnosticsCleared: { enabled: boolean; cooldownMs: number } | null;
    onTaskSuccess: { enabled: boolean; cooldownMs: number } | null;
    onGitPull: { enabled: boolean; cooldownMs: number } | null;
    onDebugSessionEnd: { enabled: boolean; cooldownMs: number } | null;
    onDebugSessionStart: { enabled: boolean; cooldownMs: number } | null;
    unwiredEnabledHooks: string[];
    defaultModel: string;
    maxTasksPerHour: number;
    tasksThisHour: number;
    defaultEffort: string;
    automationSystemPrompt: string;
  } {
    const p = this.policy;
    const wiring = checkCcHookWiring();
    const unwiredEnabledHooks = Object.entries(_POLICY_TO_CC_EVENT)
      .filter(([policyKey, ccEvent]) => {
        const hookCfg = p[policyKey as keyof AutomationPolicy] as
          | { enabled?: boolean }
          | undefined;
        return hookCfg?.enabled === true && wiring[ccEvent] === false;
      })
      .map(([policyKey]) => policyKey);
    return {
      onPreCompact: p.onPreCompact
        ? {
            enabled: p.onPreCompact.enabled,
            cooldownMs: p.onPreCompact.cooldownMs,
          }
        : null,
      onPostCompact: p.onPostCompact
        ? {
            enabled: p.onPostCompact.enabled,
            cooldownMs: p.onPostCompact.cooldownMs,
          }
        : null,
      onDiagnosticsError: p.onDiagnosticsError
        ? { enabled: p.onDiagnosticsError.enabled }
        : null,
      onFileSave: p.onFileSave
        ? {
            enabled: p.onFileSave.enabled,
            patternCount: p.onFileSave.patterns.length,
          }
        : null,
      onFileChanged: p.onFileChanged
        ? {
            enabled: p.onFileChanged.enabled,
            patternCount: p.onFileChanged.patterns.length,
          }
        : null,
      onCwdChanged: p.onCwdChanged
        ? {
            enabled: p.onCwdChanged.enabled,
            cooldownMs: p.onCwdChanged.cooldownMs,
          }
        : null,
      onTestRun: p.onTestRun
        ? {
            enabled: p.onTestRun.enabled,
            onFailureOnly: p.onTestRun.onFailureOnly ?? true,
            cooldownMs: p.onTestRun.cooldownMs,
          }
        : null,
      onTestPassAfterFailure: p.onTestPassAfterFailure
        ? {
            enabled: p.onTestPassAfterFailure.enabled,
            cooldownMs: p.onTestPassAfterFailure.cooldownMs,
          }
        : null,
      onGitCommit: p.onGitCommit
        ? {
            enabled: p.onGitCommit.enabled,
            cooldownMs: p.onGitCommit.cooldownMs,
          }
        : null,
      onGitPush: p.onGitPush
        ? {
            enabled: p.onGitPush.enabled,
            cooldownMs: p.onGitPush.cooldownMs,
          }
        : null,
      onBranchCheckout: p.onBranchCheckout
        ? {
            enabled: p.onBranchCheckout.enabled,
            cooldownMs: p.onBranchCheckout.cooldownMs,
          }
        : null,
      onPullRequest: p.onPullRequest
        ? {
            enabled: p.onPullRequest.enabled,
            cooldownMs: p.onPullRequest.cooldownMs,
          }
        : null,
      onTaskCreated: p.onTaskCreated
        ? {
            enabled: p.onTaskCreated.enabled,
            cooldownMs: p.onTaskCreated.cooldownMs,
          }
        : null,
      onInstructionsLoaded: p.onInstructionsLoaded
        ? {
            enabled: p.onInstructionsLoaded.enabled,
            cooldownMs: p.onInstructionsLoaded.cooldownMs ?? 60_000,
          }
        : null,
      onPermissionDenied: p.onPermissionDenied
        ? {
            enabled: p.onPermissionDenied.enabled,
            cooldownMs: p.onPermissionDenied.cooldownMs,
          }
        : null,
      onDiagnosticsCleared: p.onDiagnosticsCleared
        ? {
            enabled: p.onDiagnosticsCleared.enabled,
            cooldownMs: p.onDiagnosticsCleared.cooldownMs,
          }
        : null,
      onTaskSuccess: p.onTaskSuccess
        ? {
            enabled: p.onTaskSuccess.enabled,
            cooldownMs: p.onTaskSuccess.cooldownMs,
          }
        : null,
      onGitPull: p.onGitPull
        ? {
            enabled: p.onGitPull.enabled,
            cooldownMs: p.onGitPull.cooldownMs,
          }
        : null,
      onDebugSessionEnd: p.onDebugSessionEnd
        ? {
            enabled: p.onDebugSessionEnd.enabled,
            cooldownMs: p.onDebugSessionEnd.cooldownMs,
          }
        : null,
      onDebugSessionStart: p.onDebugSessionStart
        ? {
            enabled: p.onDebugSessionStart.enabled,
            cooldownMs: p.onDebugSessionStart.cooldownMs,
          }
        : null,
      unwiredEnabledHooks,
      defaultModel: p.defaultModel ?? "claude-haiku-4-5-20251001",
      maxTasksPerHour: p.maxTasksPerHour ?? 20,
      tasksThisHour: tasksInLastHour(this._automationState, Date.now()),
      defaultEffort: p.defaultEffort ?? "low",
      automationSystemPrompt: (
        p.automationSystemPrompt ?? DEFAULT_AUTOMATION_SYSTEM_PROMPT
      ).slice(0, 80),
    };
  }

  isPreCompactEnabled(): boolean {
    return this.policy.onPreCompact?.enabled === true;
  }

  getStats(): { hooksEnabled: number; lastFiredAt: string | null } {
    const hookKeys = [
      "onFileSave",
      "onFileChanged",
      "onDiagnosticsError",
      "onDiagnosticsCleared",
      "onPreCompact",
      "onPostCompact",
      "onInstructionsLoaded",
      "onBranchCheckout",
      "onGitCommit",
      "onGitPull",
      "onGitPush",
      "onPullRequest",
      "onTestRun",
      "onTestPassAfterFailure",
      "onPermissionDenied",
      "onCwdChanged",
      "onTaskCreated",
      "onTaskSuccess",
      "onDebugSessionStart",
      "onDebugSessionEnd",
    ] as const;
    const hooksEnabled = hookKeys.filter((k) => {
      const hook = this.policy[k] as { enabled?: boolean } | undefined;
      return hook !== undefined && hook.enabled !== false;
    }).length;
    return { hooksEnabled, lastFiredAt: this._lastFiredAt };
  }
}
