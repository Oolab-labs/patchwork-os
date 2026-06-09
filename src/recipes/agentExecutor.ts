/**
 * Unified agent dispatch. Superset of both:
 *   - runYamlRecipe agent block  (yamlRunner.ts:378-475)
 *   - chainedRunner.executeAgent (yamlRunner.ts:1030-1058)
 *
 * Drift fix: chainedRunner was missing driver:"local" and pwCfg.model==="local".
 * CHANGELOG: chained users with model:local in ~/.patchwork/config now route to
 * localFn (Ollama/LM Studio) instead of Anthropic API — opt-in behaviour change.
 */

/**
 * Token usage reported by an adapter. Both fields are integers; absent
 * `usage` on the parent `AgentResult` means the driver didn't surface
 * counts (e.g. subprocess / Claude CLI, or local model that doesn't
 * return usage).
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Agent dispatch result. `text` is the assistant's full response (the
 * only thing existing callers care about). `usage` is the foundation for
 * PR2b — recipe-level token budget enforcement. Optional because not
 * every driver reports it (subscription Claude CLI, some local stacks).
 */
export interface AgentResult {
  text: string;
  usage?: AgentUsage;
  /**
   * Which driver (and model, when known) ACTUALLY served this call. Stamped
   * by `executeAgent` — the single place that resolves driver auto-detection
   * — so callers attribute the result to the real driver instead of guessing
   * from the configured `driver` string (which is often undefined → the
   * runner previously logged a literal `"auto"`). Consumed by
   * `RunBudget.reconcile` for correct per-driver usage/warning attribution,
   * and the substrate the forthcoming USD cost ledger needs. Additive:
   * absent on results from callers that bypass `executeAgent`.
   */
  servedBy?: { driver: string; model?: string };
}

export interface AgentExecutorDeps {
  anthropicFn: (prompt: string, model: string) => Promise<AgentResult>;
  /** Handles openai, grok, gemini, gemini-api — passes driver name through. */
  providerDriverFn: (
    driver: "openai" | "grok" | "gemini" | "gemini-api",
    prompt: string,
    model: string | undefined,
  ) => Promise<AgentResult>;
  claudeCliFn: (
    prompt: string,
    opts?: { mcpAccess?: boolean },
  ) => Promise<AgentResult>;
  localFn: (prompt: string, model: string) => Promise<AgentResult>;
  /** Returns true when the `claude` CLI is available on PATH. */
  probeClaudeCli: () => boolean;
  /** Reads ~/.patchwork/config; returns {} when absent. */
  loadPatchworkConfig: () => { model?: string; driver?: string };
}

export interface AgentExecutorInput {
  prompt: string;
  driver?: string;
  model?: string;
  /**
   * Forwarded to claudeCliFn for the subprocess driver path. When true, the
   * spawned `claude -p` is given a `--mcp-config` file pointing at the bridge,
   * so it can call bridge tools (getAnalyticsReport, ctxQueryTraces, etc.).
   * Ignored by API drivers — they reach the bridge through other means.
   */
  mcpAccess?: boolean;
}

/**
 * Model the anthropic/local agent paths fall back to when a step omits `model`.
 * Exported so RunBudget.quoteUsd prices the same model executeAgent will run
 * (keeps cost-routing quotes in parity with actual reconcile billing).
 */
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export async function executeAgent(
  input: AgentExecutorInput,
  deps: AgentExecutorDeps,
): Promise<AgentResult> {
  const { prompt, driver, model, mcpAccess } = input;
  const cliOpts = mcpAccess !== undefined ? { mcpAccess } : undefined;

  // Stamp the driver that ACTUALLY ran onto the result. This is the single
  // place driver auto-detection is resolved, so it is the only place that
  // knows the true answer — callers (RunBudget.reconcile, future cost
  // accounting) must not re-guess from the configured `driver` string.
  // Additive and idempotent: never overwrites a servedBy a dep already set.
  const stamp = async (
    resolvedDriver: string,
    resolvedModel: string | undefined,
    p: Promise<AgentResult>,
  ): Promise<AgentResult> => {
    const r = await p;
    if (r.servedBy) return r;
    return {
      ...r,
      servedBy: {
        driver: resolvedDriver,
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
      },
    };
  };

  if (driver === "anthropic" || driver === "claude") {
    return stamp(
      "anthropic",
      model ?? DEFAULT_MODEL,
      deps.anthropicFn(prompt, model ?? DEFAULT_MODEL),
    );
  }
  if (
    driver === "openai" ||
    driver === "grok" ||
    driver === "gemini" ||
    driver === "gemini-api"
  ) {
    return stamp(driver, model, deps.providerDriverFn(driver, prompt, model));
  }
  if (driver === "subprocess" || driver === "claude-code") {
    return stamp("subprocess", model, deps.claudeCliFn(prompt, cliOpts));
  }
  if (driver === "local") {
    return stamp(
      "local",
      model ?? DEFAULT_MODEL,
      deps.localFn(prompt, model ?? DEFAULT_MODEL),
    );
  }
  if (driver !== undefined) {
    throw new Error(`Unknown driver: "${driver}"`);
  }

  // No driver — check pwCfg for local model preference (THE MISSING BRANCH).
  const pwCfg = deps.loadPatchworkConfig();
  if (pwCfg.model === "local") {
    return stamp(
      "local",
      model ?? DEFAULT_MODEL,
      deps.localFn(prompt, model ?? DEFAULT_MODEL),
    );
  }

  // Explicit subprocess driver config → skip API key check entirely.
  if (pwCfg.driver === "subprocess" || pwCfg.driver === "claude-code") {
    return stamp("subprocess", model, deps.claudeCliFn(prompt, cliOpts));
  }

  // Auto-detect: prefer API key, otherwise probe for claude CLI.
  if (process.env.ANTHROPIC_API_KEY) {
    return stamp(
      "anthropic",
      model ?? DEFAULT_MODEL,
      deps.anthropicFn(prompt, model ?? DEFAULT_MODEL),
    );
  }
  if (deps.probeClaudeCli()) {
    return stamp("subprocess", model, deps.claudeCliFn(prompt, cliOpts));
  }
  // Probe failed and no API key — fall back to anthropicFn so the caller
  // surfaces a clear "[agent step skipped: ANTHROPIC_API_KEY not set]" message
  // (and so test overrides of claudeFn/anthropicFn are honored).
  return stamp(
    "anthropic",
    model ?? DEFAULT_MODEL,
    deps.anthropicFn(prompt, model ?? DEFAULT_MODEL),
  );
}
