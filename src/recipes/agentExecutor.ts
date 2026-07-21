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
  /** Handles openai, grok, gemini, gemini-api, codex — passes driver name through. */
  providerDriverFn: (
    driver: "openai" | "grok" | "gemini" | "gemini-api" | "codex",
    prompt: string,
    model: string | undefined,
    /** Opaque per-call driver options (e.g. responseFormat for constrained
     * decoding). Forwarded to driver.run; drivers ignore keys they don't use. */
    providerOptions?: Record<string, unknown>,
  ) => Promise<AgentResult>;
  claudeCliFn: (
    prompt: string,
    opts?: {
      mcpAccess?: boolean;
      sandbox?: boolean;
      allowedTools?: string[];
      disallowedTools?: string[];
    },
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
  /** Opt-in tool sandbox — enforced argv on the subprocess path only. */
  sandbox?: boolean;
  /** Tool allowlist enforced via --allowed-tools when sandbox is true. */
  allowedTools?: string[];
  /** Deny rules via --disallowed-tools (any mode). */
  disallowedTools?: string[];
  /**
   * Worker-autonomy hard requirement. When true, this agent step carries a
   * worker-mandated tool sandbox (see disallowedToolsForAgentStep) that ONLY the
   * subprocess / claude-code driver can enforce (`--disallowed-tools`). Every
   * other driver structurally drops the deny list, which would silently re-open
   * the exact agent-bypass the sandbox exists to close (a NEVER-WIDEN hole). So
   * when this is set and the resolved driver is not sandbox-enforcing, executeAgent
   * REFUSES to run the step (fail-closed) instead of running it un-sandboxed.
   */
  enforceSandbox?: boolean;
  /**
   * Opaque per-call driver options forwarded to the provider driver (e.g.
   * `{ responseFormat: { type: "json_object" } }` for constrained decoding).
   * Only the provider-driver path (openai/grok/gemini-api) consumes it; other
   * drivers ignore it. Used by the judge to enforce parseable JSON verdicts.
   */
  providerOptions?: Record<string, unknown>;
}

/**
 * Model the anthropic/local agent paths fall back to when a step omits `model`.
 * Exported so RunBudget.quoteUsd prices the same model executeAgent will run
 * (keeps cost-routing quotes in parity with actual reconcile billing).
 */
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * How (if at all) `executeAgent` can enforce a worker-mandated tool sandbox on
 * this call. Mirrors the dispatch in `executeAgent` exactly (explicit driver,
 * then pwCfg, then auto-detect) so the worker-sandbox guard agrees with where
 * the call actually lands. `probeClaudeCli` / `loadPatchworkConfig` are cheap
 * + idempotent, so calling them here too is fine.
 *
 *   "granular"       — the subprocess (`claude -p`) driver, which honours a
 *                       per-tool `--disallowed-tools` deny list exactly.
 *   "codex-lockdown"  — the codex driver, which has NO per-tool granularity at
 *                       all (no `--disallowed-tools` equivalent). The only
 *                       defensible translation is Codex's own coarsest
 *                       lockdown (read-only sandbox, no network, no approval
 *                       escalation) — see CODEX_WORKER_SANDBOX_LOCKDOWN.
 *   "none"            — no enforcement mechanism; enforceSandbox must refuse.
 */
type SandboxEnforcement = "granular" | "codex-lockdown" | "none";

function resolveSandboxEnforcement(
  driver: string | undefined,
  deps: AgentExecutorDeps,
): SandboxEnforcement {
  if (driver === "subprocess" || driver === "claude-code") return "granular";
  if (driver === "codex") return "codex-lockdown";
  if (driver !== undefined) return "none"; // anthropic/claude/openai/grok/gemini*/local
  const pwCfg = deps.loadPatchworkConfig();
  if (pwCfg.model === "local") return "none";
  if (pwCfg.driver === "subprocess" || pwCfg.driver === "claude-code")
    return "granular";
  if (process.env.ANTHROPIC_API_KEY) return "none"; // auto-detect → anthropic API
  return deps.probeClaudeCli() ? "granular" : "none"; // CLI present → subprocess; else falls back to API
}

/**
 * CodexDriver's coarsest lockdown — read-only filesystem, no network, no
 * interactive approval escalation (see src/drivers/codex/subprocess.ts's
 * SandboxMode/ApprovalMode). This is the ONLY translation available for a
 * worker-mandated tool sandbox on the codex driver: Codex has no per-tool
 * `--disallowed-tools` equivalent, so we cannot allow-list individual tools
 * the way the subprocess driver does. Strictly safer than the granular
 * sandbox (blocks everything it would ALSO block, plus more) at the cost of
 * blocking some tools the granular sandbox would still permit (harmless
 * reads). Deliberately OVERRIDES — never merges with — whatever
 * providerOptions the step itself requested: a worker-owned step must never
 * be able to negotiate its own escape hatch (e.g. `danger-full-access`) out
 * from under the gate.
 */
const CODEX_WORKER_SANDBOX_LOCKDOWN: Record<string, unknown> = {
  sandboxMode: "read-only",
  approvalMode: "never",
  networkAccess: false,
  webSearch: false,
};

export async function executeAgent(
  input: AgentExecutorInput,
  deps: AgentExecutorDeps,
): Promise<AgentResult> {
  const {
    prompt,
    driver,
    model,
    mcpAccess,
    sandbox,
    allowedTools,
    disallowedTools,
    providerOptions,
    enforceSandbox,
  } = input;

  // NEVER-WIDEN guard. A worker-mandated sandbox is enforceable only on drivers
  // resolveSandboxEnforcement recognizes; on any other driver the deny list is
  // silently dropped and the worker's agent step could perform exactly the risky
  // action the gate believed it sandboxed. Fail closed: refuse to run rather than
  // run un-gated. The "[agent step failed:" prefix is the marker the runners
  // already treat as a step failure (halting non-optional steps), so the agent
  // never executes.
  const sandboxEnforcement = resolveSandboxEnforcement(driver, deps);
  if (enforceSandbox && sandboxEnforcement === "none") {
    return {
      text: "[agent step failed: worker autonomy requires the subprocess or codex driver to enforce its tool sandbox — set the agent step (or recipe) driver to `subprocess`/`claude-code`/`codex`; refusing to run un-sandboxed]",
      servedBy: { driver: driver ?? "auto" },
    };
  }
  const cliOpts =
    mcpAccess !== undefined ||
    sandbox !== undefined ||
    allowedTools !== undefined ||
    disallowedTools !== undefined
      ? {
          ...(mcpAccess !== undefined && { mcpAccess }),
          ...(sandbox !== undefined && { sandbox }),
          ...(allowedTools !== undefined && { allowedTools }),
          ...(disallowedTools !== undefined && { disallowedTools }),
        }
      : undefined;

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
    driver === "gemini-api" ||
    driver === "codex"
  ) {
    // A worker-mandated sandbox on the codex driver overrides — never merges
    // with — the step's own providerOptions. See CODEX_WORKER_SANDBOX_LOCKDOWN.
    const effectiveProviderOptions =
      driver === "codex" && enforceSandbox
        ? CODEX_WORKER_SANDBOX_LOCKDOWN
        : providerOptions;
    return stamp(
      driver,
      model,
      // Only pass the 4th arg when set so the common (unconstrained) call keeps
      // its 3-arg shape — backward-compatible with callers/mocks.
      effectiveProviderOptions
        ? deps.providerDriverFn(driver, prompt, model, effectiveProviderOptions)
        : deps.providerDriverFn(driver, prompt, model),
    );
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
