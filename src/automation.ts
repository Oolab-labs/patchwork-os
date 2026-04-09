import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import type { ClaudeOrchestrator } from "./claudeOrchestrator.js";
import { getPrompt } from "./prompts.js";

/** Maximum length (chars) of a single diagnostic message before truncation */
const MAX_DIAGNOSTIC_MSG_CHARS = 500;

/**
 * Wrap an untrusted user-controlled value in delimiters that include a
 * per-trigger nonce so a crafted value cannot forge a closing delimiter.
 * The nonce is stripped from the value itself before insertion.
 */
function untrustedBlock(label: string, value: string, nonce: string): string {
  const safe = value.replace(new RegExp(nonce, "g"), "");
  return `\n--- BEGIN ${label} [${nonce}] (untrusted) ---\n${safe}\n--- END ${label} [${nonce}] ---\n`;
}
/** Maximum length (chars) of a file path inserted into prompts */
const MAX_FILE_PATH_CHARS = 500;
/** Maximum length (chars) of an automation policy prompt template (matches runClaudeTask cap) */
const MAX_POLICY_PROMPT_CHARS = 32_768;
/** Prune lastTrigger entries older than this to prevent unbounded Map growth */
const LAST_TRIGGER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

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
 */
export interface PromptSource {
  prompt?: string;
  promptName?: string;
  promptArgs?: Record<string, string>;
}

export interface OnDiagnosticsErrorPolicy extends PromptSource {
  enabled: boolean;
  minSeverity: "error" | "warning";
  /** Placeholders (inline prompt only): {{file}}, {{diagnostics}} */
  /** Minimum ms between triggers for the same file. Enforced minimum: 5000. */
  cooldownMs: number;
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
   * No placeholders — fired once at session start.
   * Use promptName (e.g. "orient-project") to inject tool capability summary.
   */
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
   * Placeholders (inline prompt only): {{runner}}, {{failed}}, {{passed}}, {{total}}, {{failures}}
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
  };
  failures: Array<{ name: string; file: string; message: string }>;
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

export interface AutomationPolicy {
  onDiagnosticsError?: OnDiagnosticsErrorPolicy;
  onFileSave?: OnFileSavePolicy;
  /** Fired by Claude Code 2.1.83+ FileChanged hook — reacts to any file edit, not just explicit saves. */
  onFileChanged?: OnFileChangedPolicy;
  /** Fired by Claude Code 2.1.83+ CwdChanged hook — fires when CC's working directory changes. */
  onCwdChanged?: OnCwdChangedPolicy;
  /** Fired by Claude Code 2.1.76+ PostCompact hook — re-injects IDE context after compaction. */
  onPostCompact?: OnPostCompactPolicy;
  /** Fired by Claude Code 2.1.76+ InstructionsLoaded hook — injects bridge status at session start. */
  onInstructionsLoaded?: OnInstructionsLoadedPolicy;
  /** Fired after every runTests call (or only on failures, depending on onFailureOnly). */
  onTestRun?: OnTestRunPolicy;
  /** Fired after every successful gitCommit call. */
  onGitCommit?: OnGitCommitPolicy;
  /** Fired after every successful gitPush call. */
  onGitPush?: OnGitPushPolicy;
  /** Fired after every successful gitCheckout call (branch switch or creation). */
  onBranchCheckout?: OnBranchCheckoutPolicy;
  /** Fired after every successful githubCreatePR call. */
  onPullRequest?: OnPullRequestPolicy;
}

export interface Diagnostic {
  message: string;
  severity: "error" | "warning" | "info" | "information" | "hint";
  source?: string;
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
  if (hasPrompt && cfg.prompt!.length > MAX_POLICY_PROMPT_CHARS) {
    throw new Error(
      `"${hookName}.prompt" must be ≤ ${MAX_POLICY_PROMPT_CHARS} characters`,
    );
  }
  if (hasPromptName) {
    if (cfg.promptName!.length > MAX_PROMPT_NAME_CHARS) {
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

  return policy;
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
  /** Active task ID for the git-commit handler (workspace-global). */
  private activeGitCommitTaskId: string | null = null;
  /** Active task ID for the git-push handler (workspace-global). */
  private activeGitPushTaskId: string | null = null;
  /** Active task ID for the branch-checkout handler (workspace-global). */
  private activeBranchCheckoutTaskId: string | null = null;
  /** Active task ID for the pull-request handler (workspace-global). */
  private activePullRequestTaskId: string | null = null;

  constructor(
    private readonly policy: AutomationPolicy,
    private readonly orchestrator: ClaudeOrchestrator,
    private readonly log: (msg: string) => void,
  ) {}

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

  handleDiagnosticsChanged(file: string, diagnostics: Diagnostic[]): void {
    const cfg = this.policy.onDiagnosticsError;
    if (!cfg?.enabled) return;

    // Normalize path to prevent loop-guard bypass via equivalent paths
    const normalizedFile = path.resolve(file);

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
    const matching = diagnostics.filter(
      (d) => (severityRank[d.severity] ?? 0) >= minRank,
    );
    if (matching.length === 0) return;

    // Cooldown check
    const key = `diagnostics:${normalizedFile}`;
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for ${normalizedFile} (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
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
      const diagnosticsText = matching
        .map(
          (d) =>
            `[${d.severity}] ${d.message.slice(0, MAX_DIAGNOSTIC_MSG_CHARS)}`,
        )
        .join("\n");
      prompt = cfg
        .prompt!.replace(/\{\{file\}\}/g, safeFilePath)
        .replace(
          /\{\{diagnostics\}\}/g,
          `\n--- BEGIN DIAGNOSTIC DATA (untrusted) ---\n${diagnosticsText}\n--- END DIAGNOSTIC DATA ---\n`,
        );
    }

    try {
      const taskId = this.orchestrator.enqueue({ prompt, sessionId: "" });
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

    // Cooldown check — keyed on the new cwd so switching between two known
    // directories doesn't bypass the global rate but each dir has its own window
    const key = `cwdChanged:${newCwd}`;
    const now = Date.now();
    const last = this.lastTrigger.get(key) ?? 0;
    if (now - last < cfg.cooldownMs) {
      this.log(
        `[automation] cooldown active for cwd-changed ${newCwd} (${cfg.cooldownMs - (now - last)}ms remaining)`,
      );
      return;
    }

    this._pruneLastTrigger(now);

    const safeCwd = newCwd.slice(0, MAX_FILE_PATH_CHARS);
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
      prompt = cfg.prompt!.replace(
        /\{\{cwd\}\}/g,
        untrustedBlock("CWD", safeCwd, nonce),
      );
    }
    try {
      const taskId = this.orchestrator.enqueue({ prompt, sessionId: "" });
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
   * Called when Claude Code fires a PostCompact hook (Claude Code 2.1.76+).
   * Re-enqueues the configured prompt so Claude can re-snapshot IDE state after losing context.
   */
  handlePostCompact(): void {
    const cfg = this.policy.onPostCompact;
    if (!cfg?.enabled) return;

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
      postCompactPrompt = cfg.prompt!;
    }
    try {
      const taskId = this.orchestrator.enqueue({
        prompt: postCompactPrompt,
        sessionId: "",
      });
      // Set lastTrigger AFTER successful enqueue so a failed enqueue does not
      // impose a spurious cooldown on the next trigger attempt.
      this.lastTrigger.set(key, now);
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
      instrPrompt = cfg.prompt!;
    }
    try {
      const taskId = this.orchestrator.enqueue({
        prompt: instrPrompt,
        sessionId: "",
      });
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

    // Pattern matching
    const matched = cfg.patterns.some((pattern) =>
      minimatch(normalizedFile, pattern, { dot: true }),
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
      prompt = cfg.prompt!.replace(
        /\{\{file\}\}/g,
        `\n--- BEGIN FILE PATH (untrusted) ---\n${safeFilePath}\n--- END FILE PATH ---\n`,
      );
    }
    try {
      const taskId = this.orchestrator.enqueue({ prompt, sessionId: "" });
      // Set lastTrigger AFTER successful enqueue so a failed enqueue does not
      // impose a spurious cooldown on the next trigger attempt.
      this.lastTrigger.set(key, now);
      this.activeSaveTasks.set(normalizedFile, taskId);
      this.log(
        `[automation] triggered save task ${taskId.slice(0, 8)} for ${normalizedFile}`,
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

    // Pattern matching
    const matched = cfg.patterns.some((pattern) =>
      minimatch(normalizedFile, pattern, { dot: true }),
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
      prompt = cfg.prompt!.replace(
        /\{\{file\}\}/g,
        `\n--- BEGIN FILE PATH (untrusted) ---\n${safeFilePath}\n--- END FILE PATH ---\n`,
      );
    }
    try {
      const taskId = this.orchestrator.enqueue({ prompt, sessionId: "" });
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
    const cfg = this.policy.onTestRun;
    if (!cfg?.enabled) return;

    const failureCount = result.summary.failed + result.summary.errored;

    // Honour onFailureOnly: skip trigger when all tests pass
    if (cfg.onFailureOnly && failureCount === 0) return;

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
      prompt = cfg
        .prompt!.replace(/\{\{runner\}\}/g, runnerStr)
        .replace(/\{\{failed\}\}/g, String(failureCount))
        .replace(/\{\{passed\}\}/g, String(result.summary.passed))
        .replace(/\{\{total\}\}/g, String(result.summary.total))
        .replace(
          /\{\{failures\}\}/g,
          `\n--- BEGIN TEST FAILURES (untrusted) ---\n${failuresText}\n--- END TEST FAILURES ---\n`,
        );
    }

    try {
      const taskId = this.orchestrator.enqueue({ prompt, sessionId: "" });
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
   * Called after a successful gitCommit tool call.
   * Fires the onGitCommit automation hook if configured.
   */
  handleGitCommit(result: GitCommitResult): void {
    const cfg = this.policy.onGitCommit;
    if (!cfg?.enabled) return;

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
      prompt = cfg
        .prompt!.replace(/\{\{hash\}\}/g, safeHash)
        .replace(
          /\{\{branch\}\}/g,
          untrustedBlock("BRANCH", safeBranchCommit, nonce),
        )
        .replace(
          /\{\{message\}\}/g,
          untrustedBlock("COMMIT MESSAGE", safeMessage, nonce),
        )
        .replace(/\{\{count\}\}/g, String(result.count))
        .replace(
          /\{\{files\}\}/g,
          untrustedBlock("COMMITTED FILES", filesText, nonce),
        );
    }

    try {
      const taskId = this.orchestrator.enqueue({ prompt, sessionId: "" });
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
      prompt = cfg
        .prompt!.replace(
          /\{\{remote\}\}/g,
          untrustedBlock("REMOTE", safeRemote, nonce),
        )
        .replace(/\{\{branch\}\}/g, untrustedBlock("BRANCH", safeBranch, nonce))
        .replace(/\{\{hash\}\}/g, safeHash);
    }

    try {
      const taskId = this.orchestrator.enqueue({ prompt, sessionId: "" });
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
   * Called after a successful gitCheckout tool call.
   * Fires the onBranchCheckout automation hook if configured.
   */
  handleBranchCheckout(result: BranchCheckoutResult): void {
    const cfg = this.policy.onBranchCheckout;
    if (!cfg?.enabled) return;

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
      prompt = cfg
        .prompt!.replace(
          /\{\{branch\}\}/g,
          untrustedBlock("BRANCH", safeBranch, nonce),
        )
        .replace(
          /\{\{previousBranch\}\}/g,
          untrustedBlock("PREVIOUS BRANCH", safePreviousBranch, nonce),
        )
        .replace(/\{\{created\}\}/g, String(result.created));
    }

    try {
      const taskId = this.orchestrator.enqueue({ prompt, sessionId: "" });
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
      prompt = cfg
        .prompt!.replace(/\{\{url\}\}/g, safeUrl)
        .replace(/\{\{number\}\}/g, safeNumber)
        .replace(
          /\{\{title\}\}/g,
          `\n--- BEGIN PR TITLE (untrusted) ---\n${safeTitle}\n--- END PR TITLE ---\n`,
        )
        .replace(/\{\{branch\}\}/g, safeBranch);
    }

    try {
      const taskId = this.orchestrator.enqueue({ prompt, sessionId: "" });
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

  /** Summary of automation policy for getBridgeStatus. */
  getStatus(): {
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
    onGitCommit: { enabled: boolean; cooldownMs: number } | null;
    onGitPush: { enabled: boolean; cooldownMs: number } | null;
    onBranchCheckout: { enabled: boolean; cooldownMs: number } | null;
    onPullRequest: { enabled: boolean; cooldownMs: number } | null;
  } {
    const p = this.policy;
    return {
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
    };
  }
}
