import { describe, expect, it } from "vitest";
import type { Candle } from "../../types.js";
import { OUTCOME_WINDOW } from "../scoring.js";
import { runWalkForward } from "../walkForward.js";

const DAY = 86_400_000;

/** Oscillating series with clear fractal swings (~9-bar half-cycle). */
function wave(len: number): Candle[] {
  const c: Candle[] = [];
  for (let i = 0; i < len; i++) {
    const base = 100 + 20 * Math.sin(i / 3);
    c.push({
      openTime: i * DAY,
      open: base,
      high: base + 1,
      low: base - 1,
      close: base,
      volume: 0,
      closeTime: i * DAY + (DAY - 1),
    });
  }
  return c;
}

describe("runWalkForward", () => {
  it("produces predictions across claim types on a swinging series", () => {
    const preds = runWalkForward(wave(300), { asset: "X", timeframe: "1d" });
    expect(preds.length).toBeGreaterThan(0);
    const types = new Set(preds.map((p) => p.type));
    expect(types.has("price-third")).toBe(true);
    expect(types.has("price-fifty")).toBe(true);
    expect(types.has("time-cycle")).toBe(true);
  });

  it("only emits forward-scorable predictions (cursor leaves a full window)", () => {
    const candles = wave(300);
    const preds = runWalkForward(candles, { asset: "X", timeframe: "1d" });
    const lastCursor = candles.length - 1 - OUTCOME_WINDOW;
    for (const p of preds) {
      expect(p.cursorIndex).toBeGreaterThanOrEqual(60);
      expect(p.cursorIndex).toBeLessThanOrEqual(lastCursor);
    }
  });

  it("is deterministic for a fixed seed", () => {
    const a = runWalkForward(wave(250), {
      asset: "X",
      timeframe: "1d",
      seed: 7,
    });
    const b = runWalkForward(wave(250), {
      asset: "X",
      timeframe: "1d",
      seed: 7,
    });
    expect(b).toEqual(a);
  });

  it("method hits are RNG-independent; only baselines move with the seed", () => {
    const a = runWalkForward(wave(250), {
      asset: "X",
      timeframe: "1d",
      seed: 1,
    });
    const b = runWalkForward(wave(250), {
      asset: "X",
      timeframe: "1d",
      seed: 999,
    });
    expect(b.map((p) => p.hit)).toEqual(a.map((p) => p.hit));
    // baselines should differ for at least one prediction (sanity on the RNG)
    expect(b.map((p) => p.baselineHit)).not.toEqual(
      a.map((p) => p.baselineHit),
    );
  });

  it("dedups repeated setups (no two predictions share a cursor+type+n key en masse)", () => {
    const preds = runWalkForward(wave(300), { asset: "X", timeframe: "1d" });
    const cycleKeys = preds
      .filter((p) => p.type === "time-cycle")
      .map((p) => `${p.cursorIndex}:${p.n}`);
    // each cycle prediction is unique per (swing,n); a given cursor shouldn't
    // emit the same n twice
    expect(new Set(cycleKeys).size).toBe(cycleKeys.length);
  });
});
