/**
 * Bayesian trust model for a single (worker × action-class) pair.
 *
 * Reliability `p` (the probability that an action of this class is "good") is a
 * Beta(α, β) posterior. The discrete autonomy rung L0–L4 is a threshold
 * crossing of the posterior's LOWER confidence bound, not its mean. Using the
 * lower bound is what makes the ramp behave correctly:
 *   - cold-start floors automatically: a fresh/wide posterior has a low bound
 *     even if its mean is optimistic, so a worker (or a marketplace prior) can't
 *     start trusted — uncertainty must collapse on local evidence first;
 *   - climbing is slow: the bound only rises as the mean rises AND variance
 *     shrinks, i.e. with sustained evidence;
 *   - demotion is instant: one high-weight failure spikes β, the mean drops and
 *     the bound craters in a single step.
 *
 * Asymmetry ("slow up, instant down") is therefore information, not a tuned
 * rule — it falls out of weighting failures by blast radius (see actionClass).
 */

export interface Posterior {
  readonly alpha: number;
  readonly beta: number;
}

/** Uniform prior — maximally uncertain, no shipped competence. */
export const DEFAULT_PRIOR: Posterior = { alpha: 1, beta: 1 };

/**
 * Build a prior from a competence claim: a mean reliability + a strength
 * (pseudo-count). Low strength = wide uncertainty = the bound stays low until
 * local evidence accumulates. This is how a marketplace worker ships
 * competence (a mean) without shipping trust (the bound only tightens on the
 * operator's own data). Strength is capped low on purpose.
 */
export function priorFromCompetence(mean: number, strength: number): Posterior {
  const m = Math.min(0.99, Math.max(0.01, mean));
  const s = Math.min(8, Math.max(0.5, strength));
  return { alpha: m * s, beta: (1 - m) * s };
}

export function posteriorMean(p: Posterior): number {
  return p.alpha / (p.alpha + p.beta);
}

export function posteriorStddev(p: Posterior): number {
  const n = p.alpha + p.beta;
  return Math.sqrt((p.alpha * p.beta) / (n * n * (n + 1)));
}

/** Lower confidence bound: mean − k·σ, clamped to [0, 1]. The level reads off
 * THIS, not the mean. */
export function lowerConfidenceBound(p: Posterior, k = 1.5): number {
  return Math.max(0, Math.min(1, posteriorMean(p) - k * posteriorStddev(p)));
}

/** Apply one outcome. A good outcome adds to α, a bad one to β, scaled by the
 * blast-weighted evidence weight from actionClass.outcomeWeight. */
export function applyOutcome(
  p: Posterior,
  good: boolean,
  weight: number,
): Posterior {
  return good
    ? { alpha: p.alpha + weight, beta: p.beta }
    : { alpha: p.alpha, beta: p.beta + weight };
}

/** Total evidence accumulated relative to the prior (pseudo-observations). */
export function evidenceCount(p: Posterior, prior: Posterior): number {
  return p.alpha + p.beta - (prior.alpha + prior.beta);
}

export type TrustLevel = 0 | 1 | 2 | 3 | 4;

/** LCB → rung. Tunable; conservative by default. */
export const DEFAULT_THRESHOLDS: ReadonlyArray<{
  min: number;
  level: TrustLevel;
}> = [
  { min: 0.95, level: 4 },
  { min: 0.85, level: 3 },
  { min: 0.7, level: 2 },
  { min: 0.5, level: 1 },
  { min: 0, level: 0 },
];

export interface LevelOpts {
  k?: number;
  /** Min evidence before a class may exceed L1 (novel-class floor). */
  minEvidenceForGraduation?: number;
  /** Rungs reachable for this class (irreversible classes omit L2/L3). */
  reachable?: number[];
  thresholds?: ReadonlyArray<{ min: number; level: TrustLevel }>;
}

export interface LevelResult {
  level: TrustLevel;
  /** Level before the novel-floor + reachability clamps (for diagnostics). */
  rawLevel: TrustLevel;
  lcb: number;
  mean: number;
  evidence: number;
}

/**
 * Map a posterior to a discrete rung, applying:
 *  1. LCB → raw level via thresholds.
 *  2. Novel-class floor: below the evidence minimum, cap at L1 regardless of how
 *     good the (necessarily wide) posterior looks — no class graduates on faith.
 *  3. Reachability clamp: drop to the highest reachable rung ≤ the computed one,
 *     so an irreversible class climbing through "would-be L2/L3" stays at L1
 *     until it actually clears the L4 bar.
 */
export function levelFromPosterior(
  p: Posterior,
  prior: Posterior,
  opts: LevelOpts = {},
): LevelResult {
  const k = opts.k ?? 1.5;
  const minEvidence = opts.minEvidenceForGraduation ?? 10;
  const reachable = opts.reachable ?? [0, 1, 2, 3, 4];
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  const lcb = lowerConfidenceBound(p, k);
  const mean = posteriorMean(p);
  const evidence = evidenceCount(p, prior);

  const rawLevel =
    thresholds.find((t) => lcb >= t.min)?.level ?? (0 as TrustLevel);

  let level: TrustLevel = rawLevel;
  // Novel-class floor.
  if (evidence < minEvidence && level > 1) level = 1;
  // Reachability clamp (highest reachable rung ≤ level).
  const allowed = reachable.filter((r) => r <= level);
  level = (allowed.length ? Math.max(...allowed) : 0) as TrustLevel;

  return { level, rawLevel, lcb, mean, evidence };
}
