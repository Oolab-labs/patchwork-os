import type { TrustLevel } from "./trustLevel.js";

/**
 * Context-risk — the FAST, situational half of the autonomy decision.
 *
 * Earned trust answers "is this worker generally reliable on this action-class?"
 * (slow, accrued over many runs). Context-risk answers a DIFFERENT, orthogonal
 * question: "is THIS situation safe to act in RIGHT NOW?" — computed per-action
 * from signals the bridge already exposes (open diagnostics in the touched
 * files, test coverage, git hotspot-ness, diff size, CI status). It has no
 * cold-start: it is fully computable on day one, so it can de-rate autonomy from
 * the very first action while the trust posterior is still accruing.
 *
 * It is a DE-RATER only: it can lower the effective autonomy level, never raise
 * it (never-widen). Combined with earned trust + the autonomy ceiling, the gate
 * becomes `min(earned, ceiling, contextCeiling)` — a worker stays at its earned
 * level when the situation is clean and is throttled toward propose-only as live
 * risk climbs. This is the dimension "approve-once / approve-similar" structurally
 * cannot model. See docs/worker-autonomy-policy-gate.md §3a.
 */
export interface ContextRisk {
  /** 0 (clean) … 1 (dangerous). Out-of-range / NaN is treated as "unknown". */
  score: number;
  /** Human-readable contributors (e.g. "CI red", "diff 1.2k lines", "hotspot
   *  file"), surfaced in the gate reason + audit trail. */
  reasons?: string[];
}

/**
 * Map a context-risk score to the MAX autonomy rung permitted in this situation.
 * DESCENDING only — higher risk ⇒ lower ceiling. Returns L4 (no de-rate) for a
 * clean OR unknown/unmeasurable score: context-risk adds caution when danger is
 * MEASURED; when it can't be measured the base gate (earned trust + ceiling)
 * still applies its own floor, so an unknown situation must not silently throttle
 * everything to zero.
 */
export function contextRiskCeiling(score: number): TrustLevel {
  if (!Number.isFinite(score) || score <= 0) return 4; // clean / unknown → no de-rate
  if (score >= 0.8) return 0; // dangerous → propose-only: every risky action gated
  if (score >= 0.5) return 1; // elevated → reversible only flows freely
  if (score >= 0.3) return 2; // moderate → compensable ok, irreversible still gated
  return 4; // mild → no de-rate
}
