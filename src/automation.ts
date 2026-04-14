import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import type { ClaudeOrchestrator } from "./claudeOrchestrator.js";
import type { ExtensionClient } from "./extensionClient.js";
import { getPrompt } from "./prompts.js";

/** Maximum length (chars) of a single diagnostic message before truncation */
const MAX_DIAGNOSTIC_MSG_CHARS = 500;
const MAX_DIAGNOSTICS_IN_PROMPT = 20;

/**
 * Wrap an untrusted user-controlled value in delimiters that include a
 * per-trigger nonce so a crafted value cannot forge a closing delimiter.
 * The nonce is stripped from the value itself before insertion.
 */
function untrustedBlock(label: string, value: string, nonce: string): string {
  if (!/^[A-Z][A-Z0-9 ]*$/.test(label)) {
    throw new Error(
      `untrustedBlock: label must be uppercase ASCII, got: ${JSON.stringify(label)}`,
    );
  }
  const safe = value.replace(new RegExp(nonce, "g"), "");
  return `\n--- BEGIN ${label} [${nonce}] (untrusted) ---\n${safe}\n--- END ${label} [${nonce}] ---\n`;
}
/** Maximum length (chars) of a file path inserted into prompts */
const MAX_FILE_PATH_CHARS = 500;

/**
 * Build a trusted metadata prefix that is prepended to every automation hook
 * prompt BEFORE any untrustedBlock() substitutions. This allows Claude to
 * identify which hook triggered the task and correlate it with IDE context.
 */
function buildHookMetadata(hookName: string, file?: string): string {
  // Strip control characters from the file path before embedding in the trusted
  // metadata prefix — prevents a crafted file name containing \n from injecting
  // additional lines into the structured header block.
  const safeFile = file
    ? file.slice(0, MAX_FILE_PATH_CHARS).replace(/[\x00-\x1F\x7F]/g, "")
    : "N/A";
  return `@@ HOOK: ${hookName} | file: ${safeFile} | ts: ${new Date().toISOString()} @@\n`;
}
/** Maximum length (chars) of an automation policy prompt template (matches runClaudeTask cap) */
const MAX_POLICY_PROMPT_CHARS = 32_768;

/**
 * Truncate a final prompt to MAX_POLICY_PROMPT_CHARS at the last newline before
 * the limit and append a truncation notice. Called after all placeholder
 * substitutions and buildHookMetadata() prepends so the cap applies to the
 * fully-assembled string, not just the raw template.
 */
function truncatePrompt(prompt: string): string {
  if (prompt.length <= MAX_POLICY_PROMPT_CHARS) return prompt;
  const cutoff = prompt.lastIndexOf("\n", MAX_POLICY_PROMPT_CHARS);
  const end = cutoff > 0 ? cutoff : MAX_POLICY_PROMPT_CHARS;
  return `${prompt.slice(0, end)}\n[... truncated to fit 32KB limit ...]`;
}
/** Prune lastTrigger entries older than this to prevent unbounded Map growth */
const LAST_TRIGGER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

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
  testRunnerLastStatus?: "passed" | "failed";
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
   * Only trigger when there are test failures or errors.
   * Set to false to trigger after every test run regardless of outcome.
   * Default: true.
   */
  onFailureOnly: boolean;
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
  onDiagnosticsError?: OnDiagnosticsErrorPolicy;
  onFileSave?: OnFileSavePolicy;
  /** Fired by Claude Code 2.1.83+ FileChanged hook — reacts to any file edit, not just explicit saves. */
  onFileChanged?: OnFileChangedPolicy;
  /** Fired by Claude Code 2.1.83+ CwdChanged hook — fires when CC's working directory changes. */
  onCwdChanged?: OnCwdChangedPolicy;
  /** Fired by Claude Code 2.1.76+ PostCompact hook — re-injects IDE context after compaction. */
  onPostCompact?: OnPostCompactPolicy;
  /** Fired by Claude Code PreCompact hook — runs before context window is trimmed. */
  onPreCompact?: OnPreCompactPolicy;
  /** Fired by Claude Code 2.1.76+ InstructionsLoaded hook — injects bridge status at session start. */
  onInstructionsLoaded?: OnInstructionsLoadedPolicy;
  /** Fired after every runTests call (or only on failures, depending on onFailureOnly). */
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
  /** Fired when all errors/warnings clear for a file (non-zero → zero transition). */
  onDiagnosticsCleared?: OnDiagnosticsClearedPolicy;
  /** Fired when a Claude orchestrator task completes with status done. */
  onTaskSuccess?: OnTaskSuccessPolicy;
  /** Fired when a VS Code debug session terminates (hasActiveSession transitions true→false). */
  onDebugSessionEnd?: OnDebugSessionEndPolicy;
  /** Fired when a VS Code debug session starts (hasActiveSession transitions false→true). */
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

  // Validate onDiagnosticsError
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
    if (typeof d.cooldownMs !== "number" || !Number.isFinite(d.cooldownMs)) {
      throw new Error(`"onDiagnosticsError.cooldownMs" must be a number`);
    }
    if (d.cooldownMs < MIN_COOLDOWN_MS) {
      d.cooldownMs = MIN_COOLDOWN_MS;
    }
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
      if (d.dedupeContentCooldownMs < MIN_COOLDOWN_MS) {
        d.dedupeContentCooldownMs = MIN_COOLDOWN_MS;
      }
    }
  }

  // Validate onFileSave
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
    if (typeof s.cooldownMs !== "number" || !Number.isFinite(s.cooldownMs)) {
      throw new Error(`"onFileSave.cooldownMs" must be a number`);
    }
    if (s.cooldownMs < MIN_COOLDOWN_MS) {
      s.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onFileChanged
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
    if (typeof fc.cooldownMs !== "number" || !Number.isFinite(fc.cooldownMs)) {
      throw new Error(`"onFileChanged.cooldownMs" must be a number`);
    }
    if (fc.cooldownMs < MIN_COOLDOWN_MS) {
      fc.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onCwdChanged
  if (policy.onCwdChanged !== undefined) {
    const cw = policy.onCwdChanged;
    if (typeof cw !== "object" || cw === null) {
      throw new Error(`"onCwdChanged" must be an object`);
    }
    if (typeof cw.enabled !== "boolean") {
      throw new Error(`"onCwdChanged.enabled" must be a boolean`);
    }
    validatePromptSource("onCwdChanged", cw);
    if (typeof cw.cooldownMs !== "number" || !Number.isFinite(cw.cooldownMs)) {
      throw new Error(`"onCwdChanged.cooldownMs" must be a number`);
    }
    if (cw.cooldownMs < MIN_COOLDOWN_MS) {
      cw.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onPreCompact
  if (policy.onPreCompact !== undefined) {
    const p = policy.onPreCompact;
    if (typeof p !== "object" || p === null) {
      throw new Error(`"onPreCompact" must be an object`);
    }
    if (typeof p.enabled !== "boolean") {
      throw new Error(`"onPreCompact.enabled" must be a boolean`);
    }
    validatePromptSource("onPreCompact", p);
    if (typeof p.cooldownMs !== "number" || !Number.isFinite(p.cooldownMs)) {
      throw new Error(`"onPreCompact.cooldownMs" must be a number`);
    }
    if (p.cooldownMs < MIN_COOLDOWN_MS) {
      p.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onPostCompact
  if (policy.onPostCompact !== undefined) {
    const p = policy.onPostCompact;
    if (typeof p !== "object" || p === null) {
      throw new Error(`"onPostCompact" must be an object`);
    }
    if (typeof p.enabled !== "boolean") {
      throw new Error(`"onPostCompact.enabled" must be a boolean`);
    }
    validatePromptSource("onPostCompact", p);
    if (typeof p.cooldownMs !== "number" || !Number.isFinite(p.cooldownMs)) {
      throw new Error(`"onPostCompact.cooldownMs" must be a number`);
    }
    if (p.cooldownMs < MIN_COOLDOWN_MS) {
      p.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onInstructionsLoaded
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

  // Validate onTestRun
  if (policy.onTestRun !== undefined) {
    const tr = policy.onTestRun;
    if (typeof tr !== "object" || tr === null) {
      throw new Error(`"onTestRun" must be an object`);
    }
    if (typeof tr.enabled !== "boolean") {
      throw new Error(`"onTestRun.enabled" must be a boolean`);
    }
    if (typeof tr.onFailureOnly !== "boolean") {
      throw new Error(`"onTestRun.onFailureOnly" must be a boolean`);
    }
    validatePromptSource("onTestRun", tr);
    if (typeof tr.cooldownMs !== "number" || !Number.isFinite(tr.cooldownMs)) {
      throw new Error(`"onTestRun.cooldownMs" must be a number`);
    }
    if (tr.cooldownMs < MIN_COOLDOWN_MS) {
      tr.cooldownMs = MIN_COOLDOWN_MS;
    }
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

  // Validate onTestPassAfterFailure
  if (policy.onTestPassAfterFailure !== undefined) {
    const tpaf = policy.onTestPassAfterFailure;
    if (typeof tpaf !== "object" || tpaf === null) {
      throw new Error(`"onTestPassAfterFailure" must be an object`);
    }
    if (typeof tpaf.enabled !== "boolean") {
      throw new Error(`"onTestPassAfterFailure.enabled" must be a boolean`);
    }
    validatePromptSource("onTestPassAfterFailure", tpaf);
    if (
      typeof tpaf.cooldownMs !== "number" ||
      !Number.isFinite(tpaf.cooldownMs)
    ) {
      throw new Error(`"onTestPassAfterFailure.cooldownMs" must be a number`);
    }
    if (tpaf.cooldownMs < MIN_COOLDOWN_MS) {
      tpaf.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onGitCommit
  if (policy.onGitCommit !== undefined) {
    const gc = policy.onGitCommit;
    if (typeof gc !== "object" || gc === null) {
      throw new Error(`"onGitCommit" must be an object`);
    }
    if (typeof gc.enabled !== "boolean") {
      throw new Error(`"onGitCommit.enabled" must be a boolean`);
    }
    validatePromptSource("onGitCommit", gc);
    if (typeof gc.cooldownMs !== "number" || !Number.isFinite(gc.cooldownMs)) {
      throw new Error(`"onGitCommit.cooldownMs" must be a number`);
    }
    if (gc.cooldownMs < MIN_COOLDOWN_MS) {
      gc.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onGitPush
  if (policy.onGitPush !== undefined) {
    const gp = policy.onGitPush;
    if (typeof gp !== "object" || gp === null) {
      throw new Error(`"onGitPush" must be an object`);
    }
    if (typeof gp.enabled !== "boolean") {
      throw new Error(`"onGitPush.enabled" must be a boolean`);
    }
    validatePromptSource("onGitPush", gp);
    if (typeof gp.cooldownMs !== "number" || !Number.isFinite(gp.cooldownMs)) {
      throw new Error(`"onGitPush.cooldownMs" must be a number`);
    }
    if (gp.cooldownMs < MIN_COOLDOWN_MS) {
      gp.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onGitPull
  if (policy.onGitPull !== undefined) {
    const gpl = policy.onGitPull;
    if (typeof gpl !== "object" || gpl === null) {
      throw new Error(`"onGitPull" must be an object`);
    }
    if (typeof gpl.enabled !== "boolean") {
      throw new Error(`"onGitPull.enabled" must be a boolean`);
    }
    validatePromptSource("onGitPull", gpl);
    if (
      typeof gpl.cooldownMs !== "number" ||
      !Number.isFinite(gpl.cooldownMs)
    ) {
      throw new Error(`"onGitPull.cooldownMs" must be a number`);
    }
    if (gpl.cooldownMs < MIN_COOLDOWN_MS) {
      gpl.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onBranchCheckout
  if (policy.onBranchCheckout !== undefined) {
    const bc = policy.onBranchCheckout;
    if (typeof bc !== "object" || bc === null) {
      throw new Error(`"onBranchCheckout" must be an object`);
    }
    if (typeof bc.enabled !== "boolean") {
      throw new Error(`"onBranchCheckout.enabled" must be a boolean`);
    }
    validatePromptSource("onBranchCheckout", bc);
    if (typeof bc.cooldownMs !== "number" || !Number.isFinite(bc.cooldownMs)) {
      throw new Error(`"onBranchCheckout.cooldownMs" must be a number`);
    }
    if (bc.cooldownMs < MIN_COOLDOWN_MS) {
      bc.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onPullRequest
  if (policy.onPullRequest !== undefined) {
    const pr = policy.onPullRequest;
    if (typeof pr !== "object" || pr === null) {
      throw new Error(`"onPullRequest" must be an object`);
    }
    if (typeof pr.enabled !== "boolean") {
      throw new Error(`"onPullRequest.enabled" must be a boolean`);
    }
    validatePromptSource("onPullRequest", pr);
    if (typeof pr.cooldownMs !== "number" || !Number.isFinite(pr.cooldownMs)) {
      throw new Error(`"onPullRequest.cooldownMs" must be a number`);
    }
    if (pr.cooldownMs < MIN_COOLDOWN_MS) {
      pr.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onTaskCreated
  if (policy.onTaskCreated !== undefined) {
    const tc = policy.onTaskCreated;
    if (typeof tc !== "object" || tc === null) {
      throw new Error(`"onTaskCreated" must be an object`);
    }
    if (typeof tc.enabled !== "boolean") {
      throw new Error(`"onTaskCreated.enabled" must be a boolean`);
    }
    validatePromptSource("onTaskCreated", tc);
    if (typeof tc.cooldownMs !== "number" || !Number.isFinite(tc.cooldownMs)) {
      throw new Error(`"onTaskCreated.cooldownMs" must be a number`);
    }
    if (tc.cooldownMs < MIN_COOLDOWN_MS) {
      tc.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onPermissionDenied
  if (policy.onPermissionDenied !== undefined) {
    const pd = policy.onPermissionDenied;
    if (typeof pd !== "object" || pd === null) {
      throw new Error(`"onPermissionDenied" must be an object`);
    }
    if (typeof pd.enabled !== "boolean") {
      throw new Error(`"onPermissionDenied.enabled" must be a boolean`);
    }
    validatePromptSource("onPermissionDenied", pd);
    if (typeof pd.cooldownMs !== "number" || !Number.isFinite(pd.cooldownMs)) {
      throw new Error(`"onPermissionDenied.cooldownMs" must be a number`);
    }
    if (pd.cooldownMs < MIN_COOLDOWN_MS) {
      pd.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onDiagnosticsCleared
  if (policy.onDiagnosticsCleared !== undefined) {
    const dc = policy.onDiagnosticsCleared;
    if (typeof dc !== "object" || dc === null) {
      throw new Error(`"onDiagnosticsCleared" must be an object`);
    }
    if (typeof dc.enabled !== "boolean") {
      throw new Error(`"onDiagnosticsCleared.enabled" must be a boolean`);
    }
    validatePromptSource("onDiagnosticsCleared", dc);
    if (typeof dc.cooldownMs !== "number" || !Number.isFinite(dc.cooldownMs)) {
      throw new Error(`"onDiagnosticsCleared.cooldownMs" must be a number`);
    }
    if (dc.cooldownMs < MIN_COOLDOWN_MS) {
      dc.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onTaskSuccess
  if (policy.onTaskSuccess !== undefined) {
    const ts = policy.onTaskSuccess;
    if (typeof ts !== "object" || ts === null) {
      throw new Error(`"onTaskSuccess" must be an object`);
    }
    if (typeof ts.enabled !== "boolean") {
      throw new Error(`"onTaskSuccess.enabled" must be a boolean`);
    }
    validatePromptSource("onTaskSuccess", ts);
    if (typeof ts.cooldownMs !== "number" || !Number.isFinite(ts.cooldownMs)) {
      throw new Error(`"onTaskSuccess.cooldownMs" must be a number`);
    }
    if (ts.cooldownMs < MIN_COOLDOWN_MS) {
      ts.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onDebugSessionStart
  if (policy.onDebugSessionStart !== undefined) {
    const dss = policy.onDebugSessionStart;
    if (typeof dss !== "object" || dss === null) {
      throw new Error(`"onDebugSessionStart" must be an object`);
    }
    if (typeof dss.enabled !== "boolean") {
      throw new Error(`"onDebugSessionStart.enabled" must be a boolean`);
    }
    validatePromptSource("onDebugSessionStart", dss);
    if (
      typeof dss.cooldownMs !== "number" ||
      !Number.isFinite(dss.cooldownMs)
    ) {
      throw new Error(`"onDebugSessionStart.cooldownMs" must be a number`);
    }
    if (dss.cooldownMs < MIN_COOLDOWN_MS) {
      dss.cooldownMs = MIN_COOLDOWN_MS;
    }
  }

  // Validate onDebugSessionEnd
  if (policy.onDebugSessionEnd !== undefined) {
    const dse = policy.onDebugSessionEnd;
    if (typeof dse !== "object" || dse === null) {
      throw new Error(`"onDebugSessionEnd" must be an object`);
    }
    if (typeof dse.enabled !== "boolean") {
      throw new Error(`"onDebugSessionEnd.enabled" must be a boolean`);
    }
    validatePromptSource("onDebugSessionEnd", dse);
    if (
      typeof dse.cooldownMs !== "number" ||
      !Number.isFinite(dse.cooldownMs)
    ) {
      throw new Error(`"onDebugSessionEnd.cooldownMs" must be a number`);
    }
    if (dse.cooldownMs < MIN_COOLDOWN_MS) {
      dse.cooldownMs = MIN_COOLDOWN_MS;
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
  /** Last trigger time per "trigger key" (e.g. "diagnostics:/path/to/file"). */
  private lastTrigger = new Map<string, number>();
  /**
   * Active task IDs per file for the diagnostics handler.
   * Kept separate from activeSaveTasks so a running save task does not suppress
   * the diagnostics trigger (and vice-versa) for the same file.
   */
  private activeDiagnosticsTasks = new Map<string, string>();
  /** Active task IDs per file for the file-saved handler. */
  private activeSaveTasks = new Map<string, string>();
  /** Active task IDs per file for the file-changed handler. */
  private activeFileChangedTasks = new Map<string, string>();
  /** Active task ID for the test-run handler (workspace-global). */
  private activeTestRunTaskId: string | null = null;
  /** Active task ID for the test-pass-after-failure handler (workspace-global). */
  private activeTestPassAfterFailureTaskId: string | null = null;
  /**
   * Per-runner last outcome — used to detect fail→pass transitions.
   * Key: runner name (e.g. "vitest", "jest"). Value: "pass" | "fail".
   * Stored separately per runner so a vitest pass doesn't incorrectly trigger
   * when a jest run was the one that previously failed.
   */
  private lastTestOutcomeByRunner = new Map<string, "pass" | "fail">();
  /** Active task ID for the git-commit handler (workspace-global). */
  private activeGitCommitTaskId: string | null = null;
  /** Active task ID for the git-push handler (workspace-global). */
  private activeGitPushTaskId: string | null = null;
  /** Active task ID for the git-pull handler (workspace-global). */
  private activeGitPullTaskId: string | null = null;
  /** Active task ID for the branch-checkout handler (workspace-global). */
  private activeBranchCheckoutTaskId: string | null = null;
  /** Active task ID for the pull-request handler (workspace-global). */
  private activePullRequestTaskId: string | null = null;
  /** Active task ID for the task-created handler (workspace-global). */
  private activeTaskCreatedTaskId: string | null = null;
  /** Active task ID for the permission-denied handler (workspace-global). */
  private activePermissionDeniedTaskId: string | null = null;
  /** Active task IDs per file for the diagnostics-cleared handler. */
  private activeDiagnosticsClearedTasks = new Map<string, string>();
  /** Tracks previous error count per normalized file path for zero-transition detection. */
  private prevDiagnosticErrors = new Map<string, number>();
  /** Latest diagnostics by file — used by _evaluateWhen() for conditional hooks. */
  private latestDiagnosticsByFile = new Map<string, Diagnostic[]>();
  /** Last test runner outcome per runner name — used by _evaluateWhen(). */
  private lastTestRunnerStatusByRunner = new Map<string, "passed" | "failed">();
  /** Active task ID for the task-success handler (workspace-global). */
  private activeTaskSuccessTaskId: string | null = null;
  /** Active task ID for the debug-session-end handler (workspace-global). */
  private activeDebugSessionEndTaskId: string | null = null;
  /** Active task ID for the debug-session-start handler (workspace-global). */
  private activeDebugSessionStartTaskId: string | null = null;
  /** Active task ID for the post-compact handler (workspace-global). */
  private activePostCompactTaskId: string | null = null;
  /** Active task ID for the pre-compact handler (workspace-global). */
  private activePreCompactTaskId: string | null = null;
  /** Active task ID for the instructions-loaded handler (workspace-global). */
  private activeInstructionsLoadedTaskId: string | null = null;
  /**
   * Rolling window of task enqueue timestamps for maxTasksPerHour enforcement.
   * Entries older than 60 minutes are pruned on each enqueue.
   */
  private taskTimestamps: number[] = [];

  constructor(
    private readonly policy: AutomationPolicy,
    private readonly orchestrator: ClaudeOrchestrator,
    private readonly log: (msg: string) => void,
    private readonly extensionClient?: ExtensionClient,
    private readonly workspace?: string,
  ) {}

  /**
   * Central enqueue for all automation-triggered tasks.
   * Applies defaultModel (Haiku by default) and enforces maxTasksPerHour.
   * Throws with the same "Task queue is full" message on rate-limit breach so
   * callers can handle it identically.
   */
  private _enqueueAutomationTask(opts: {
    prompt: string;
    triggerSource: string;
    hookCfg?: PromptSource;
    /** Internal: current retry attempt (0 = first try). */
    _retryAttempt?: number;
  }): string {
    const maxPerHour = this.policy.maxTasksPerHour ?? 20;
    if (maxPerHour > 0) {
      const now = Date.now();
      const cutoff = now - 60 * 60 * 1_000;
      // Prune old timestamps
      let i = 0;
      while (
        i < this.taskTimestamps.length &&
        (this.taskTimestamps[i] ?? 0) < cutoff
      )
        i++;
      if (i > 0) this.taskTimestamps.splice(0, i);
      if (this.taskTimestamps.length >= maxPerHour) {
        throw new Error(
          `Automation rate limit reached (max ${maxPerHour} tasks/hour)`,
        );
      }
    }

    const model =
      opts.hookCfg?.model ??
      this.policy.defaultModel ??
      "claude-haiku-4-5-20251001";
    const effort = opts.hookCfg?.effort ?? this.policy.defaultEffort ?? "low";
    const systemPrompt =
      this.policy.automationSystemPrompt ?? DEFAULT_AUTOMATION_SYSTEM_PROMPT;
    const taskId = this.orchestrator.enqueue({
      prompt: opts.prompt,
      sessionId: "",
      isAutomationTask: true,
      triggerSource: opts.triggerSource,
      model,
      effort,
      systemPrompt,
    });
    // Push timestamp only after successful enqueue so tasksThisHour never
    // diverges from the actual task row count (F3 phantom-increment fix).
    if (maxPerHour > 0) {
      this.taskTimestamps.push(Date.now());
    }

    // Schedule retry watcher if retryCount > 0.
    const retryCount = opts.hookCfg?.retryCount ?? 0;
    const retryAttempt = opts._retryAttempt ?? 0;
    if (retryCount > 0) {
      const retryDelayMs = Math.max(
        5_000,
        opts.hookCfg?.retryDelayMs ?? 30_000,
      );
      this._watchForRetry(taskId, opts, retryAttempt, retryCount, retryDelayMs);
    }

    return taskId;
  }

  /**
   * Poll a task until it reaches a terminal state. If the task ends with
   * status "error" and retries remain, re-enqueue after `retryDelayMs`.
   */
  private _watchForRetry(
    taskId: string,
    opts: { prompt: string; triggerSource: string; hookCfg?: PromptSource },
    retryAttempt: number,
    retryCount: number,
    retryDelayMs: number,
  ): void {
    const interval = setInterval(() => {
      const task = this.orchestrator.getTask(taskId);
      if (!task) {
        clearInterval(interval);
        return;
      }
      if (task.status === "pending" || task.status === "running") return;
      clearInterval(interval);
      if (task.status !== "error") return; // cancelled/done → no retry
      const nextAttempt = retryAttempt + 1;
      if (nextAttempt > retryCount) {
        this.log(
          `[automation] ${opts.triggerSource}: max retries (${retryCount}) reached, dropping`,
        );
        return;
      }
      this.log(
        `[automation] ${opts.triggerSource}: retry ${nextAttempt}/${retryCount} in ${retryDelayMs}ms`,
      );
      setTimeout(() => {
        try {
          this._enqueueAutomationTask({
            ...opts,
            _retryAttempt: nextAttempt,
          });
        } catch (e) {
          this.log(
            `[automation] ${opts.triggerSource}: retry enqueue failed: ${e}`,
          );
        }
      }, retryDelayMs);
    }, 2_000);
  }

  /**
   * Resolve a named prompt, substituting any `{{placeholder}}` tokens in
   * `promptArgs` values with sanitized event data before calling `getPrompt()`.
   *
   * Returns the resolved user-message text, or `null` if the prompt is unknown
   * or has missing required arguments.
   */
  private _resolveNamedPrompt(
    name: string,
    args: Record<string, string>,
    eventData: Record<string, string>,
  ): string | null {
    // Substitute event placeholders into promptArgs values.
    // Sanitize: strip control characters and cap length to prevent injection
    // via crafted file paths or branch names embedded in args.
    const resolvedArgs: Record<string, string> = {};
    for (const [k, v] of Object.entries(args)) {
      resolvedArgs[k] = v.replace(
        /\{\{(\w+)\}\}/g,
        (_match: string, placeholder: string) => {
          const raw = eventData[placeholder] ?? "";
          return raw
            .replace(/[\x00-\x1F\x7F]/g, "")
            .slice(0, MAX_FILE_PATH_CHARS);
        },
      );
    }
    const result = getPrompt(name, resolvedArgs);
    if (!result) {
      this.log(
        `[automation] promptName "${name}" could not be resolved — unknown prompt or missing required args`,
      );
      return null;
    }
    return result.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content.text)
      .join("\n\n");
  }

  /**
   * Evaluate the optional `when` condition block on a hook.
   * Called after _matchesCondition() succeeds and before cooldown checks.
   * Returns true if all specified conditions pass (or no `when` block present).
   */
  private _evaluateWhen(cfg: PromptSource, file?: string): boolean {
    const when = cfg.when;
    if (!when) return true;

    if (
      when.minDiagnosticCount !== undefined ||
      when.diagnosticsMinSeverity !== undefined
    ) {
      const diags =
        (file ? this.latestDiagnosticsByFile.get(file) : undefined) ?? [];
      if (
        when.minDiagnosticCount !== undefined &&
        diags.length < when.minDiagnosticCount
      ) {
        return false;
      }
      if (when.diagnosticsMinSeverity !== undefined) {
        const targetRank = when.diagnosticsMinSeverity === "error" ? 2 : 1;
        const severityRank: Record<string, number> = {
          error: 2,
          warning: 1,
          info: 0,
          information: 0,
          hint: 0,
        };
        const hasMatchingSeverity = diags.some(
          (d) => (severityRank[d.severity] ?? 0) >= targetRank,
        );
        if (!hasMatchingSeverity) return false;
      }
    }

    if (when.testRunnerLastStatus !== undefined) {
      // Check any runner's last status (wildcard: first match wins)
      const statuses = Array.from(this.lastTestRunnerStatusByRunner.values());
      if (statuses.length === 0) return false;
      const hasMatch = statuses.some((s) => s === when.testRunnerLastStatus);
      if (!hasMatch) return false;
    }

    return true;
  }

  private _matchesCondition(cfg: PromptSource, primaryValue: string): boolean {
    if (!cfg.condition) return true;
    const pattern = cfg.condition;
    // Support !-prefixed negation: "!**/*.test.ts" means "fire when NOT matching"
    if (pattern.startsWith("!")) {
      return !minimatch(primaryValue, pattern.slice(1), { dot: true });
    }
    return minimatch(primaryValue, pattern, { dot: true });
  }

  handleDiagnosticsChanged(file: string, diagnostics: Diagnostic[]): void {
    // Normalize path before any processing
    const normalizedFile = path.resolve(file);

    // Track error count for zero-transition detection (needed regardless of which hooks are enabled)
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
    // Keep latest diagnostics for _evaluateWhen() condition checks
    this.latestDiagnosticsByFile.set(normalizedFile, diagnostics);

    // Fire onDiagnosticsCleared if transitioning from non-zero → zero
    if (prevErrorCount > 0 && currentErrorCount === 0) {
      this.handleDiagnosticsCleared(normalizedFile);
    }

    const cfg = this.policy.onDiagnosticsError;
    if (!cfg?.enabled) return;

    // Condition filter
    if (!this._matchesCondition(cfg, normalizedFile)) return;
    if (!this._evaluateWhen(cfg, normalizedFile)) return;

    // Skip onDiagnosticsError if there are no errors to report
    if (currentErrorCount === 0) return;

    // Loop guard: skip if a task for this file is still pending/running
    const existingId = this.activeDiagnosticsTasks.get(normalizedFile);
    if (existingId) {
      const existing = this.orchestrator.getTask(existingId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping diagnostics trigger for ${normalizedFile} — task ${existingId.slice(0, 8)} still active`,
        );
        return;
      }
      // Prune stale entry for completed tasks
      this.activeDiagnosticsTasks.delete(normalizedFile);
    }

    // Severity filter
    const severityRank: Record<string, number> = {
      error: 2,
      warning: 1,
      info: 0,
      information: 0,
      hint: 0,
    };
    const minRank = severityRank[cfg.minSeverity] ?? 0;
    let matching = diagnostics.filter(
      (d) => (severityRank[d.severity] ?? 0) >= minRank,
    );
    if (matching.length === 0) return;

    // Optional diagnosticTypes filter: only fire for specific sources/codes
    if (cfg.diagnosticTypes && cfg.diagnosticTypes.length > 0) {
      const types = cfg.diagnosticTypes.map((t) => t.toLowerCase());
      matching = matching.filter(
        (d) =>
          (d.source && types.includes(d.source.toLowerCase())) ||
          (d.code !== undefined &&
            types.includes(String(d.code).toLowerCase())),
      );
      if (matching.length === 0) return;
    }

    // Cooldown check. When dedupeByContent is enabled, extend the key with a
    // diagnostic-content signature so identical LSP re-emissions collide but
    // genuinely different errors on the same file still trigger.
    let key = `diagnostics:${normalizedFile}`;
    let effectiveCooldownMs = cfg.cooldownMs;
    if (cfg.dedupeByContent) {
      const sig = diagnosticSignature(matching);
      key = `diagnostics:${normalizedFile}:${sig}`;
      effectiveCooldownMs = cfg.dedupeContentCooldownMs ?? 900_000;
    }
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < effectiveCooldownMs) {
      const remaining = effectiveCooldownMs - (now - last);
      if (cfg.dedupeByContent) {
        this.log(
          `[automation] dedupe suppressed onDiagnosticsError for ${normalizedFile} (${remaining}ms remaining, sig=${key.slice(-12)})`,
        );
      } else {
        this.log(
          `[automation] cooldown active for ${normalizedFile} (${remaining}ms remaining)`,
        );
      }
      return;
    }

    // Note: lastTrigger is set AFTER successful enqueue (below) so a failed
    // enqueue does not impose a spurious cooldown on the next trigger attempt.
    this._pruneLastTrigger(now);

    // Truncate file path and each diagnostic message to prevent prompt injection
    // via crafted file names or linter output embedding instruction-like content.
    // The diagnosticsText is placed between explicit delimiters in the prompt to
    // architecturally separate trusted policy instructions from untrusted data.
    const safeFilePath = normalizedFile.slice(0, MAX_FILE_PATH_CHARS);

    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        { file: safeFilePath },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const displayMatching = matching.slice(0, MAX_DIAGNOSTICS_IN_PROMPT);
      const omittedCount = matching.length - displayMatching.length;
      const diagnosticsText =
        displayMatching
          .map(
            (d) =>
              `[${d.severity}] ${d.message.slice(0, MAX_DIAGNOSTIC_MSG_CHARS)}`,
          )
          .join("\n") +
        (omittedCount > 0 ? `\n… and ${omittedCount} more` : "");
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "")
          .replace(
            /\{\{file\}\}/g,
            untrustedBlock("FILE PATH", safeFilePath, nonce),
          )
          .replace(
            /\{\{diagnostics\}\}/g,
            untrustedBlock("DIAGNOSTIC DATA", diagnosticsText, nonce),
          ) ?? "";
    }

    prompt = truncatePrompt(
      buildHookMetadata("onDiagnosticsError", normalizedFile) + prompt,
    );
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onDiagnosticsError",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeDiagnosticsTasks.set(normalizedFile, taskId);
      this.log(
        `[automation] triggered diagnostics task ${taskId.slice(0, 8)} for ${normalizedFile}`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue diagnostics task for ${normalizedFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Prune lastTrigger entries older than LAST_TRIGGER_MAX_AGE_MS to prevent unbounded growth. */
  private _pruneLastTrigger(now: number): void {
    for (const [k, t] of this.lastTrigger) {
      if (now - t > LAST_TRIGGER_MAX_AGE_MS) this.lastTrigger.delete(k);
    }
  }

  /**
   * Called when Claude Code fires a CwdChanged hook (Claude Code 2.1.83+).
   * Fires when CC's working directory changes — useful for re-snapshotting workspace context.
   */
  handleCwdChanged(newCwd: string): void {
    const cfg = this.policy.onCwdChanged;
    if (!cfg?.enabled) return;

    const safeCwdForCondition = newCwd.slice(0, MAX_FILE_PATH_CHARS);
    if (!this._matchesCondition(cfg, safeCwdForCondition)) return;

    // Cap path before using as map key to prevent unbounded map growth from
    // an extension sending unique paths rapidly.
    const safeCwd = newCwd.slice(0, MAX_FILE_PATH_CHARS);

    // Cooldown check — keyed on the capped cwd so switching between two known
    // directories doesn't bypass the global rate but each dir has its own window
    const key = `cwdChanged:${safeCwd}`;
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for cwd-changed ${newCwd} (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);
    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        { cwd: safeCwd },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "").replace(
          /\{\{cwd\}\}/g,
          untrustedBlock("CWD", safeCwd, nonce),
        ) ?? "";
    }
    prompt = truncatePrompt(buildHookMetadata("onCwdChanged") + prompt);
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onCwdChanged",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.log(
        `[automation] triggered cwd-changed task ${taskId.slice(0, 8)} for ${newCwd}`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue cwd-changed task for ${newCwd}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Called when Claude Code fires a PreCompact hook.
   * Fires the onPreCompact automation hook before context trimming — use to snapshot state or
   * write a handoff note before Claude loses context.
   */
  handlePreCompact(): void {
    const cfg = this.policy.onPreCompact;
    if (!cfg?.enabled) return;

    if (this.activePreCompactTaskId) {
      const existing = this.orchestrator.getTask(this.activePreCompactTaskId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping pre-compact trigger — task ${this.activePreCompactTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activePreCompactTaskId = null;
    }

    const key = "pre-compact";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for PreCompact (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    let preCompactPrompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        {},
      );
      if (resolved === null) return;
      preCompactPrompt = resolved;
    } else {
      preCompactPrompt = cfg.prompt ?? "";
    }
    preCompactPrompt = truncatePrompt(
      buildHookMetadata("onPreCompact") + preCompactPrompt,
    );
    try {
      const taskId = this._enqueueAutomationTask({
        prompt: preCompactPrompt,
        triggerSource: "onPreCompact",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activePreCompactTaskId = taskId;
      this.log(`[automation] triggered PreCompact task ${taskId.slice(0, 8)}`);
    } catch (err) {
      this.log(
        `[automation] failed to enqueue PreCompact task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Called when Claude Code fires a PostCompact hook (Claude Code 2.1.76+).
   * Re-enqueues the configured prompt so Claude can re-snapshot IDE state after losing context.
   */
  handlePostCompact(): void {
    const cfg = this.policy.onPostCompact;
    if (!cfg?.enabled) return;

    if (this.activePostCompactTaskId) {
      const existing = this.orchestrator.getTask(this.activePostCompactTaskId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping post-compact trigger — task ${this.activePostCompactTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activePostCompactTaskId = null;
    }

    const key = "post-compact";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for PostCompact (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    let postCompactPrompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        {},
      );
      if (resolved === null) return;
      postCompactPrompt = resolved;
    } else {
      postCompactPrompt = cfg.prompt ?? "";
    }
    postCompactPrompt = truncatePrompt(
      buildHookMetadata("onPostCompact") + postCompactPrompt,
    );
    try {
      const taskId = this._enqueueAutomationTask({
        prompt: postCompactPrompt,
        triggerSource: "onPostCompact",
        hookCfg: cfg,
      });
      // Set lastTrigger AFTER successful enqueue so a failed enqueue does not
      // impose a spurious cooldown on the next trigger attempt.
      this.lastTrigger.set(key, now);
      this.activePostCompactTaskId = taskId;
      this.log(`[automation] triggered PostCompact task ${taskId.slice(0, 8)}`);
    } catch (err) {
      this.log(
        `[automation] failed to enqueue PostCompact task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Called when Claude Code fires an InstructionsLoaded hook (Claude Code 2.1.76+).
   * Fires once per session; injects bridge status / tool capability summary at start.
   */
  handleInstructionsLoaded(): void {
    const cfg = this.policy.onInstructionsLoaded;
    if (!cfg?.enabled) return;

    if (this.activeInstructionsLoadedTaskId) {
      const existing = this.orchestrator.getTask(
        this.activeInstructionsLoadedTaskId,
      );
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping instructions-loaded trigger — task ${this.activeInstructionsLoadedTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activeInstructionsLoadedTaskId = null;
    }

    // Cross-hook cascade guard: each automation subprocess fires the
    // InstructionsLoaded CC hook when it starts, which would spawn a second
    // onInstructionsLoaded task without this check.  Suppress if any
    // automation task is currently pending or running.
    const anyAutomationActive = this.orchestrator
      .list()
      .some(
        (t) =>
          t.isAutomationTask &&
          (t.status === "pending" || t.status === "running"),
      );
    if (anyAutomationActive) {
      this.log(
        "[automation] skipping instructions-loaded trigger — another automation task is active (cascade guard)",
      );
      return;
    }

    const cooldownMs = cfg.cooldownMs ?? 60_000;
    const key = "instructions-loaded";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cooldownMs) {
      this.log(
        `[automation] cooldown active for InstructionsLoaded (${cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    let instrPrompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        {},
      );
      if (resolved === null) return;
      instrPrompt = resolved;
    } else {
      instrPrompt = cfg.prompt ?? "";
    }
    instrPrompt = truncatePrompt(
      buildHookMetadata("onInstructionsLoaded") + instrPrompt,
    );
    try {
      const taskId = this._enqueueAutomationTask({
        prompt: instrPrompt,
        triggerSource: "onInstructionsLoaded",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeInstructionsLoadedTaskId = taskId;
      this.log(
        `[automation] triggered InstructionsLoaded task ${taskId.slice(0, 8)}`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue InstructionsLoaded task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  handleFileSaved(_id: string, type: string, file: string): void {
    const cfg = this.policy.onFileSave;
    if (!cfg?.enabled) return;
    if (type !== "save") return;

    // Normalize path to prevent loop-guard bypass via equivalent paths
    const normalizedFile = path.resolve(file);

    // Condition filter
    if (!this._matchesCondition(cfg, normalizedFile)) return;
    if (!this._evaluateWhen(cfg, normalizedFile)) return;

    // Pattern matching — also try workspace-relative path so patterns like
    // "src/**/*.ts" work when VS Code sends absolute paths.
    const relFile =
      this.workspace && path.isAbsolute(normalizedFile)
        ? path.relative(this.workspace, normalizedFile)
        : normalizedFile;
    const matched = cfg.patterns.some(
      (pattern) =>
        minimatch(normalizedFile, pattern, { dot: true }) ||
        (relFile !== normalizedFile &&
          minimatch(relFile, pattern, { dot: true })),
    );
    if (!matched) return;

    // Loop guard
    const existingId = this.activeSaveTasks.get(normalizedFile);
    if (existingId) {
      const existing = this.orchestrator.getTask(existingId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping save trigger for ${normalizedFile} — task ${existingId.slice(0, 8)} still active`,
        );
        return;
      }
      // Prune stale entry for completed tasks
      this.activeSaveTasks.delete(normalizedFile);
    }

    // Cooldown check
    const key = `save:${normalizedFile}`;
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for save ${normalizedFile} (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeFilePath = normalizedFile.slice(0, MAX_FILE_PATH_CHARS);
    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        { file: safeFilePath },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "").replace(
          /\{\{file\}\}/g,
          untrustedBlock("FILE PATH", safeFilePath, nonce),
        ) ?? "";
    }
    prompt = truncatePrompt(
      buildHookMetadata("onFileSave", normalizedFile) + prompt,
    );
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onFileSave",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeSaveTasks.set(normalizedFile, taskId);
      this.log(
        `[automation] triggered onFileSave task ${taskId.slice(0, 8)} for ${normalizedFile}`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue save task for ${normalizedFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Called when the VS Code extension reports a file-changed event (type === "change").
   * Distinct from handleFileSaved — reacts to any editor buffer change, not just explicit saves.
   * Useful for triggering tasks on unsaved edits (e.g. lint-as-you-type workflows).
   */
  handleFileChanged(_id: string, type: string, file: string): void {
    const cfg = this.policy.onFileChanged;
    if (!cfg?.enabled) return;
    if (type !== "change") return;

    const normalizedFile = path.resolve(file);

    // Condition filter
    if (!this._matchesCondition(cfg, normalizedFile)) return;

    // Pattern matching — also try workspace-relative path so patterns like
    // "src/**/*.ts" work when VS Code sends absolute paths.
    const relFile =
      this.workspace && path.isAbsolute(normalizedFile)
        ? path.relative(this.workspace, normalizedFile)
        : normalizedFile;
    const matched = cfg.patterns.some(
      (pattern) =>
        minimatch(normalizedFile, pattern, { dot: true }) ||
        (relFile !== normalizedFile &&
          minimatch(relFile, pattern, { dot: true })),
    );
    if (!matched) return;

    // Loop guard
    const existingId = this.activeFileChangedTasks.get(normalizedFile);
    if (existingId) {
      const existing = this.orchestrator.getTask(existingId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping file-changed trigger for ${normalizedFile} — task ${existingId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activeFileChangedTasks.delete(normalizedFile);
    }

    // Cooldown check
    const key = `fileChanged:${normalizedFile}`;
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for file-changed ${normalizedFile} (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeFilePath = normalizedFile.slice(0, MAX_FILE_PATH_CHARS);
    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        { file: safeFilePath },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "").replace(
          /\{\{file\}\}/g,
          untrustedBlock("FILE PATH", safeFilePath, nonce),
        ) ?? "";
    }
    prompt = truncatePrompt(
      buildHookMetadata("onFileChanged", normalizedFile) + prompt,
    );
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onFileChanged",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeFileChangedTasks.set(normalizedFile, taskId);
      this.log(
        `[automation] triggered file-changed task ${taskId.slice(0, 8)} for ${normalizedFile}`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue file-changed task for ${normalizedFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Called after every runTests tool invocation completes.
   * Triggers an automation task when tests fail (or on every run if onFailureOnly is false).
   */
  handleTestRun(result: TestRunResult): void {
    const failureCount = result.summary.failed + result.summary.errored;

    // Update per-runner outcome state unconditionally so onTestPassAfterFailure
    // can detect fail→pass transitions even when onTestRun is disabled/absent.
    const testStatus = failureCount === 0 ? "passed" : "failed";
    for (const runner of result.runners) {
      const prev = this.lastTestOutcomeByRunner.get(runner);
      const current = failureCount === 0 ? "pass" : "fail";
      this.lastTestOutcomeByRunner.set(runner, current);
      // Update lastTestRunnerStatusByRunner for _evaluateWhen() condition checks
      this.lastTestRunnerStatusByRunner.set(runner, testStatus);
      if (prev === "fail" && current === "pass") {
        this._handleTestPassAfterFailure(result, runner);
      }
    }

    const cfg = this.policy.onTestRun;
    if (!cfg?.enabled) return;

    // Honour onFailureOnly: skip trigger when all tests pass
    if (cfg.onFailureOnly && failureCount === 0) return;

    // Skip if test run was shorter than the configured minimum duration
    // Only skip when durationMs is known and below the threshold.
    // If durationMs is absent (runner didn't report timing), let the hook fire —
    // silently suppressing based on missing data would be surprising behaviour.
    if (
      cfg.minDuration !== undefined &&
      result.summary.durationMs !== undefined &&
      result.summary.durationMs < cfg.minDuration
    ) {
      this.log(
        `[automation] skipping test-run trigger — duration ${result.summary.durationMs}ms < minDuration ${cfg.minDuration}ms`,
      );
      return;
    }

    // Evaluate optional when condition
    if (!this._evaluateWhen(cfg)) return;

    // Loop guard: skip if a task is still pending/running
    if (this.activeTestRunTaskId) {
      const existing = this.orchestrator.getTask(this.activeTestRunTaskId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping test-run trigger — task ${this.activeTestRunTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activeTestRunTaskId = null;
    }

    // Cooldown check (workspace-global key)
    const key = "testRun:global";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for test-run (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const runnerStr = result.runners.join(", ") || "unknown";
    const failureLines = result.failures
      .slice(0, 10)
      .map((f) => {
        const loc = f.file ? ` (${f.file.slice(0, MAX_FILE_PATH_CHARS)})` : "";
        const msg = f.message
          ? `: ${f.message.slice(0, MAX_DIAGNOSTIC_MSG_CHARS)}`
          : "";
        return `- ${f.name}${loc}${msg}`;
      })
      .join("\n");
    const failuresText =
      result.failures.length > 10
        ? `${failureLines}\n… and ${result.failures.length - 10} more`
        : failureLines;

    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        {
          runner: runnerStr,
          failed: String(failureCount),
          passed: String(result.summary.passed),
          total: String(result.summary.total),
        },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "")
          .replace(
            /\{\{runner\}\}/g,
            untrustedBlock("TEST RUNNER", runnerStr, nonce),
          )
          .replace(/\{\{failed\}\}/g, String(failureCount))
          .replace(/\{\{passed\}\}/g, String(result.summary.passed))
          .replace(/\{\{total\}\}/g, String(result.summary.total))
          .replace(
            /\{\{failures\}\}/g,
            untrustedBlock("TEST FAILURES", failuresText, nonce),
          ) ?? "";
    }

    prompt = truncatePrompt(buildHookMetadata("onTestRun") + prompt);
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onTestRun",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeTestRunTaskId = taskId;
      this.log(
        `[automation] triggered test-run task ${taskId.slice(0, 8)} (${failureCount} failure(s))`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue test-run task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Internal — fires onTestPassAfterFailure when a specific runner transitions
   * from failing → passing. Called from handleTestRun after outcome state update.
   */
  private _handleTestPassAfterFailure(
    result: TestRunResult,
    runner: string,
  ): void {
    const cfg = this.policy.onTestPassAfterFailure;
    if (!cfg?.enabled) return;

    // Loop guard: skip if a task is still pending/running
    if (this.activeTestPassAfterFailureTaskId) {
      const existing = this.orchestrator.getTask(
        this.activeTestPassAfterFailureTaskId,
      );
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping test-pass-after-failure — task ${this.activeTestPassAfterFailureTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activeTestPassAfterFailureTaskId = null;
    }

    // Cooldown check (workspace-global key)
    const key = "testPassAfterFailure:global";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for test-pass-after-failure (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        {
          runner,
          passed: String(result.summary.passed),
          total: String(result.summary.total),
        },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "")
          .replace(
            /\{\{runner\}\}/g,
            untrustedBlock("TEST RUNNER", runner, nonce),
          )
          .replace(/\{\{passed\}\}/g, String(result.summary.passed))
          .replace(/\{\{total\}\}/g, String(result.summary.total)) ?? "";
    }

    prompt = truncatePrompt(
      buildHookMetadata("onTestPassAfterFailure") + prompt,
    );
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onTestPassAfterFailure",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeTestPassAfterFailureTaskId = taskId;
      this.log(
        `[automation] triggered test-pass-after-failure task ${taskId.slice(0, 8)} (runner: ${runner})`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue test-pass-after-failure task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Called after a successful gitCommit tool call.
   * Fires the onGitCommit automation hook if configured.
   */
  async handleGitCommit(result: GitCommitResult): Promise<void> {
    const cfg = this.policy.onGitCommit;
    if (!cfg?.enabled) return;

    if (!this._matchesCondition(cfg, result.branch)) return;

    // Loop guard: skip if a task is still pending/running
    if (this.activeGitCommitTaskId) {
      const existing = this.orchestrator.getTask(this.activeGitCommitTaskId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping git-commit trigger — task ${this.activeGitCommitTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activeGitCommitTaskId = null;
    }

    // Cooldown check (workspace-global)
    const key = "gitCommit:global";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for git-commit (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeHash = result.hash.slice(0, 64);
    const safeBranchCommit = result.branch.slice(0, MAX_FILE_PATH_CHARS);
    const safeMessage = result.message.slice(0, MAX_DIAGNOSTIC_MSG_CHARS);
    const fileList = result.files
      .slice(0, 20)
      .map((f) => `- ${f.slice(0, MAX_FILE_PATH_CHARS)}`)
      .join("\n");
    const filesText =
      result.files.length > 20
        ? `${fileList}\n… and ${result.files.length - 20} more`
        : fileList;

    // B1: Fetch changeImpact if extensionClient is connected and files exist
    // Uses getDiagnostics as a lightweight proxy: summarizes error/warning count
    // across changed files as a blast-radius indicator.
    let changeImpact: string | undefined;
    if (this.extensionClient?.isConnected() && result.files.length > 0) {
      try {
        const diagResult = await Promise.race([
          this.extensionClient.getDiagnostics(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ]);
        if (diagResult) {
          const diagArr = Array.isArray(diagResult) ? diagResult : [];
          const errorCount = diagArr.filter(
            (d: { severity?: string }) =>
              d.severity === "error" || d.severity === "warning",
          ).length;
          changeImpact = `${result.count} file(s) changed; ${errorCount} diagnostic(s) in workspace`;
        }
      } catch {
        // best-effort — changeImpact remains undefined
      }
    }

    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        {
          hash: safeHash,
          branch: safeBranchCommit,
          message: safeMessage,
          count: String(result.count),
        },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "")
          .replace(
            /\{\{hash\}\}/g,
            untrustedBlock("COMMIT HASH", safeHash, nonce),
          )
          .replace(
            /\{\{branch\}\}/g,
            untrustedBlock("BRANCH", safeBranchCommit, nonce),
          )
          .replace(
            /\{\{message\}\}/g,
            untrustedBlock("COMMIT MESSAGE", safeMessage, nonce),
          )
          .replace(
            /\{\{count\}\}/g,
            untrustedBlock("COMMIT COUNT", String(result.count), nonce),
          )
          .replace(
            /\{\{files\}\}/g,
            untrustedBlock("COMMITTED FILES", filesText, nonce),
          )
          .replace(
            /\{\{changeImpact\}\}/g,
            changeImpact
              ? untrustedBlock("CHANGE IMPACT", changeImpact, nonce)
              : "(change impact unavailable)",
          ) ?? "";
    }

    prompt = truncatePrompt(buildHookMetadata("onGitCommit") + prompt);
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onGitCommit",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeGitCommitTaskId = taskId;
      this.log(
        `[automation] triggered git-commit task ${taskId.slice(0, 8)} (hash: ${result.hash}, ${result.count} file(s))`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue git-commit task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Called after a successful gitPush tool call.
   * Fires the onGitPush automation hook if configured.
   */
  handleGitPush(result: GitPushResult): void {
    const cfg = this.policy.onGitPush;
    if (!cfg?.enabled) return;

    if (!this._matchesCondition(cfg, result.branch)) return;

    // Loop guard: skip if a task is still pending/running
    if (this.activeGitPushTaskId) {
      const existing = this.orchestrator.getTask(this.activeGitPushTaskId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping git-push trigger — task ${this.activeGitPushTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activeGitPushTaskId = null;
    }

    // Cooldown check (workspace-global)
    const key = "gitPush:global";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for git-push (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeRemote = result.remote.slice(0, MAX_FILE_PATH_CHARS);
    const safeBranch = result.branch.slice(0, MAX_FILE_PATH_CHARS);
    const safeHash = result.hash.slice(0, 64);
    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        { remote: safeRemote, branch: safeBranch, hash: safeHash },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "")
          .replace(
            /\{\{remote\}\}/g,
            untrustedBlock("REMOTE", safeRemote, nonce),
          )
          .replace(
            /\{\{branch\}\}/g,
            untrustedBlock("BRANCH", safeBranch, nonce),
          )
          .replace(
            /\{\{hash\}\}/g,
            untrustedBlock("COMMIT HASH", safeHash, nonce),
          ) ?? "";
    }
    prompt = truncatePrompt(buildHookMetadata("onGitPush") + prompt);

    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onGitPush",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeGitPushTaskId = taskId;
      this.log(
        `[automation] triggered git-push task ${taskId.slice(0, 8)} (${result.remote}/${result.branch} @ ${result.hash})`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue git-push task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Fires the onGitPull automation hook if configured.
   */
  handleGitPull(result: GitPullResult): void {
    const cfg = this.policy.onGitPull;
    if (!cfg?.enabled) return;

    if (!this._matchesCondition(cfg, result.branch)) return;

    // Loop guard: skip if a task is still pending/running
    if (this.activeGitPullTaskId) {
      const existing = this.orchestrator.getTask(this.activeGitPullTaskId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping git-pull trigger — task ${this.activeGitPullTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activeGitPullTaskId = null;
    }

    // Cooldown check (workspace-global)
    const key = "gitPull:global";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for git-pull (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeRemote = result.remote.slice(0, MAX_FILE_PATH_CHARS);
    const safeBranch = result.branch.slice(0, MAX_FILE_PATH_CHARS);
    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        { remote: safeRemote, branch: safeBranch },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "")
          .replace(
            /\{\{remote\}\}/g,
            untrustedBlock("REMOTE", safeRemote, nonce),
          )
          .replace(
            /\{\{branch\}\}/g,
            untrustedBlock("BRANCH", safeBranch, nonce),
          ) ?? "";
    }
    prompt = truncatePrompt(buildHookMetadata("onGitPull") + prompt);

    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onGitPull",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeGitPullTaskId = taskId;
      this.log(
        `[automation] triggered git-pull task ${taskId.slice(0, 8)} (${result.remote}/${result.branch}, alreadyUpToDate=${result.alreadyUpToDate})`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue git-pull task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Called after a successful gitCheckout tool call.
   * Fires the onBranchCheckout automation hook if configured.
   */
  handleBranchCheckout(result: BranchCheckoutResult): void {
    const cfg = this.policy.onBranchCheckout;
    if (!cfg?.enabled) return;

    if (!this._matchesCondition(cfg, result.branch)) return;

    // Loop guard: skip if a task is still pending/running
    if (this.activeBranchCheckoutTaskId) {
      const existing = this.orchestrator.getTask(
        this.activeBranchCheckoutTaskId,
      );
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping branch-checkout trigger — task ${this.activeBranchCheckoutTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activeBranchCheckoutTaskId = null;
    }

    // Cooldown check (workspace-global)
    const key = "branchCheckout:global";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for branch-checkout (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeBranch = result.branch.slice(0, MAX_FILE_PATH_CHARS);
    const safePreviousBranch = (
      result.previousBranch ?? "(detached HEAD)"
    ).slice(0, MAX_FILE_PATH_CHARS);
    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        {
          branch: safeBranch,
          previousBranch: safePreviousBranch,
          created: String(result.created),
        },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "")
          .replace(
            /\{\{branch\}\}/g,
            untrustedBlock("BRANCH", safeBranch, nonce),
          )
          .replace(
            /\{\{previousBranch\}\}/g,
            untrustedBlock("PREVIOUS BRANCH", safePreviousBranch, nonce),
          )
          .replace(/\{\{created\}\}/g, String(result.created)) ?? "";
    }
    prompt = truncatePrompt(buildHookMetadata("onBranchCheckout") + prompt);

    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onBranchCheckout",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeBranchCheckoutTaskId = taskId;
      this.log(
        `[automation] triggered branch-checkout task ${taskId.slice(0, 8)} (${result.created ? "created" : "switched to"} ${result.branch})`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue branch-checkout task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Fires the onPullRequest automation hook if configured.
   */
  handlePullRequest(result: PullRequestResult): void {
    const cfg = this.policy.onPullRequest;
    if (!cfg?.enabled) return;

    if (!this._matchesCondition(cfg, result.branch)) return;

    // Loop guard: skip if a task is still pending/running
    if (this.activePullRequestTaskId) {
      const existing = this.orchestrator.getTask(this.activePullRequestTaskId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping pull-request trigger — task ${this.activePullRequestTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activePullRequestTaskId = null;
    }

    const key = "pullRequest:global";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] skipping pull-request trigger — cooldown active (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeUrl = result.url.slice(0, MAX_FILE_PATH_CHARS);
    const safeTitle = result.title.slice(0, MAX_DIAGNOSTIC_MSG_CHARS);
    const safeBranch = result.branch.slice(0, MAX_FILE_PATH_CHARS);
    const safeNumber =
      result.number !== null ? String(result.number) : "(unknown)";
    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        {
          url: safeUrl,
          title: safeTitle,
          branch: safeBranch,
          number: safeNumber,
        },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "")
          .replace(/\{\{url\}\}/g, untrustedBlock("PR URL", safeUrl, nonce))
          .replace(/\{\{number\}\}/g, safeNumber)
          .replace(
            /\{\{title\}\}/g,
            untrustedBlock("PR TITLE", safeTitle, nonce),
          )
          .replace(
            /\{\{branch\}\}/g,
            untrustedBlock("BRANCH", safeBranch, nonce),
          ) ?? "";
    }

    prompt = truncatePrompt(buildHookMetadata("onPullRequest") + prompt);
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onPullRequest",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activePullRequestTaskId = taskId;
      this.log(
        `[automation] triggered pull-request task ${taskId.slice(0, 8)} (PR #${result.number ?? "?"}: ${result.title})`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue pull-request task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  handleTaskCreated(result: TaskCreatedResult): void {
    const cfg = this.policy.onTaskCreated;
    if (!cfg?.enabled) return;

    if (!this._matchesCondition(cfg, result.taskId)) return;

    if (this.activeTaskCreatedTaskId) {
      const existing = this.orchestrator.getTask(this.activeTaskCreatedTaskId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping task-created trigger — task ${this.activeTaskCreatedTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activeTaskCreatedTaskId = null;
    }

    const key = "taskCreated:global";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] skipping task-created trigger — cooldown active (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeTaskId = result.taskId.slice(0, MAX_FILE_PATH_CHARS);
    const safePrompt = result.prompt.slice(0, MAX_DIAGNOSTIC_MSG_CHARS);
    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        { taskId: safeTaskId, prompt: safePrompt },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "")
          .replace(
            /\{\{taskId\}\}/g,
            untrustedBlock("TASK ID", safeTaskId, nonce),
          )
          .replace(
            /\{\{prompt\}\}/g,
            untrustedBlock("TASK PROMPT", safePrompt, nonce),
          ) ?? "";
    }

    prompt = truncatePrompt(buildHookMetadata("onTaskCreated") + prompt);
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onTaskCreated",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeTaskCreatedTaskId = taskId;
      this.log(
        `[automation] triggered task-created task ${taskId.slice(0, 8)} (spawned task: ${result.taskId.slice(0, 8)})`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue task-created task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  handlePermissionDenied(result: PermissionDeniedResult): void {
    const cfg = this.policy.onPermissionDenied;
    if (!cfg?.enabled) return;

    if (!this._matchesCondition(cfg, result.tool)) return;

    if (this.activePermissionDeniedTaskId) {
      const existing = this.orchestrator.getTask(
        this.activePermissionDeniedTaskId,
      );
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping permission-denied trigger — task ${this.activePermissionDeniedTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activePermissionDeniedTaskId = null;
    }

    const key = "permissionDenied:global";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] skipping permission-denied trigger — cooldown active (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeTool = result.tool.slice(0, MAX_FILE_PATH_CHARS);
    const safeReason = result.reason.slice(0, MAX_DIAGNOSTIC_MSG_CHARS);
    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        { tool: safeTool, reason: safeReason },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "")
          .replace(
            /\{\{tool\}\}/g,
            untrustedBlock("TOOL NAME", safeTool, nonce),
          )
          .replace(
            /\{\{reason\}\}/g,
            untrustedBlock("DENIAL REASON", safeReason, nonce),
          ) ?? "";
    }

    prompt = truncatePrompt(buildHookMetadata("onPermissionDenied") + prompt);
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onPermissionDenied",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activePermissionDeniedTaskId = taskId;
      this.log(
        `[automation] triggered permission-denied task ${taskId.slice(0, 8)} (tool: ${result.tool})`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue permission-denied task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Fires the onDiagnosticsCleared hook when a file transitions from non-zero to zero errors.
   * Called internally by handleDiagnosticsChanged.
   */
  handleDiagnosticsCleared(normalizedFile: string): void {
    const cfg = this.policy.onDiagnosticsCleared;
    if (!cfg?.enabled) return;

    if (!this._matchesCondition(cfg, normalizedFile)) return;

    // Loop guard: skip if a task for this file is still pending/running
    const existingId = this.activeDiagnosticsClearedTasks.get(normalizedFile);
    if (existingId) {
      const existing = this.orchestrator.getTask(existingId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping diagnostics-cleared trigger for ${normalizedFile} — task ${existingId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activeDiagnosticsClearedTasks.delete(normalizedFile);
    }

    const key = `diagnosticsCleared:${normalizedFile}`;
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for diagnostics-cleared ${normalizedFile} (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeFilePath = normalizedFile.slice(0, MAX_FILE_PATH_CHARS);
    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        { file: safeFilePath },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "").replace(
          /\{\{file\}\}/g,
          untrustedBlock("FILE PATH", safeFilePath, nonce),
        ) ?? "";
    }

    prompt = truncatePrompt(
      buildHookMetadata("onDiagnosticsCleared", normalizedFile) + prompt,
    );
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onDiagnosticsCleared",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeDiagnosticsClearedTasks.set(normalizedFile, taskId);
      this.log(
        `[automation] triggered diagnostics-cleared task ${taskId.slice(0, 8)} for ${normalizedFile}`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue diagnostics-cleared task for ${normalizedFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Fires the onTaskSuccess hook when a Claude orchestrator task completes with status "done".
   * Call from bridge.ts when a task transitions to done.
   */
  handleTaskSuccess(result: TaskSuccessResult): void {
    const cfg = this.policy.onTaskSuccess;
    if (!cfg?.enabled) return;

    if (!this._matchesCondition(cfg, result.taskId)) return;

    // Loop guard: skip if a prior task-success task is still active
    if (this.activeTaskSuccessTaskId) {
      const existing = this.orchestrator.getTask(this.activeTaskSuccessTaskId);
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping task-success trigger — task ${this.activeTaskSuccessTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activeTaskSuccessTaskId = null;
    }

    const key = "taskSuccess:global";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] skipping task-success trigger — cooldown active (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeTaskId = result.taskId.slice(0, MAX_FILE_PATH_CHARS);
    const safeOutput = result.output.slice(0, 500);
    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        { taskId: safeTaskId, output: safeOutput },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "")
          .replace(
            /\{\{taskId\}\}/g,
            untrustedBlock("TASK ID", safeTaskId, nonce),
          )
          .replace(
            /\{\{output\}\}/g,
            untrustedBlock("TASK OUTPUT", safeOutput, nonce),
          ) ?? "";
    }

    prompt = truncatePrompt(buildHookMetadata("onTaskSuccess") + prompt);
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onTaskSuccess",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeTaskSuccessTaskId = taskId;
      this.log(
        `[automation] triggered task-success task ${taskId.slice(0, 8)} (completed task: ${result.taskId.slice(0, 8)})`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue task-success task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Called when a VS Code debug session ends (hasActiveSession transitions true→false).
   * Fires the onDebugSessionEnd automation hook if configured.
   */
  async handleDebugSessionEnd(result: DebugSessionEndResult): Promise<void> {
    const cfg = this.policy.onDebugSessionEnd;
    if (!cfg?.enabled) return;

    // Loop guard: skip if a task is still pending/running
    if (this.activeDebugSessionEndTaskId) {
      const existing = this.orchestrator.getTask(
        this.activeDebugSessionEndTaskId,
      );
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping debug-session-end trigger — task ${this.activeDebugSessionEndTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activeDebugSessionEndTaskId = null;
    }

    // Cooldown check (workspace-global)
    const key = "debugSessionEnd:global";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for debug-session-end (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeSessionName = result.sessionName.slice(0, MAX_FILE_PATH_CHARS);
    const safeSessionType = result.sessionType.slice(0, MAX_FILE_PATH_CHARS);

    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        {
          sessionName: safeSessionName,
          sessionType: safeSessionType,
        },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "")
          .replace(
            /\{\{sessionName\}\}/g,
            untrustedBlock("SESSION NAME", safeSessionName, nonce),
          )
          .replace(
            /\{\{sessionType\}\}/g,
            untrustedBlock("SESSION TYPE", safeSessionType, nonce),
          ) ?? "";
    }

    prompt = truncatePrompt(buildHookMetadata("onDebugSessionEnd") + prompt);
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onDebugSessionEnd",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeDebugSessionEndTaskId = taskId;
      this.log(
        `[automation] triggered debug-session-end task ${taskId.slice(0, 8)} (session: ${result.sessionName}, type: ${result.sessionType})`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue debug-session-end task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Called when a VS Code debug session starts (hasActiveSession transitions false→true).
   * Fires the onDebugSessionStart automation hook if configured.
   */
  async handleDebugSessionStart(
    result: DebugSessionStartResult,
  ): Promise<void> {
    const cfg = this.policy.onDebugSessionStart;
    if (!cfg?.enabled) return;

    // Loop guard: skip if a task is still pending/running
    if (this.activeDebugSessionStartTaskId) {
      const existing = this.orchestrator.getTask(
        this.activeDebugSessionStartTaskId,
      );
      if (
        existing &&
        (existing.status === "pending" || existing.status === "running")
      ) {
        this.log(
          `[automation] skipping debug-session-start trigger — task ${this.activeDebugSessionStartTaskId.slice(0, 8)} still active`,
        );
        return;
      }
      this.activeDebugSessionStartTaskId = null;
    }

    // Cooldown check (workspace-global)
    const key = "debugSessionStart:global";
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for debug-session-start (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeSessionName = result.sessionName.slice(0, MAX_FILE_PATH_CHARS);
    const safeSessionType = result.sessionType.slice(0, MAX_FILE_PATH_CHARS);
    const safeActiveFile = result.activeFile.slice(0, MAX_FILE_PATH_CHARS);
    const breakpointCount = String(result.breakpointCount);

    let prompt: string;
    if (cfg.promptName) {
      const resolved = this._resolveNamedPrompt(
        cfg.promptName,
        cfg.promptArgs ?? {},
        {
          sessionName: safeSessionName,
          sessionType: safeSessionType,
          activeFile: safeActiveFile,
          breakpointCount,
        },
      );
      if (resolved === null) return;
      prompt = resolved;
    } else {
      const nonce = crypto.randomBytes(6).toString("hex");
      prompt =
        (cfg.prompt ?? "")
          .replace(
            /\{\{sessionName\}\}/g,
            untrustedBlock("SESSION NAME", safeSessionName, nonce),
          )
          .replace(
            /\{\{sessionType\}\}/g,
            untrustedBlock("SESSION TYPE", safeSessionType, nonce),
          )
          .replace(
            /\{\{activeFile\}\}/g,
            untrustedBlock("ACTIVE FILE", safeActiveFile, nonce),
          )
          .replace(/\{\{breakpointCount\}\}/g, breakpointCount) ?? "";
    }

    prompt = truncatePrompt(buildHookMetadata("onDebugSessionStart") + prompt);
    try {
      const taskId = this._enqueueAutomationTask({
        prompt,
        triggerSource: "onDebugSessionStart",
        hookCfg: cfg,
      });
      this.lastTrigger.set(key, now);
      this.activeDebugSessionStartTaskId = taskId;
      this.log(
        `[automation] triggered debug-session-start task ${taskId.slice(0, 8)} (session: ${result.sessionName}, type: ${result.sessionType}, breakpoints: ${result.breakpointCount})`,
      );
    } catch (err) {
      this.log(
        `[automation] failed to enqueue debug-session-start task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
            onFailureOnly: p.onTestRun.onFailureOnly,
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
      tasksThisHour: this.taskTimestamps.filter(
        (t) => t >= Date.now() - 60 * 60 * 1_000,
      ).length,
      defaultEffort: p.defaultEffort ?? "low",
      automationSystemPrompt: (
        p.automationSystemPrompt ?? DEFAULT_AUTOMATION_SYSTEM_PROMPT
      ).slice(0, 80),
    };
  }
}
