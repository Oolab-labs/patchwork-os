import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import type { ClaudeOrchestrator } from "./claudeOrchestrator.js";

/** Maximum length (chars) of a single diagnostic message before truncation */
const MAX_DIAGNOSTIC_MSG_CHARS = 500;
/** Maximum length (chars) of a file path inserted into prompts */
const MAX_FILE_PATH_CHARS = 500;
/** Maximum length (chars) of an automation policy prompt template (matches runClaudeTask cap) */
const MAX_POLICY_PROMPT_CHARS = 32_768;
/** Prune lastTrigger entries older than this to prevent unbounded Map growth */
const LAST_TRIGGER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

// ── Policy schema ─────────────────────────────────────────────────────────────

export interface OnDiagnosticsErrorPolicy {
  enabled: boolean;
  minSeverity: "error" | "warning";
  /** Placeholders: {{file}}, {{diagnostics}} */
  prompt: string;
  /** Minimum ms between triggers for the same file. Enforced minimum: 5000. */
  cooldownMs: number;
}

export interface OnFileSavePolicy {
  enabled: boolean;
  /** Minimatch glob patterns, e.g. ["**\/*.ts", "!node_modules/**"] */
  patterns: string[];
  /** Placeholders: {{file}} */
  prompt: string;
  cooldownMs: number;
}

export interface OnFileChangedPolicy {
  enabled: boolean;
  /** Minimatch glob patterns, e.g. ["**\/*.ts", "!node_modules/**"] */
  patterns: string[];
  /** Placeholders: {{file}} */
  prompt: string;
  cooldownMs: number;
}

export interface OnPostCompactPolicy {
  enabled: boolean;
  /**
   * Prompt to enqueue after Claude compacts its context.
   * Use this to re-snapshot IDE state so Claude recovers context.
   * No placeholders — fired unconditionally when compaction occurs.
   */
  prompt: string;
  /** Minimum ms between triggers (prevents repeated compaction storms). Enforced minimum: 5000. */
  cooldownMs: number;
}

export interface OnInstructionsLoadedPolicy {
  enabled: boolean;
  /**
   * Prompt to enqueue when Claude loads its system instructions (first turn of a session).
   * Useful for injecting a tool-capability summary at session start.
   * No placeholders.
   */
  prompt: string;
}

export interface OnCwdChangedPolicy {
  enabled: boolean;
  /**
   * Prompt to enqueue when Claude Code's working directory changes (Claude Code 2.1.83+).
   * Useful for re-initialising workspace context when CC switches projects.
   * Placeholder: {{cwd}}
   */
  prompt: string;
  /** Minimum ms between triggers. Enforced minimum: 5000. */
  cooldownMs: number;
}

export interface OnTestRunPolicy {
  enabled: boolean;
  /**
   * Only trigger when there are test failures or errors.
   * Set to false to trigger after every test run regardless of outcome.
   * Default: true.
   */
  onFailureOnly: boolean;
  /**
   * Prompt to enqueue after a test run.
   * Placeholders: {{runner}}, {{failed}}, {{passed}}, {{total}}, {{failures}}
   */
  prompt: string;
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
}

export interface Diagnostic {
  message: string;
  severity: "error" | "warning" | "info" | "information" | "hint";
  source?: string;
}

const MIN_COOLDOWN_MS = 5_000;

// ── Policy loading ────────────────────────────────────────────────────────────

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
    if (typeof d.prompt !== "string" || d.prompt.trim() === "") {
      throw new Error(`"onDiagnosticsError.prompt" must be a non-empty string`);
    }
    if (d.prompt.length > MAX_POLICY_PROMPT_CHARS) {
      throw new Error(
        `"onDiagnosticsError.prompt" must be ≤ ${MAX_POLICY_PROMPT_CHARS} characters`,
      );
    }
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
    if (typeof s.prompt !== "string" || s.prompt.trim() === "") {
      throw new Error(`"onFileSave.prompt" must be a non-empty string`);
    }
    if (s.prompt.length > MAX_POLICY_PROMPT_CHARS) {
      throw new Error(
        `"onFileSave.prompt" must be ≤ ${MAX_POLICY_PROMPT_CHARS} characters`,
      );
    }
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
    if (typeof fc.prompt !== "string" || fc.prompt.trim() === "") {
      throw new Error(`"onFileChanged.prompt" must be a non-empty string`);
    }
    if (fc.prompt.length > MAX_POLICY_PROMPT_CHARS) {
      throw new Error(
        `"onFileChanged.prompt" must be ≤ ${MAX_POLICY_PROMPT_CHARS} characters`,
      );
    }
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
    if (typeof cw.prompt !== "string" || cw.prompt.trim() === "") {
      throw new Error(`"onCwdChanged.prompt" must be a non-empty string`);
    }
    if (cw.prompt.length > MAX_POLICY_PROMPT_CHARS) {
      throw new Error(
        `"onCwdChanged.prompt" must be ≤ ${MAX_POLICY_PROMPT_CHARS} characters`,
      );
    }
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
    if (typeof p.prompt !== "string" || p.prompt.trim() === "") {
      throw new Error(`"onPostCompact.prompt" must be a non-empty string`);
    }
    if (p.prompt.length > MAX_POLICY_PROMPT_CHARS) {
      throw new Error(
        `"onPostCompact.prompt" must be ≤ ${MAX_POLICY_PROMPT_CHARS} characters`,
      );
    }
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
    if (typeof il.prompt !== "string" || il.prompt.trim() === "") {
      throw new Error(
        `"onInstructionsLoaded.prompt" must be a non-empty string`,
      );
    }
    if (il.prompt.length > MAX_POLICY_PROMPT_CHARS) {
      throw new Error(
        `"onInstructionsLoaded.prompt" must be ≤ ${MAX_POLICY_PROMPT_CHARS} characters`,
      );
    }
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
    if (typeof tr.prompt !== "string" || tr.prompt.trim() === "") {
      throw new Error(`"onTestRun.prompt" must be a non-empty string`);
    }
    if (tr.prompt.length > MAX_POLICY_PROMPT_CHARS) {
      throw new Error(
        `"onTestRun.prompt" must be ≤ ${MAX_POLICY_PROMPT_CHARS} characters`,
      );
    }
    if (typeof tr.cooldownMs !== "number" || !Number.isFinite(tr.cooldownMs)) {
      throw new Error(`"onTestRun.cooldownMs" must be a number`);
    }
    if (tr.cooldownMs < MIN_COOLDOWN_MS) {
      tr.cooldownMs = MIN_COOLDOWN_MS;
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

  constructor(
    private readonly policy: AutomationPolicy,
    private readonly orchestrator: ClaudeOrchestrator,
    private readonly log: (msg: string) => void,
  ) {}

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
    const diagnosticsText = matching
      .map(
        (d) =>
          `[${d.severity}] ${d.message.slice(0, MAX_DIAGNOSTIC_MSG_CHARS)}`,
      )
      .join("\n");

    const prompt = cfg.prompt
      .replace(/\{\{file\}\}/g, safeFilePath)
      .replace(
        /\{\{diagnostics\}\}/g,
        `\n--- BEGIN DIAGNOSTIC DATA (untrusted) ---\n${diagnosticsText}\n--- END DIAGNOSTIC DATA ---\n`,
      );

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
    const prompt = cfg.prompt.replace(
      /\{\{cwd\}\}/g,
      `\n--- BEGIN CWD (untrusted) ---\n${safeCwd}\n--- END CWD ---\n`,
    );
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

    try {
      const taskId = this.orchestrator.enqueue({
        prompt: cfg.prompt,
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

    try {
      const taskId = this.orchestrator.enqueue({
        prompt: cfg.prompt,
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

    // Truncate file path and wrap in delimiters to prevent prompt injection
    // via crafted workspace directory names embedding instruction-like content.
    const safeFilePath = normalizedFile.slice(0, MAX_FILE_PATH_CHARS);
    const prompt = cfg.prompt.replace(
      /\{\{file\}\}/g,
      `\n--- BEGIN FILE PATH (untrusted) ---\n${safeFilePath}\n--- END FILE PATH ---\n`,
    );
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
    const prompt = cfg.prompt.replace(
      /\{\{file\}\}/g,
      `\n--- BEGIN FILE PATH (untrusted) ---\n${safeFilePath}\n--- END FILE PATH ---\n`,
    );
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

    const prompt = cfg.prompt
      .replace(/\{\{runner\}\}/g, runnerStr)
      .replace(/\{\{failed\}\}/g, String(failureCount))
      .replace(/\{\{passed\}\}/g, String(result.summary.passed))
      .replace(/\{\{total\}\}/g, String(result.summary.total))
      .replace(
        /\{\{failures\}\}/g,
        `\n--- BEGIN TEST FAILURES (untrusted) ---\n${failuresText}\n--- END TEST FAILURES ---\n`,
      );

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
    };
  }
}
