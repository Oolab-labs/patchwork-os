/**
 * What-If Preview — run-level risk aggregation.
 *
 * Two pure pieces:
 *   1. `computeEffectiveRisks` — blast-radius propagation. A step's effective
 *      risk is at least as high as the highest risk among the steps that must
 *      have run before it (its transitive dependencies). Chained recipes use
 *      the real dependency DAG; flat recipes model the linear sequence
 *      (step N implicitly depends on N-1).
 *   2. `summarizeRunRisk` — a transparent 0–100 workflow score derived from
 *      step counts, returned WITH its components so it is never a black box.
 *
 * Risk tier source is `riskDefault` (already enriched onto the plan step) —
 * the registry's authoritative value. `classifyTool` now agrees for namespaced
 * recipe tool ids (it consults the same registry via a resolver hook, with a
 * read/write verb fallback), so the approval gate and this simulation no longer
 * disagree. We keep reading `riskDefault` directly here since it's already on
 * the step — no need to re-look-up.
 */

import type {
  RiskComponents,
  RiskTier,
  RunRiskSummary,
  SideEffectKind,
} from "./types.js";

const RISK_ORDER: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };
const RISK_BY_ORDER: RiskTier[] = ["low", "medium", "high"];

export function maxRisk(a: RiskTier, b: RiskTier): RiskTier {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export interface RiskStepInput {
  id: string;
  baseRisk: RiskTier;
  /** Upstream step ids (chained). Ignored for flat topology. */
  dependencies?: string[];
}

/**
 * Compute each step's effective (blast-radius-aware) risk.
 *
 * Returns a map keyed by step id. Cycles are broken safely: a step already on
 * the current resolution stack contributes only its own base risk to break the
 * loop, so a malformed DAG can never infinite-loop the planner.
 */
export function computeEffectiveRisks(
  steps: RiskStepInput[],
  topology: "chained" | "flat",
): Map<string, RiskTier> {
  const byId = new Map<string, RiskStepInput>();
  for (const s of steps) byId.set(s.id, s);

  const memo = new Map<string, RiskTier>();

  if (topology === "flat") {
    // Linear: running max down the list.
    let running: RiskTier = "low";
    for (const s of steps) {
      running = maxRisk(running, s.baseRisk);
      memo.set(s.id, running);
    }
    return memo;
  }

  // Chained: forward propagation along the dependency edges.
  const resolving = new Set<string>();
  const resolve = (id: string): RiskTier => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const step = byId.get(id);
    if (!step) return "low";
    if (resolving.has(id)) return step.baseRisk; // cycle guard
    resolving.add(id);
    let eff = step.baseRisk;
    for (const dep of step.dependencies ?? []) {
      if (dep === id || !byId.has(dep)) continue;
      eff = maxRisk(eff, resolve(dep));
    }
    resolving.delete(id);
    memo.set(id, eff);
    return eff;
  };

  for (const s of steps) resolve(s.id);
  return memo;
}

export interface RiskTallyInput {
  effectiveRisk: RiskTier;
  sideEffect: SideEffectKind;
  resolved: boolean;
}

const clamp100 = (n: number): number => Math.max(0, Math.min(100, n));

/**
 * Derive a transparent 0–100 workflow risk score + tier from per-step tallies.
 * The weights are intentionally simple and surfaced via `components` so a
 * consumer can always explain the number.
 */
export function summarizeRunRisk(steps: RiskTallyInput[]): RunRiskSummary {
  const components: RiskComponents = {
    highSteps: 0,
    mediumSteps: 0,
    writeSteps: 0,
    connectorWriteSteps: 0,
    externalHttpSteps: 0,
    unresolvedSteps: 0,
  };
  let highestOrder = 0;

  for (const s of steps) {
    highestOrder = Math.max(highestOrder, RISK_ORDER[s.effectiveRisk]);
    if (s.effectiveRisk === "high") components.highSteps += 1;
    else if (s.effectiveRisk === "medium") components.mediumSteps += 1;

    if (s.sideEffect === "local-write" || s.sideEffect === "connector-write") {
      components.writeSteps += 1;
    }
    if (s.sideEffect === "connector-write") components.connectorWriteSteps += 1;
    if (s.sideEffect === "external-http") components.externalHttpSteps += 1;
    if (!s.resolved) components.unresolvedSteps += 1;
  }

  const score = clamp100(
    components.highSteps * 30 +
      components.mediumSteps * 10 +
      components.writeSteps * 8 +
      components.connectorWriteSteps * 10 +
      components.externalHttpSteps * 6 +
      components.unresolvedSteps * 5,
  );

  const highestStepRisk = RISK_BY_ORDER[highestOrder] ?? "low";
  let tier: RiskTier;
  if (highestStepRisk === "high" || score >= 60) tier = "high";
  else if (highestStepRisk === "medium" || score >= 25) tier = "medium";
  else tier = "low";

  return { score, tier, components, highestStepRisk };
}
