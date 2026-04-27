/**
 * Unified agent dispatch. Superset of both:
 *   - runYamlRecipe agent block  (yamlRunner.ts:378-475)
 *   - chainedRunner.executeAgent (yamlRunner.ts:1030-1058)
 *
 * Drift fix: chainedRunner was missing driver:"local" and pwCfg.model==="local".
 * CHANGELOG: chained users with model:local in ~/.patchwork/config now route to
 * localFn (Ollama/LM Studio) instead of Anthropic API — opt-in behaviour change.
 */

export interface AgentExecutorDeps {
  anthropicFn: (prompt: string, model: string) => Promise<string>;
  /** Handles openai, grok, gemini — passes driver name through. */
  providerDriverFn: (
    driver: "openai" | "grok" | "gemini",
    prompt: string,
    model: string | undefined,
  ) => Promise<string>;
  claudeCliFn: (prompt: string) => Promise<string>;
  localFn: (prompt: string, model: string) => Promise<string>;
  /** Returns true when the `claude` CLI is available on PATH. */
  probeClaudeCli: () => boolean;
  /** Reads ~/.patchwork/config; returns {} when absent. */
  loadPatchworkConfig: () => { model?: string; driver?: string };
}

export interface AgentExecutorInput {
  prompt: string;
  driver?: string;
  model?: string;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export async function executeAgent(
  input: AgentExecutorInput,
  deps: AgentExecutorDeps,
): Promise<string> {
  const { prompt, driver, model } = input;

  if (driver === "anthropic" || driver === "claude") {
    return deps.anthropicFn(prompt, model ?? DEFAULT_MODEL);
  }
  if (driver === "openai" || driver === "grok" || driver === "gemini") {
    return deps.providerDriverFn(driver, prompt, model);
  }
  if (driver === "subprocess" || driver === "claude-code") {
    return deps.claudeCliFn(prompt);
  }
  if (driver === "local") {
    return deps.localFn(prompt, model ?? DEFAULT_MODEL);
  }
  if (driver !== undefined) {
    throw new Error(`Unknown driver: "${driver}"`);
  }

  // No driver — check pwCfg for local model preference (THE MISSING BRANCH).
  const pwCfg = deps.loadPatchworkConfig();
  if (pwCfg.model === "local") {
    return deps.localFn(prompt, model ?? DEFAULT_MODEL);
  }

  // Explicit subprocess driver config → skip API key check entirely.
  if (pwCfg.driver === "subprocess" || pwCfg.driver === "claude-code") {
    return deps.claudeCliFn(prompt);
  }

  // Auto-detect: prefer API key, otherwise probe for claude CLI.
  if (process.env.ANTHROPIC_API_KEY) {
    return deps.anthropicFn(prompt, model ?? DEFAULT_MODEL);
  }
  if (deps.probeClaudeCli()) {
    return deps.claudeCliFn(prompt);
  }
  // Probe failed and no API key — fall back to anthropicFn so the caller
  // surfaces a clear "[agent step skipped: ANTHROPIC_API_KEY not set]" message
  // (and so test overrides of claudeFn/anthropicFn are honored).
  return deps.anthropicFn(prompt, model ?? DEFAULT_MODEL);
}
