/**
 * What-If Preview — types for the static counterfactual simulation of a recipe.
 *
 * P0 ("static" fidelity): the report is a pure, honest superset of the
 * dry-run plan (`RecipeDryRunPlan`). It NEVER executes a step. Every field is
 * derived from the static plan + tool-registry metadata, so the report cannot
 * make a real external call, write a file, or spend a token.
 *
 * Design constraints baked into the shape (from the 2026-06-04 investigation,
 * `docs/counterfactual-sim-engine-investigation.md`):
 *   - `gatedOnRecipeSteps` is a first-class field so a consumer can never
 *     imply an approval gate that the runtime would not apply — nor hide one
 *     it would. Since v3 it is COMPUTED from the effective policy (the same
 *     `computeEffectivePolicy` both runners consult per step), never a
 *     constant; `null` when the policy could not be evaluated.
 *   - cost carries an explicit `basis` and is never a precise dollar figure or
 *     `$0` — at static fidelity USD is genuinely not projectable.
 *   - conditional branches resolve to `"undetermined"`, never a faked
 *     taken/skipped, because dry-run sentinels are truthy and would lie.
 *
 * Later phases bump `fidelity` ("mocked" | "hybrid") and `schemaVersion`.
 */

/**
 * Stable schema version for consumers; bump on breaking shape changes.
 *
 * v2 (P2 mocked sandbox): adds `fidelity:"mocked"`, `SimulationStep.mockedFrom`,
 * and the `taken`/`skipped` branch outcomes (alongside the existing
 * `undetermined`). All additions are additive/back-compatible — a static report
 * is still a valid v2 report.
 *
 * v3: the approval projection is the RUNTIME's verdict, not a tier guess.
 * `gatedOnRecipeSteps` becomes `boolean | null` and is computed;
 * `ApprovalProjection` gains `verdict` / `consultsApproval` and its
 * `wouldRequireApproval` now means "the runner would hold this step for a
 * human" (`null` when unknown); `approvals` gains `basis`, `profile` and
 * `trigger`. A meaning change, hence the bump.
 */
export const SIMULATION_SCHEMA_VERSION = 3;

export type RiskTier = "low" | "medium" | "high";

/**
 * Side-effect class for a single step, derived from registry metadata
 * (`isWrite` / `isConnector` / `namespace`) — never from execution.
 */
export type SideEffectKind =
  | "local-read" // reads local/workspace state (git log, file read, diagnostics)
  | "local-write" // mutates local state (file write, git commit)
  | "connector-read" // reads an external SaaS connector (github list, gmail fetch)
  | "connector-write" // mutates an external SaaS connector (github create_pr, slack post)
  | "external-http" // arbitrary outbound HTTP / webhook
  | "agent-llm" // an LLM/agent step (non-deterministic; never executed in sim)
  | "nested-recipe" // delegates to a nested recipe
  | "unknown"; // tool id not resolvable in the registry at plan time

export interface SimulationStep {
  id: string;
  type: "tool" | "agent" | "recipe";
  tool?: string;
  namespace?: string;
  /** True when the tool id resolved in the registry at plan time. */
  resolved: boolean;
  optional?: boolean;
  dependencies?: string[];
  /** Present for chained steps with a `when:` condition. */
  condition?: string;
  /** The step's own risk (explicit on the step, or the registry default). */
  baseRisk: RiskTier;
  /**
   * Risk including blast-radius propagation: at least as high as the highest
   * risk among the steps that must have run before this one (its transitive
   * dependencies). Equals `baseRisk` when nothing higher-risk precedes it.
   */
  effectiveRisk: RiskTier;
  sideEffect: SideEffectKind;
  isWrite: boolean;
  isConnector: boolean;
  /**
   * P2 mocked fidelity only. Present when the report is `fidelity:"mocked"`:
   * `"history"` → this step's output was taken from a real prior run;
   * `"synthesized"` → no history existed, so the mocked sandbox fed the step a
   * synthesized placeholder (still executing nothing for real). Absent at
   * static fidelity.
   */
  mockedFrom?: "history" | "synthesized";
}

/**
 * The effective-policy verdict for one step, as `computeEffectivePolicy`
 * returns it, or `"unknown"` when it was not evaluated (a nested-recipe or
 * compound step, or a report built with no policy input).
 */
export type StepPolicyVerdict =
  | "ALLOW"
  | "HUMAN_APPROVAL_REQUIRED"
  | "REFUSED"
  | "unknown";

/** Per-step approval projection — what the runtime WOULD do with this step. */
export interface ApprovalProjection {
  stepId: string;
  tool?: string;
  tier: RiskTier;
  /**
   * True when the runner would hold this step for a human
   * (`verdict === "HUMAN_APPROVAL_REQUIRED"`); false when it would not;
   * `null` when the verdict is unknown.
   */
  wouldRequireApproval: boolean | null;
  /** The effective-policy verdict for this step. */
  verdict: StepPolicyVerdict;
  /** True when the runner consults the approval gate for this step at all. */
  consultsApproval?: boolean;
  reason: string;
}

/**
 * Per-step effective-policy facts handed to the pure transform. Built by
 * `projectRecipePolicy` from `computeEffectivePolicy` — the transform never
 * derives a verdict itself.
 */
export interface SimulationPolicy {
  profile: "governed" | "compat";
  /** The trigger the runtime evaluates (a top-level chained run is "manual"). */
  trigger: string;
  /** Keyed by plan step id. A step absent here was not evaluated. */
  steps: Map<
    string,
    {
      final: Exclude<StepPolicyVerdict, "unknown">;
      consultsApproval: boolean;
      reason: string;
    }
  >;
}

/** A conditional branch surfaced by the engine. */
export interface BranchProjection {
  stepId: string;
  condition: string;
  /**
   * At static fidelity always `"undetermined"` — sentinels would lie.
   * At mocked fidelity (P2): `"taken"` / `"skipped"` when every step id the
   * `when:` references has a real historical value (so the condition resolves
   * realistically), else `"undetermined"`.
   */
  outcome: "taken" | "skipped" | "undetermined";
  reason: string;
}

export interface RiskComponents {
  highSteps: number;
  mediumSteps: number;
  writeSteps: number;
  connectorWriteSteps: number;
  externalHttpSteps: number;
  unresolvedSteps: number;
}

export interface RunRiskSummary {
  /** 0–100 derived workflow risk score. Always shown WITH its components. */
  score: number;
  tier: RiskTier;
  components: RiskComponents;
  /** Highest single-step effective risk in the plan. */
  highestStepRisk: RiskTier;
}

export interface SimulationCost {
  /**
   * "history": median of the P1 per-step token corpus (P3).
   * "heuristic": a coarse chars/4 token estimate (no run history yet).
   * "unavailable": no agent steps / nothing to estimate.
   */
  basis: "history" | "heuristic" | "unavailable";
  /**
   * Loud confidence signal (P3). "high" only when every agent step has enough
   * historical samples; "low" when some fall back to chars/4; "none" otherwise.
   */
  confidence?: "high" | "low" | "none";
  /** Prior runs that contributed at least one sample (history basis). */
  sampleRuns?: number;
  agentSteps: number;
  /** Agent steps with any estimate (history or prompt-heuristic). */
  estimatedAgentSteps: number;
  /**
   * Back-compat input-token proxy: chars/4 sum at static fidelity, or the
   * median-summed input tokens once a history projection exists.
   */
  estPromptTokens: number | null;
  /** P3 — projected total input tokens (median-summed). */
  estInputTokens?: number | null;
  /** P3 — projected total output tokens (median-summed). */
  estOutputTokens?: number | null;
  /**
   * Expected USD — sum of per-step median historical costUsd. null when there
   * is no billable history (e.g. subscription/subprocess drivers); NEVER a $0
   * placeholder. (Was always null pre-P3.)
   */
  usd: number | null;
  /** P3 — USD range across history (sum of per-step min/max). null when none. */
  minUsd?: number | null;
  maxUsd?: number | null;
  /** P3 — agent steps whose projection used real history (vs chars/4). */
  historyAgentSteps?: number;
  note: string;
}

export interface SimulationSummary {
  totalSteps: number;
  writeSteps: number;
  connectorSteps: number;
  agentSteps: number;
  unresolvedSteps: number;
  sideEffectCounts: Record<SideEffectKind, number>;
  connectorNamespaces: string[];
}

export interface RecipeSimulationReport {
  schemaVersion: typeof SIMULATION_SCHEMA_VERSION;
  kind: "what-if-preview";
  recipe: string;
  triggerType: string;
  /** ISO-8601 generation timestamp. */
  generatedAt: string;
  /**
   * Simulation fidelity. `"static"` (P0): pure transform of the dry-run plan,
   * nothing executed. `"mocked"` (P2): a chained recipe WITH run history driven
   * through the real chained runner with history-backed `mockedOutputs` +
   * fully-stubbed deps — still zero real I/O, but downstream templates and
   * `when:` branches resolve realistically.
   */
  fidelity: "static" | "mocked";
  /**
   * P2 mocked fidelity only — number of prior runs sampled to synthesize the
   * mocked outputs. Absent at static fidelity.
   */
  sampleRuns?: number;
  /** "chained" recipes have a real DAG; "flat" recipes are a linear list. */
  topology: "chained" | "flat";
  /**
   * CRITICAL honesty field. True when the runtime consults the approval gate
   * for at least one of this recipe's steps under the current profile,
   * approval-gate setting and trigger; false when it consults it for none;
   * `null` when the effective policy could not be evaluated. Computed from
   * `computeEffectivePolicy`, never a constant.
   */
  gatedOnRecipeSteps: boolean | null;
  steps: SimulationStep[];
  summary: SimulationSummary;
  risk: RunRiskSummary;
  approvals: {
    gatedOnRecipeSteps: boolean | null;
    /**
     * `"effective-policy"`: verdicts come from `computeEffectivePolicy`.
     * `"unavailable"`: the policy could not be evaluated; verdicts are
     * `"unknown"` and nothing is claimed either way.
     */
    basis: "effective-policy" | "unavailable";
    /** Governance profile the verdicts were computed under. */
    profile?: "governed" | "compat";
    /** Trigger the verdicts were computed for. */
    trigger?: string;
    projected: ApprovalProjection[];
    note: string;
  };
  cost: SimulationCost;
  /** Conditional branches surfaced but not resolved (honest "rejected paths"). */
  branches: BranchProjection[];
  lint: { errors: string[]; warnings: string[] };
  /** Loud, human-readable caveats about what this fidelity can and cannot show. */
  notes: string[];
}
