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

export interface AutomationPolicy {
  onDiagnosticsError?: OnDiagnosticsErrorPolicy;
  onFileSave?: OnFileSavePolicy;
  /** Fired by Claude Code 2.1.76+ PostCompact hook — re-injects IDE context after compaction. */
  onPostCompact?: OnPostCompactPolicy;
  /** Fired by Claude Code 2.1.76+ InstructionsLoaded hook — injects bridge status at session start. */
  onInstructionsLoaded?: OnInstructionsLoadedPolicy;
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

    this.lastTrigger.set(key, now);
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

    this.lastTrigger.set(key, now);
    this._pruneLastTrigger(now);

    try {
      const taskId = this.orchestrator.enqueue({
        prompt: cfg.prompt,
        sessionId: "",
      });
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

    this.lastTrigger.set(key, now);
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
}
