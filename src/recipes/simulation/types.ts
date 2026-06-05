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
 *   - `gatedOnRecipeSteps` is a first-class boolean so a consumer can NEVER
 *     imply an approval gate that does not exist on the recipe execution path
 *     today (the live gate in transport.ts only gates MCP bridge calls).
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
 */
export const SIMULATION_SCHEMA_VERSION = 2;

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

/** Per-step approval projection — "what WOULD gate, if recipe steps were gated". */
export interface ApprovalProjection {
  stepId: string;
  tool?: string;
  tier: RiskTier;
  /** True if this step's tier would trip an approval gate (tier !== "low"). */
  wouldRequireApproval: boolean;
  reason: string;
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
   * "heuristic": a coarse chars/4 token estimate (low confidence).
   * "unavailable": no static basis for an estimate (e.g. chained agent steps
   *   carry no prompt in the plan).
   */
  basis: "heuristic" | "unavailable";
  agentSteps: number;
  /** Agent steps whose prompt was available to estimate from. */
  estimatedAgentSteps: number;
  /** Sum of chars/4 over available agent prompts. null when basis unavailable. */
  estPromptTokens: number | null;
  /** USD is deliberately never projected at static fidelity. Always null. */
  usd: null;
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
   * CRITICAL honesty field. False today: the approval queue does NOT gate
   * recipe-runner steps. Consumers MUST surface this so the approval
   * projection is never read as live gate behaviour.
   */
  gatedOnRecipeSteps: boolean;
  steps: SimulationStep[];
  summary: SimulationSummary;
  risk: RunRiskSummary;
  approvals: {
    gatedOnRecipeSteps: boolean;
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
