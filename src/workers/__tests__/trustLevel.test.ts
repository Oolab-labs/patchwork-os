import { describe, expect, it } from "vitest";
import {
  applyOutcome,
  DEFAULT_PRIOR,
  evidenceCount,
  levelFromPosterior,
  type Posterior,
  posteriorMean,
  priorFromCompetence,
} from "../trustLevel.js";

function applyN(
  p: Posterior,
  n: number,
  good: boolean,
  weight: number,
): Posterior {
  let cur = p;
  for (let i = 0; i < n; i++) cur = applyOutcome(cur, good, weight);
  return cur;
}

const ALL_REACHABLE = [0, 1, 2, 3, 4];
const IRREVERSIBLE_REACHABLE = [0, 1, 4];

describe("trustLevel — cold start", () => {
  it("a fresh uniform prior floors at L0 (wide posterior → low bound)", () => {
    const r = levelFromPosterior(DEFAULT_PRIOR, DEFAULT_PRIOR, {
      reachable: ALL_REACHABLE,
    });
    expect(r.level).toBe(0);
  });

  it("a high-mean competence prior with no local evidence is still capped at L1", () => {
    // strength=8 contributes 6 pseudo-obs toward the floor (10 required).
    // With 0 real observations, effectiveEvidence=6 < 10 → still L1.
    const prior = priorFromCompetence(0.95, 8);
    const r = levelFromPosterior(prior, prior, { reachable: ALL_REACHABLE });
    expect(evidenceCount(prior, prior)).toBe(0);
    expect(r.level).toBeLessThanOrEqual(1);
  });

  it("strong prior (strength=8) reduces cold-start: 4 real obs graduate past L1", () => {
    // strength=8 → priorContribution=6; 4 real obs → effectiveEvidence=10 → floor lifted.
    const prior = priorFromCompetence(0.95, 8);
    const p = applyN(prior, 4, true, 1);
    const r = levelFromPosterior(p, prior, { reachable: ALL_REACHABLE });
    expect(evidenceCount(p, prior)).toBe(4);
    expect(r.level).toBeGreaterThan(1); // floor no longer blocks
  });

  it("default prior offers no cold-start reduction: 4 real obs still capped at L1", () => {
    // DEFAULT_PRIOR (alpha=1, beta=1) contributes 0 extra → effectiveEvidence=4 < 10.
    const p = applyN(DEFAULT_PRIOR, 4, true, 1);
    const r = levelFromPosterior(p, DEFAULT_PRIOR, {
      reachable: ALL_REACHABLE,
    });
    expect(r.level).toBeLessThanOrEqual(1);
  });
});

describe("trustLevel — slow climb", () => {
  it("reaches L4 only after sustained success on a reversible class (~dozens of obs)", () => {
    const p = applyN(DEFAULT_PRIOR, 60, true, 1);
    const r = levelFromPosterior(p, DEFAULT_PRIOR, {
      reachable: ALL_REACHABLE,
    });
    expect(r.level).toBe(4);
  });

  it("a handful of successes is NOT enough to graduate past L1", () => {
    const p = applyN(DEFAULT_PRIOR, 5, true, 1);
    const r = levelFromPosterior(p, DEFAULT_PRIOR, {
      reachable: ALL_REACHABLE,
    });
    expect(r.level).toBeLessThanOrEqual(1);
  });
});

describe("trustLevel — instant demote (asymmetry)", () => {
  it("one high-blast failure craters a long-earned L4 in a single step", () => {
    const earned = applyN(DEFAULT_PRIOR, 60, true, 1);
    expect(
      levelFromPosterior(earned, DEFAULT_PRIOR, { reachable: ALL_REACHABLE })
        .level,
    ).toBe(4);
    // a single catastrophic failure (blast-weighted weight 36)
    const after = applyOutcome(earned, false, 36);
    const r = levelFromPosterior(after, DEFAULT_PRIOR, {
      reachable: ALL_REACHABLE,
    });
    expect(r.level).toBeLessThanOrEqual(1);
  });
});

describe("trustLevel — reachability clamp", () => {
  it("an irreversible class at a would-be-L3 posterior stays at L1 (skips L2/L3)", () => {
    const p = applyN(DEFAULT_PRIOR, 30, true, 1); // lands ~L3 by LCB
    const rev = levelFromPosterior(p, DEFAULT_PRIOR, {
      reachable: ALL_REACHABLE,
    });
    expect(rev.rawLevel).toBeGreaterThanOrEqual(2);
    const irrev = levelFromPosterior(p, DEFAULT_PRIOR, {
      reachable: IRREVERSIBLE_REACHABLE,
    });
    expect(irrev.level).toBe(1); // highest reachable rung ≤ rawLevel
  });

  it("an irreversible class jumps straight L1→L4 once it clears the top bar", () => {
    const p = applyN(DEFAULT_PRIOR, 120, true, 1);
    const r = levelFromPosterior(p, DEFAULT_PRIOR, {
      reachable: IRREVERSIBLE_REACHABLE,
    });
    expect(r.level).toBe(4);
  });
});

describe("priorFromCompetence", () => {
  it("encodes the claimed mean and caps strength so it can be overcome", () => {
    const p = priorFromCompetence(0.9, 100);
    expect(posteriorMean(p)).toBeCloseTo(0.9, 2);
    expect(p.alpha + p.beta).toBeLessThanOrEqual(8); // strength capped
  });
});
