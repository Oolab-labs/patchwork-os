/**
 * Unified agent dispatch. Superset of both:
 *   - runYamlRecipe agent block  (yamlRunner.ts:378-475)
 *   - chainedRunner.executeAgent (yamlRunner.ts:1030-1058)
 *
 * Drift fix: chainedRunner was missing driver:"local" and pwCfg.model==="local".
 * CHANGELOG: chained users with model:local in ~/.patchwork/config now route to
 * localFn (Ollama/LM Studio) instead of Anthropic API — opt-in behaviour change.
 */

import {
  type BoundaryOutcome,
  type Classification,
  DEFAULT_CLASSIFICATION,
  type Destination,
  decideBoundary,
  parseDataPolicy,
} from "../privacy/dataPolicy.js";
import {
  isLocalFamilyDriver,
  type PrivacyConfig,
  parseRegistry,
  resolveDestination,
} from "../privacy/destinationRegistry.js";
import { resolveLocalModel } from "./localSettings.js";

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
  /**
   * Receipt sink for information-boundary decisions (ADR-0021 Phase 3).
   * Optional: an unwired sink means no receipt, never a refusal — the
   * boundary must not depend on its own audit trail being configured.
   */
  /**
   * Supplies `privacy.destinations` from operator config. Absent means the
   * boundary stays inert unless a caller passes an explicit destination —
   * the opt-in posture ADR-0021 requires.
   */
  loadPrivacyConfigFn?: () => PrivacyConfig | undefined;
  recordBoundaryDecisionFn?: (r: {
    decision: string;
    reason: string;
    destinationId: string;
    destinationType: "local" | "remote";
    classification: string;
    categories?: string[];
    redactCategories?: string[];
  }) => void;
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
  loadPatchworkConfig: () => {
    model?: string;
    driver?: string;
    localModel?: string;
    localEndpoint?: string;
  };
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
   * Information-boundary context (ADR-0021). Absent means the step declared no
   * `data_policy` and no destination is registered, which is byte-identical to
   * pre-boundary behaviour — the overwhelmingly common case on upgrade.
   */
  boundary?: {
    /** Raw `data_policy` as declared on the step. Parsed here, not by callers. */
    dataPolicy?: unknown;
    /** Where this prompt is about to go. */
    destination?: Destination;
    /** Whether ANY registered local destination accepts the classification. */
    localDestinationAccepts?: boolean;
  };
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
 * Resolve the driver that will ACTUALLY serve this call, once.
 *
 * #1398: the information boundary used to judge `input.driver` — the CONFIGURED
 * string, which is frequently `undefined` — while `servedBy` recorded the one
 * that really ran. When those differ the boundary judged a destination that
 * never received the data, and nothing in the resulting receipt exposes the
 * mismatch. Resolving here and handing the same value to both the boundary and
 * the dispatch removes the second, divergent copy of this logic.
 *
 * Mirrors the dispatch chain below exactly, including its precedence:
 * explicit driver → `config.json` model/driver → API key → CLI probe.
 *
 * An UNRECOGNISED driver string is returned unchanged rather than thrown on.
 * The dispatch chain still throws for it at the same point it always has, so
 * the boundary continues to evaluate unknown drivers (→ strictest remote, fail
 * closed) and still writes a receipt, exactly as before this change.
 */
export function resolveEffectiveDriver(
  driver: string | undefined,
  deps: Pick<AgentExecutorDeps, "loadPatchworkConfig" | "probeClaudeCli">,
): string {
  if (driver === "claude") return "anthropic";
  if (driver === "claude-code") return "subprocess";
  if (driver !== undefined) return driver;

  const pwCfg = deps.loadPatchworkConfig();
  if (pwCfg.model === "local") return "local";
  if (pwCfg.driver === "subprocess" || pwCfg.driver === "claude-code") {
    return "subprocess";
  }
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return deps.probeClaudeCli() ? "subprocess" : "anthropic";
}

/**
 * The endpoint a local-family driver will actually POST to, if one is
 * configured. `config.ts` copies `config.json`'s `localEndpoint` into
 * `LOCAL_ENDPOINT` only when the env var is unset, so env wins here too.
 *
 * Undefined means "the driver's own default", which is loopback for every
 * driver the registry treats as local.
 */
function resolveLocalEndpoint(
  deps: Pick<AgentExecutorDeps, "loadPatchworkConfig">,
): string | undefined {
  const fromEnv = process.env.LOCAL_ENDPOINT;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const fromCfg = deps.loadPatchworkConfig().localEndpoint;
  if (fromCfg && fromCfg.trim()) return fromCfg.trim();
  return undefined;
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

/**
 * Evaluate the information boundary for one agent step.
 *
 * Returns null when the step declares nothing AND no destination is registered
 * — byte-identical to pre-boundary behaviour, which is the state of every
 * existing install.
 *
 * A MALFORMED `data_policy` fails closed with DENY rather than defaulting. The
 * operator wrote a label; silently reading it as `internal` because of a typo
 * would leave them believing data was protected when it was not.
 */
type ResolvedBoundary = BoundaryOutcome & {
  destination: Destination;
  classification: Classification;
  categories?: string[];
};

function evaluateBoundary(
  ctx: AgentExecutorInput["boundary"],
  driver: string | undefined,
  loadPrivacyConfig: (() => PrivacyConfig | undefined) | undefined,
  // A GETTER, not a value: resolving it reads `config.json`, and a caller that
  // passes an explicit destination never needs it. Eager resolution would add
  // a disk read to dispatches that already know where they are going.
  getEndpoint?: () => string | undefined,
): ResolvedBoundary | null {
  const policy0 = parseDataPolicy(ctx?.dataPolicy);

  // Resolve the destination HERE rather than requiring every call site to pass
  // one. There are four dispatch sites in the flat runner alone; a boundary
  // that depends on each of them remembering is a boundary with four ways to
  // be bypassed, and the fifth call site added later inherits none of them.
  let destination = ctx?.destination;
  let localAccepts = ctx?.localDestinationAccepts;
  if (!destination && loadPrivacyConfig) {
    const registry = parseRegistry(loadPrivacyConfig());
    const forClass = policy0?.classification ?? DEFAULT_CLASSIFICATION;
    const endpoint = getEndpoint?.();
    const resolved = resolveDestination(registry, driver, forClass, {
      ...(endpoint !== undefined && { endpoint }),
    });
    if (resolved) {
      destination = resolved.destination;
      localAccepts = resolved.localDestinationAccepts;
    }
  }
  if (!destination) return null;
  const ctx2 = { ...ctx, destination, localDestinationAccepts: localAccepts };
  // The RESOLVED destination travels with the outcome. Reading it back off the
  // caller's input loses it entirely whenever the destination was resolved from
  // config, which is the normal path — the receipt would then record a decision
  // with no record of where the data was going, i.e. the one field that makes
  // it an audit trail rather than a counter.
  return {
    ...evaluateAgainst(policy0, ctx2),
    destination,
    classification: policy0?.classification ?? DEFAULT_CLASSIFICATION,
    ...(policy0?.categories?.length ? { categories: policy0.categories } : {}),
  };
}

function evaluateAgainst(
  policy: ReturnType<typeof parseDataPolicy>,
  ctx: NonNullable<AgentExecutorInput["boundary"]> & {
    destination: Destination;
  },
): BoundaryOutcome {
  if (policy === null) {
    return {
      decision: "DENY",
      reason:
        "data_policy declares an unrecognised classification — refusing rather than defaulting a typo to `internal`",
    };
  }
  return decideBoundary(policy, ctx.destination, {
    ...(ctx.localDestinationAccepts !== undefined && {
      localDestinationAccepts: ctx.localDestinationAccepts,
    }),
  });
}

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
  // ── INFORMATION BOUNDARY (ADR-0021) ─────────────────────────────────────
  // Evaluated BEFORE dispatch, and here rather than in `costRouter`, which is
  // the tempting seam and the wrong one: costRouter short-circuits with no
  // downshift list and no USD cap, so binding privacy there would cover only
  // budgeted steps while presenting as total enforcement. This function is on
  // the unconditional path for both runners.
  //
  // Precedence is privacy -> capability -> cost, and it is not negotiable by
  // the later stages: a cheaper or more capable model that is not authorised
  // for the data does not become authorised by being cheaper or more capable.
  // #1398: the boundary judges the driver that will ACTUALLY serve this call,
  // and the endpoint it will actually reach — not the configured `driver`
  // string, which is undefined on the auto-detect path and therefore described
  // a destination no data ever went to.
  const resolvedDriver = resolveEffectiveDriver(driver, deps);
  const boundary = evaluateBoundary(
    input.boundary,
    resolvedDriver,
    deps.loadPrivacyConfigFn,
    // Resolved ONLY for the local family, and only if the boundary actually
    // needs it. For every other driver the endpoint cannot change the
    // destination, so reading it would add a `config.json` read to agent steps
    // that never needed one.
    isLocalFamilyDriver(resolvedDriver)
      ? () => resolveLocalEndpoint(deps)
      : undefined,
  );
  if (boundary && boundary.decision !== "ALLOW") {
    deps.recordBoundaryDecisionFn?.({
      decision: boundary.decision,
      reason: boundary.reason,
      destinationId: boundary.destination.id,
      destinationType: boundary.destination.type,
      classification: boundary.classification,
      ...(boundary.categories && { categories: boundary.categories }),
      ...(boundary.redactCategories && {
        redactCategories: boundary.redactCategories,
      }),
    });
    // ALLOW_REDACTED is not implemented as a transform in this phase, and is
    // therefore REFUSED rather than silently sent unredacted. Failing closed on
    // "we know something must be removed and cannot remove it" is the whole
    // point; the alternative sends the data and logs that it should not have.
    return {
      text: `[agent step failed: information boundary — ${boundary.reason}]`,
      servedBy: { driver: driver ?? "auto" },
    };
  }
  if (boundary) {
    deps.recordBoundaryDecisionFn?.({
      decision: boundary.decision,
      reason: boundary.reason,
      destinationId: boundary.destination.id,
      destinationType: boundary.destination.type,
      classification: boundary.classification,
      ...(boundary.categories && { categories: boundary.categories }),
    });
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

  // #1398: dispatch branches on the SAME resolved value the boundary judged.
  // The auto-detect tail that used to live at the bottom of this chain is now
  // inside `resolveEffectiveDriver`, so there is exactly one place that decides
  // which driver serves a call — the condition for the boundary and the receipt
  // being able to name it truthfully.
  if (resolvedDriver === "anthropic") {
    return stamp(
      "anthropic",
      model ?? DEFAULT_MODEL,
      deps.anthropicFn(prompt, model ?? DEFAULT_MODEL),
    );
  }
  if (
    resolvedDriver === "openai" ||
    resolvedDriver === "grok" ||
    resolvedDriver === "gemini" ||
    resolvedDriver === "gemini-api" ||
    resolvedDriver === "codex"
  ) {
    // A worker-mandated sandbox on the codex driver overrides — never merges
    // with — the step's own providerOptions. See CODEX_WORKER_SANDBOX_LOCKDOWN.
    const effectiveProviderOptions =
      resolvedDriver === "codex" && enforceSandbox
        ? CODEX_WORKER_SANDBOX_LOCKDOWN
        : providerOptions;
    return stamp(
      resolvedDriver,
      model,
      // Only pass the 4th arg when set so the common (unconstrained) call keeps
      // its 3-arg shape — backward-compatible with callers/mocks.
      effectiveProviderOptions
        ? deps.providerDriverFn(
            resolvedDriver,
            prompt,
            model,
            effectiveProviderOptions,
          )
        : deps.providerDriverFn(resolvedDriver, prompt, model),
    );
  }
  if (resolvedDriver === "subprocess") {
    return stamp("subprocess", model, deps.claudeCliFn(prompt, cliOpts));
  }
  if (resolvedDriver === "local") {
    // Resolve through the shared resolver, NOT `model ?? DEFAULT_MODEL`.
    // DEFAULT_MODEL is an Anthropic id; using it here sent "claude-…" to a
    // local server whenever a step omitted `model:`. Stamping the RESOLVED
    // value is the other half: the log previously recorded what the step
    // asked for while a config default answered, so an invalid run and a
    // valid one looked identical.
    const localModel = resolveLocalModel(model, deps.loadPatchworkConfig());
    return stamp("local", localModel, deps.localFn(prompt, localModel));
  }
  // Unrecognised driver. Reached at the same point as before: the boundary has
  // already run and written its receipt (fail-closed to strictest remote for an
  // unknown driver), which is why `resolveEffectiveDriver` passes the unknown
  // string through instead of throwing early.
  throw new Error(`Unknown driver: "${driver}"`);
}
