/**
 * Provider-neutral driver types.
 * All drivers implement ProviderDriver; Claude-specific fields go in providerOptions.
 */

export interface ProviderTaskInput {
  prompt: string;
  /** Working directory / context hint passed as cwd to the subprocess or API call. */
  workspace: string;
  timeoutMs: number;
  signal: AbortSignal;
  onChunk?: (chunk: string) => void;
  /** Informational list of paths; driver decides how to surface them. */
  contextFiles?: string[];
  /** Provider-specific model ID (e.g. "claude-sonnet-4-6", "gemini-2.5-pro"). */
  model?: string;
  systemPrompt?: string;
  /** Startup timeout: abort if no output arrives within this many ms of spawn. */
  startupTimeoutMs?: number;
  /**
   * Provider-specific overrides — driver may ignore unknown keys.
   * Claude subprocess: { effort, fallbackModel, maxBudgetUsd, useAnt }
   * Gemini subprocess: { binary }
   * OpenAI API: { maxTokens, temperature }
   */
  providerOptions?: Record<string, unknown>;
}

export interface ProviderTaskResult {
  text: string;
  durationMs: number;
  startupMs?: number;
  wasAborted?: boolean;
  /** Set when the provider signals an error (replaces exitCode for API drivers). */
  errorMessage?: string;
  /** Tokens used, resolved model, etc. Driver-specific. */
  providerMeta?: Record<string, unknown>;
  // Legacy fields — kept for backward compat with ClaudeTaskOutput consumers.
  exitCode?: number;
  stderrTail?: string;
  startupTimedOut?: boolean;
}

export type ProviderTaskOutcome =
  | {
      outcome: "done";
      text: string;
      durationMs: number;
      startupMs?: number;
      providerMeta?: Record<string, unknown>;
    }
  | { outcome: "error"; errorMessage: string; durationMs: number }
  | {
      outcome: "aborted";
      cancelKind: "startup_timeout" | "timeout" | "user";
      durationMs: number;
    };

export interface ProviderDriver {
  readonly name: string;
  /** Primary entry point. Must resolve; never reject (swallow errors into result). */
  run(input: ProviderTaskInput): Promise<ProviderTaskResult>;
  /** Optional: discriminated-union variant. Default impl wraps run(). */
  runOutcome?(input: ProviderTaskInput): Promise<ProviderTaskOutcome>;
  /** Optional: long-lived session lifecycle (server-mode drivers). */
  spawnForSession?(sessionId: string): Promise<void>;
  killForSession?(sessionId: string): void;
  /** Called once on bridge shutdown. Clean up connections, temp files. */
  destroy?(): Promise<void>;
}

export function toProviderTaskOutcome(
  result: ProviderTaskResult,
  cancelReason?: "timeout" | "startup_timeout" | "user" | "shutdown",
): ProviderTaskOutcome {
  if (result.wasAborted) {
    const cancelKind: "startup_timeout" | "timeout" | "user" =
      result.startupTimedOut || cancelReason === "startup_timeout"
        ? "startup_timeout"
        : cancelReason === "timeout"
          ? "timeout"
          : "user";
    return { outcome: "aborted", cancelKind, durationMs: result.durationMs };
  }
  if (
    result.errorMessage ||
    (result.exitCode !== undefined && result.exitCode !== 0)
  ) {
    return {
      outcome: "error",
      errorMessage: result.errorMessage ?? `exit code ${result.exitCode}`,
      durationMs: result.durationMs,
    };
  }
  return {
    outcome: "done",
    text: result.text,
    durationMs: result.durationMs,
    startupMs: result.startupMs,
    providerMeta: result.providerMeta,
  };
}

/**
 * @deprecated Use ProviderDriver. IClaudeDriver is a backward-compat alias.
 * Will be removed in a future minor version.
 */
export type IClaudeDriver = ProviderDriver;
