import {
  type ActionClass,
  classifyActionClass,
  outcomeWeight,
  reachableLevels,
} from "./actionClass.js";
import {
  applyOutcome,
  levelFromPosterior,
  type Posterior,
  type TrustLevel,
} from "./trustLevel.js";

/**
 * Folds outcomes into a (worker × action-class) trust state and decides
 * promotions/demotions with the asymmetry + hysteresis the ramp requires:
 *   - DEMOTE is instant and can jump multiple rungs (one catastrophic outcome
 *     craters the posterior; we honor it immediately, even mid-dwell);
 *   - PROMOTE is gated by dwell-time (real elapsed time since the last level
 *     change) AND a post-demote cooldown, and climbs only to the NEXT reachable
 *     rung — so reaching L4 needs both sustained evidence and sustained time.
 * Every level change emits an event — the promotion/demotion log is the
 * compliance/audit artifact.
 */

export interface Outcome {
  toolName: string;
  good: boolean;
  /** epoch ms (passed in — the runtime has no Date.now() in pure code). */
  at: number;
  params?: Record<string, unknown>;
}

export interface ClassTrustState {
  classKey: string;
  posterior: Posterior;
  prior: Posterior;
  level: TrustLevel;
  /** epoch ms of the last level change (drives dwell). */
  lastChangeAt: number;
  /** epoch ms before which promotions are blocked (post-demote cooldown). */
  demoteUntil: number;
  observations: number;
  /**
   * The `minEvidenceForGraduation` threshold in effect when this class last
   * promoted ABOVE L1. The novel-class floor is a cold-start gate: once a class
   * has cleared it, RAISING the config later must not retroactively re-apply the
   * floor and demote an already-earned level. We honour the threshold the class
   * actually graduated under. `undefined` = never promoted above L1 (cold-start;
   * the current config applies in full).
   */
  minEvidenceAtLastPromotion?: number;
}

export interface GraduationConfig {
  dwellMs: number;
  demoteCooldownMs: number;
  k?: number;
  minEvidenceForGraduation?: number;
}

/** Default novel-class floor — MUST match levelFromPosterior's internal `?? 10`
 *  so a config that omits the field behaves identically through both paths. */
const DEFAULT_MIN_EVIDENCE = 10;

export const DEFAULT_GRADUATION_CONFIG: GraduationConfig = {
  dwellMs: 6 * 60 * 60 * 1000, // 6h between climbs
  demoteCooldownMs: 24 * 60 * 60 * 1000, // 24h freeze after a fall
  minEvidenceForGraduation: DEFAULT_MIN_EVIDENCE,
};

export interface GraduationEvent {
  type: "promote" | "demote";
  classKey: string;
  from: TrustLevel;
  to: TrustLevel;
  at: number;
  lcb: number;
  evidence: number;
  reason: string;
}

export function initialState(
  classKey: string,
  prior: Posterior,
  at = 0,
): ClassTrustState {
  return {
    classKey,
    posterior: prior,
    prior,
    level: 0,
    lastChangeAt: at,
    demoteUntil: 0,
    observations: 0,
  };
}

export function graduate(
  state: ClassTrustState,
  outcome: Outcome,
  cfg: GraduationConfig = DEFAULT_GRADUATION_CONFIG,
): { state: ClassTrustState; event?: GraduationEvent } {
  const ac: ActionClass = classifyActionClass(outcome.toolName, outcome.params);
  const weight = outcomeWeight(ac, outcome.good);
  const posterior = applyOutcome(state.posterior, outcome.good, weight);
  const observations = state.observations + 1;

  // Novel-class floor threshold. For a class already ABOVE L1, honour the
  // (possibly looser) threshold it graduated under so a later config TIGHTENING
  // can't retroactively floor it back to L1 and trigger a spurious demote. A
  // class still in cold-start (≤ L1) always faces the current config in full.
  // `Math.min` also lets a config LOOSENING apply immediately. Genuine
  // evidence-based demotions (LCB crash from real failures) are unaffected —
  // they don't go through the floor.
  // Resolve to a concrete number (matches levelFromPosterior's internal `?? 10`)
  // so the recorded threshold is always defined.
  const cfgMinEvidence = cfg.minEvidenceForGraduation ?? DEFAULT_MIN_EVIDENCE;
  const floorMinEvidence =
    state.level > 1 && state.minEvidenceAtLastPromotion !== undefined
      ? Math.min(cfgMinEvidence, state.minEvidenceAtLastPromotion)
      : cfgMinEvidence;

  const result = levelFromPosterior(posterior, state.prior, {
    k: cfg.k,
    minEvidenceForGraduation: floorMinEvidence,
    reachable: reachableLevels(ac),
  });
  const candidate = result.level;

  const base: ClassTrustState = {
    ...state,
    posterior,
    observations,
  };

  // DEMOTE — instant, may skip rungs.
  if (candidate < state.level) {
    const next: ClassTrustState = {
      ...base,
      level: candidate,
      lastChangeAt: outcome.at,
      demoteUntil: outcome.at + cfg.demoteCooldownMs,
    };
    return {
      state: next,
      event: {
        type: "demote",
        classKey: state.classKey,
        from: state.level,
        to: candidate,
        at: outcome.at,
        lcb: result.lcb,
        evidence: result.evidence,
        reason: `blast-weighted failure (weight=${weight})`,
      },
    };
  }

  // PROMOTE — gated by dwell + cooldown, one reachable rung at a time.
  if (candidate > state.level) {
    const dwellOk = outcome.at >= state.lastChangeAt + cfg.dwellMs;
    const cooldownOk = outcome.at >= state.demoteUntil;
    if (dwellOk && cooldownOk) {
      const nextRung = reachableLevels(ac)
        .filter((r) => r > state.level && r <= candidate)
        .sort((a, b) => a - b)[0];
      if (nextRung !== undefined) {
        const to = nextRung as TrustLevel;
        return {
          state: {
            ...base,
            level: to,
            lastChangeAt: outcome.at,
            // Record the floor it just cleared (only meaningful above L1, where
            // the floor actually gates). Keeps the running threshold the class
            // has demonstrably satisfied, for the retroactive-demotion guard.
            ...(to > 1 && {
              minEvidenceAtLastPromotion: floorMinEvidence,
            }),
          },
          event: {
            type: "promote",
            classKey: state.classKey,
            from: state.level,
            to,
            at: outcome.at,
            lcb: result.lcb,
            evidence: result.evidence,
            reason: `sustained evidence (lcb=${result.lcb.toFixed(3)})`,
          },
        };
      }
    }
  }

  // No level change — posterior still updates.
  return { state: base };
}
