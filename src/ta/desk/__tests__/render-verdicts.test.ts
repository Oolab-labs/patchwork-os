/**
 * renderLedger verdict path — Phase 3 build gate.
 *
 * Verifies that when verdicts are passed to renderLedger:
 *   - WATCH verdict shows N, win-rate, Wilson CI, p-value in the md
 *   - GRADED verdict shows GRADED label + all stats
 *   - FALSIFIED verdict appears in the audit section
 *   - Every number emitted in md is registered in the numbers array
 *   - Verdict with no corresponding LedgerSummary cell still renders
 */

import { describe, expect, it } from "vitest";
import type { Verdict } from "../cellBacktest.js";
import type { LedgerSummary } from "../deskLedger.js";
import { renderLedger } from "../render.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function baseLedger(): LedgerSummary {
  return {
    asOf: "2026-06-19T00:00:00.000Z",
    cells: [],
    openClaims: 0,
    gradedClaims: 0,
  };
}

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    cellName: "wp-volume-climax",
    methodVersion: "wpvc-1d-v1",
    gitSha: "abc123",
    seeds: { rng: 101, permutation: 777, null: 4242 },
    candleSetHash: "deadbeef01234567",
    N: 115,
    methodWinRate: 0.57,
    nullWinRate: 0.5,
    edge: 0.07,
    wilsonLow: 0.48,
    wilsonHigh: 0.66,
    permutationP: 0.088,
    familyAdjustedP: 0.088,
    perRegime: [
      { regime: "bull", N: 60, winRate: 0.62, edge: 0.12 },
      { regime: "bear", N: 30, winRate: 0.5, edge: 0.0 },
      { regime: "chop", N: 25, winRate: 0.48, edge: -0.02 },
    ],
    signConsistent: false,
    gateState: "WATCH",
    failReason: "permutation p=0.088 > 0.050",
    runTs: "2026-06-19T07:00:00.000Z",
    familyN: 1,
    timeframe: "1d",
    ...overrides,
  };
}

// ── WATCH verdict render ───────────────────────────────────────────────────────

describe("renderLedger with WATCH verdict", () => {
  it("shows cell name in md", () => {
    const frag = renderLedger(
      baseLedger(),
      null,
      new Map([["wp-volume-climax", makeVerdict()]]),
    );
    expect(frag.md).toContain("wp-volume-climax");
  });

  it("shows N in md", () => {
    const frag = renderLedger(
      baseLedger(),
      null,
      new Map([["wp-volume-climax", makeVerdict({ N: 115 })]]),
    );
    expect(frag.md).toContain("N=115");
  });

  it("shows p-value in md", () => {
    const frag = renderLedger(
      baseLedger(),
      null,
      new Map([["wp-volume-climax", makeVerdict({ permutationP: 0.088 })]]),
    );
    expect(frag.md).toContain("p=0.088");
  });

  it("shows Wilson CI bounds in md", () => {
    const frag = renderLedger(
      baseLedger(),
      null,
      new Map([
        [
          "wp-volume-climax",
          makeVerdict({ wilsonLow: 0.48, wilsonHigh: 0.66 }),
        ],
      ]),
    );
    expect(frag.md).toContain("48");
    expect(frag.md).toContain("66");
  });

  it("does NOT say GRADED for a WATCH cell", () => {
    const frag = renderLedger(
      baseLedger(),
      null,
      new Map([["wp-volume-climax", makeVerdict({ gateState: "WATCH" })]]),
    );
    expect(frag.md).not.toContain("GRADED");
  });

  it("says gate not reached for a WATCH cell", () => {
    const frag = renderLedger(
      baseLedger(),
      null,
      new Map([["wp-volume-climax", makeVerdict({ gateState: "WATCH" })]]),
    );
    expect(frag.md).toContain("gate not reached");
  });

  it("indexes N in numbers array", () => {
    const frag = renderLedger(
      baseLedger(),
      null,
      new Map([["wp-volume-climax", makeVerdict({ N: 115 })]]),
    );
    const tokens = frag.numbers.map((n) => n.token);
    expect(tokens).toContain("115");
  });

  it("indexes permutationP in numbers array", () => {
    const frag = renderLedger(
      baseLedger(),
      null,
      new Map([["wp-volume-climax", makeVerdict({ permutationP: 0.088 })]]),
    );
    const tokens = frag.numbers.map((n) => n.token);
    expect(tokens).toContain("0.088");
  });
});

// ── GRADED verdict render ──────────────────────────────────────────────────────

describe("renderLedger with GRADED verdict", () => {
  const gradedVerdict = makeVerdict({
    gateState: "GRADED",
    failReason: undefined,
    N: 120,
    permutationP: 0.021,
    familyAdjustedP: 0.021,
    signConsistent: true,
  });

  it("shows GRADED label in md", () => {
    const frag = renderLedger(
      baseLedger(),
      null,
      new Map([["wp-volume-climax", gradedVerdict]]),
    );
    expect(frag.md).toContain("GRADED");
  });

  it("shows N and p-value for GRADED cell", () => {
    const frag = renderLedger(
      baseLedger(),
      null,
      new Map([["wp-volume-climax", gradedVerdict]]),
    );
    expect(frag.md).toContain("N=120");
    expect(frag.md).toContain("p=0.021");
  });

  it("indexes N in numbers array for GRADED", () => {
    const frag = renderLedger(
      baseLedger(),
      null,
      new Map([["wp-volume-climax", gradedVerdict]]),
    );
    const tokens = frag.numbers.map((n) => n.token);
    expect(tokens).toContain("120");
  });
});

// ── FALSIFIED verdict render ───────────────────────────────────────────────────

describe("renderLedger with FALSIFIED verdict", () => {
  it("shows FALSIFIED in audit section", () => {
    const frag = renderLedger(
      baseLedger(),
      null,
      new Map([
        [
          "wp-volume-climax",
          makeVerdict({ gateState: "FALSIFIED", N: 60, edge: -0.05 }),
        ],
      ]),
    );
    expect(frag.md).toContain("FALSIFIED");
    expect(frag.md).toContain("wp-volume-climax");
  });

  it("does NOT appear in GRADED or WATCH sections", () => {
    const frag = renderLedger(
      baseLedger(),
      null,
      new Map([
        [
          "wp-volume-climax",
          makeVerdict({ gateState: "FALSIFIED", N: 60, edge: -0.05 }),
        ],
      ]),
    );
    expect(frag.md).not.toContain("GRADED");
    expect(frag.md).not.toContain("not significant");
  });
});

// ── No verdicts ────────────────────────────────────────────────────────────────

describe("renderLedger without verdicts", () => {
  it("renders without error when verdicts is undefined", () => {
    expect(() => renderLedger(baseLedger(), null, undefined)).not.toThrow();
  });

  it("renders without error when verdicts is empty Map", () => {
    expect(() => renderLedger(baseLedger(), null, new Map())).not.toThrow();
  });
});
