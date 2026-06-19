import { describe, expect, it } from "vitest";
import { computeLevels, FOURTH_LEVEL_TOP_HINT } from "../levels.js";

describe("computeLevels", () => {
  it("builds the thirds ladder with k=3 at the high and k=4 above it", () => {
    const lv = computeLevels(90, 120)!;
    expect(lv).not.toBeNull();
    expect(lv.range).toBe(30);
    expect(lv.ladder[0]!.price).toBe(90); // swing low
    expect(lv.ladder[1]!.price).toBe(100); // low + R/3
    expect(lv.ladder[2]!.price).toBe(110); // low + 2R/3
    expect(lv.ladder[3]!.price).toBe(120); // swing high ("full cycle")
    expect(lv.ladder[4]!.price).toBe(130); // fourth level
    expect(lv.fourthLevel).toBe(130);
  });

  it("tracks the 50% retracement separately from the ladder", () => {
    const lv = computeLevels(90, 120)!;
    expect(lv.fifty).toBe(105);
  });

  it("annotates (not learns) the fourth-level top probability", () => {
    const lv = computeLevels(90, 120)!;
    expect(lv.fourthLevelTopProbabilityHint).toBe(FOURTH_LEVEL_TOP_HINT);
  });

  it("handles a non-divisible range with float tolerance", () => {
    const lv = computeLevels(0, 10)!;
    expect(lv.ladder[1]!.price).toBeCloseTo(10 / 3, 9);
    expect(lv.fifty).toBe(5);
    expect(lv.fourthLevel).toBeCloseTo(40 / 3, 9);
  });

  it("returns null for a non-positive range (high <= low)", () => {
    expect(computeLevels(120, 90)).toBeNull();
    expect(computeLevels(100, 100)).toBeNull();
  });

  it("respects maxK depth and throws if it cannot reach the high", () => {
    expect(computeLevels(0, 30, 9)!.ladder).toHaveLength(10);
    expect(() => computeLevels(0, 30, 2)).toThrow();
  });
});
