import { classifyActionClass } from "./actionClass.js";
import type { TrustLevel } from "./trustLevel.js";
import { ownsAction, type WorkerManifest } from "./worker.js";
import { type AutonomyDecisionOpts, decideWorkerAction } from "./workerGate.js";
import type { WorkerLevelStore } from "./workerLevelStore.js";

/**
 * What the ramp WOULD decide for a worker's action — a PURE recommendation.
 *
 * v0 is shadow-only: this is NOT wired into the live approval gate
 * (`evaluateInProcessGate`). Flipping the gate to obey the ramp is a deliberate,
 * flag-gated phase-2 step, taken only after shadow data shows the ramp's
 * decisions track reality. Until then this exists to log "ramp would bypass /
 * gate did queue" and to drive the dial.
 *
 * The effective level drives two thresholds that mirror the live gate:
 *   compensable at L2+ → bypass; irreversible at L4+ → bypass; else → queue.
 * The full earned level (0–4) is reported for the dial. The effective level is
 * `min(earned, autonomyCeiling)`, floored to 0 for actions outside the worker's
 * domain — a worker has no standing trust on things it doesn't own.
 */

export interface ShadowDecision {
  decision: "queue" | "bypass";
  classKey: string;
  owned: boolean;
  /** Trust the worker has actually earned on this class (drives the dial). */
  earnedLevel: TrustLevel;
  autonomyCeiling: TrustLevel;
  /** What the gate would operate at: min(earned, ceiling), 0 if not owned. */
  effectiveLevel: TrustLevel;
  reason: string;
  /**
   * The gate FORBIDS this outright — no earned trust and no human approval
   * unlocks it (ADR-0017's third terminal state).
   *
   * `decision` collapses to `queue` for a forbidden action because this type
   * predates `forbid` and its two consumers count queue-vs-bypass. Collapsing
   * without saying so would report a ban as an ordinary approval, so the fact
   * is carried separately rather than lost.
   */
  forbidden: boolean;
}

/**
 * Delegates to `decideWorkerAction`. It used to reimplement the trust maths,
 * and had drifted: it has the reversibility short-circuit and the autonomy
 * ceiling, and never gained `forbid` or the context ceiling. Measured on a
 * spread of tools and context scores, HALF the combinations disagreed — and
 * every disagreement ran permissive, including reporting `bypass` for a
 * forbidden reversible action.
 *
 * That matters more here than almost anywhere: this is what
 * `patchwork workers shadow` and `patchwork workers backtest` run, which the
 * dogfood runbook calls the primary instrument for watching the ramp. An
 * instrument that disagrees with what it measures does not fail loudly — it
 * reports a number, and the number is wrong.
 *
 * CLAUDE.md already states the rule, for `previewActions`: a second copy of
 * the decision "would drift, and the failure is silent and permissive". Same
 * rule, same reason. Not correct one copy — leave only one.
 *
 * The mapping is the honest one, and lossy in a stated direction:
 *
 *     gate allow  → bypass
 *     gate gate   → queue
 *     gate forbid → queue, with `forbidden: true`
 */
export function recommend(
  worker: WorkerManifest,
  toolName: string,
  params: Record<string, unknown> | undefined,
  store: WorkerLevelStore,
  opts?: AutonomyDecisionOpts,
): ShadowDecision {
  const ac = classifyActionClass(toolName, params);
  const owned = ownsAction(worker, ac);
  const earnedLevel = (store.getState(worker.id, ac.key)?.level ??
    0) as TrustLevel;
  const decided = decideWorkerAction(worker, toolName, params, store, opts);

  return {
    decision: decided.action === "allow" ? "bypass" : "queue",
    forbidden: decided.action === "forbid",
    classKey: ac.key,
    owned,
    earnedLevel,
    autonomyCeiling: worker.autonomyCeiling,
    effectiveLevel: decided.effectiveLevel ?? (owned ? earnedLevel : 0),
    reason: decided.reason,
  };
}
