import { classifyActionClass } from "./actionClass.js";
import type { TrustLevel } from "./trustLevel.js";
import { ownsAction, type WorkerManifest } from "./worker.js";
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
}

const COMPENSABLE_AUTONOMY_LEVEL = 2;
const AUTONOMOUS_LEVEL = 4;

export function recommend(
  worker: WorkerManifest,
  toolName: string,
  params: Record<string, unknown> | undefined,
  store: WorkerLevelStore,
): ShadowDecision {
  const ac = classifyActionClass(toolName, params);
  const owned = ownsAction(worker, ac);

  // Reversible actions always bypass — no trust threshold applies. Short-
  // circuiting here prevents false divergence-log noise (the dial would
  // otherwise compare against L4 and always report a "miss" for reads).
  if (ac.reversibility === "reversible") {
    const earnedLevel = (store.getState(worker.id, ac.key)?.level ??
      0) as TrustLevel;
    return {
      decision: "bypass",
      classKey: ac.key,
      owned,
      earnedLevel,
      autonomyCeiling: worker.autonomyCeiling,
      effectiveLevel: owned ? earnedLevel : (0 as TrustLevel),
      reason: "reversible — flows un-gated regardless of earned level",
    };
  }
  const earnedLevel = (store.getState(worker.id, ac.key)?.level ??
    0) as TrustLevel;

  let effectiveLevel: TrustLevel = owned ? earnedLevel : 0;
  if (effectiveLevel > worker.autonomyCeiling)
    effectiveLevel = worker.autonomyCeiling;

  const decision: "bypass" | "queue" =
    ac.reversibility === "compensable"
      ? effectiveLevel >= COMPENSABLE_AUTONOMY_LEVEL
        ? "bypass"
        : "queue"
      : effectiveLevel >= AUTONOMOUS_LEVEL
        ? "bypass"
        : "queue";

  const threshold =
    ac.reversibility === "compensable"
      ? COMPENSABLE_AUTONOMY_LEVEL
      : AUTONOMOUS_LEVEL;
  let reason: string;
  if (!owned) reason = "outside-worker-domain";
  else if (worker.autonomyCeiling < threshold)
    reason = `capped-by-autonomy-ceiling (L${worker.autonomyCeiling} < L${threshold}, earned L${earnedLevel})`;
  else if (decision === "bypass")
    reason = `autonomous (earned L${effectiveLevel}, threshold L${threshold})`;
  else reason = `below-autonomy (effective L${effectiveLevel} < L${threshold})`;

  return {
    decision,
    classKey: ac.key,
    owned,
    earnedLevel,
    autonomyCeiling: worker.autonomyCeiling,
    effectiveLevel,
    reason,
  };
}
