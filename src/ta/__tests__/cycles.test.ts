import { describe, expect, it } from "vitest";
import { projectTimePivots } from "../cycles.js";
import { BAR_INTERVAL_MS, PIVOT_SEQUENCE, type Swing } from "../types.js";

const swing: Swing = {
  index: 10,
  time: 1_000_000_000_000,
  price: 100,
  kind: "low",
};

describe("projectTimePivots", () => {
  it("projects every pivot in the sequence", () => {
    const pivots = projectTimePivots(swing, "1d");
    expect(pivots.map((p) => p.n)).toEqual([...PIVOT_SEQUENCE]);
  });

  it("projects 1d pivots at n·86_400_000 ms from the swing", () => {
    const pivots = projectTimePivots(swing, "1d");
    const p7 = pivots.find((p) => p.n === 7)!;
    expect(p7.projectedTime).toBe(swing.time + 7 * BAR_INTERVAL_MS["1d"]);
    expect(p7.projectedDate).toBe(new Date(p7.projectedTime).toISOString());
  });

  it("uses the 4h interval and flags it as less reliable than 1d", () => {
    const pivots = projectTimePivots(swing, "4h");
    const p28 = pivots.find((p) => p.n === 28)!;
    expect(p28.projectedTime).toBe(swing.time + 28 * BAR_INTERVAL_MS["4h"]);
    expect(p28.moreReliable).toBe(false);
    expect(projectTimePivots(swing, "1d")[0]!.moreReliable).toBe(true);
  });

  it("carries the source swing identity onto each pivot", () => {
    const p = projectTimePivots(swing, "1d")[0]!;
    expect(p.fromSwingIndex).toBe(swing.index);
    expect(p.fromSwingKind).toBe("low");
    expect(p.fromSwingTime).toBe(swing.time);
  });
});
