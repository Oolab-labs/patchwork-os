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
}

export interface GraduationConfig {
  dwellMs: number;
  demoteCooldownMs: number;
  k?: number;
  minEvidenceForGraduation?: number;
}

export const DEFAULT_GRADUATION_CONFIG: GraduationConfig = {
  dwellMs: 6 * 60 * 60 * 1000, // 6h between climbs
  demoteCooldownMs: 24 * 60 * 60 * 1000, // 24h freeze after a fall
  minEvidenceForGraduation: 10,
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

  const result = levelFromPosterior(posterior, state.prior, {
    k: cfg.k,
    minEvidenceForGraduation: cfg.minEvidenceForGraduation,
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
          state: { ...base, level: to, lastChangeAt: outcome.at },
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
