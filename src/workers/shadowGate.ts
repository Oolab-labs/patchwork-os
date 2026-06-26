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
 * Only the two execution modes that already exist are actionable in v0:
 *   L4 → bypass (autonomous), everything below → queue (approve-each).
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

const AUTONOMOUS_LEVEL = 4;

export function recommend(
  worker: WorkerManifest,
  toolName: string,
  params: Record<string, unknown> | undefined,
  store: WorkerLevelStore,
): ShadowDecision {
  const ac = classifyActionClass(toolName, params);
  const owned = ownsAction(worker, ac);
  const earnedLevel = (store.getState(worker.id, ac.key)?.level ??
    0) as TrustLevel;

  let effectiveLevel: TrustLevel = owned ? earnedLevel : 0;
  if (effectiveLevel > worker.autonomyCeiling)
    effectiveLevel = worker.autonomyCeiling;

  const decision = effectiveLevel >= AUTONOMOUS_LEVEL ? "bypass" : "queue";

  let reason: string;
  if (!owned) reason = "outside-worker-domain";
  else if (worker.autonomyCeiling < earnedLevel)
    reason = `capped-by-autonomy-ceiling (L${worker.autonomyCeiling}, earned L${earnedLevel})`;
  else if (decision === "bypass") reason = "autonomous (earned L4)";
  else reason = `below-autonomy (effective L${effectiveLevel})`;

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
