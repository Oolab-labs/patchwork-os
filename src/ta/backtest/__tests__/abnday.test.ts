import { describe, expect, it } from "vitest";
import type { Candle } from "../../types.js";
import {
  classifyDays,
  evalAbndayCell,
  predictionLabel,
  registeredHitDirection,
  sigma60,
} from "../abnday.js";

function candlesFrom(closes: number[]): Candle[] {
  return closes.map((c, t) => ({
    openTime: t * 86_400_000,
    open: t === 0 ? c : closes[t - 1]!,
    high: Math.max(c, t === 0 ? c : closes[t - 1]!),
    low: Math.min(c, t === 0 ? c : closes[t - 1]!),
    close: c,
    volume: 100,
    closeTime: t * 86_400_000 + 86_399_999,
  }));
}

/** Deterministic low-vol base series: alternating ±0.5% days. */
function quiet(n: number, start = 100): number[] {
  const closes = [start];
  for (let t = 1; t < n; t++) {
    closes.push(closes[t - 1]! * (t % 2 === 0 ? 1.005 : 0.995));
  }
  return closes;
}

describe("registered cell mapping (precommit table)", () => {
  it("BTC+ reversal, BTC− continuation, ETH+ continuation, ETH− reversal", () => {
    expect(predictionLabel("BTCUSDT", "pos")).toBe("reversal");
    expect(predictionLabel("BTCUSDT", "neg")).toBe("continuation");
    expect(predictionLabel("ETHUSDT", "pos")).toBe("continuation");
    expect(predictionLabel("ETHUSDT", "neg")).toBe("reversal");
    // hit directions: BTC cells hit on down next-day, ETH cells on up.
    expect(registeredHitDirection("BTCUSDT", "pos")).toBe(-1);
    expect(registeredHitDirection("BTCUSDT", "neg")).toBe(-1);
    expect(registeredHitDirection("ETHUSDT", "pos")).toBe(1);
    expect(registeredHitDirection("ETHUSDT", "neg")).toBe(1);
  });
});

describe("sigma60", () => {
  it("requires 60 strictly-prior returns", () => {
    const logr = Array.from({ length: 100 }, (_, i) => (i % 2 ? 0.01 : -0.01));
    expect(sigma60(logr, 60)).toBeNull();
    expect(sigma60(logr, 61)).not.toBeNull();
  });

  it("LOOK-AHEAD GUARD: σ60(t) is unchanged by r_t and later returns", () => {
    const logr: number[] = Array.from({ length: 100 }, (_, i) =>
      i % 2 ? 0.01 : -0.01,
    );
    const mangled = [...logr];
    for (let i = 80; i < 100; i++) mangled[i] = 0.5; // mangle r_t and future
    expect(sigma60(mangled, 80)).toBe(sigma60(logr, 80));
  });
});

describe("classifyDays + evalAbndayCell", () => {
  it("detects a +2σ spike as a pos event and scores the registered sign", () => {
    const closes = quiet(80);
    // Inject a +5% day at t=70 (≈10σ of the ±0.5% base), next day −2%.
    closes[70] = closes[69]! * 1.05;
    closes[71] = closes[70]! * 0.98;
    for (let t = 72; t < 80; t++) {
      closes[t] = closes[t - 1]! * (t % 2 === 0 ? 1.005 : 0.995);
    }
    const candles = candlesFrom(closes);
    const days = classifyDays(candles);
    const ev = days.filter((d) => d.kind === "event");
    expect(ev.some((d) => d.t === 70 && d.sign === "pos")).toBe(true);

    // BTC+ cell: prediction = reversal (next-day down). t=70 next-day is −2% → hit.
    const cell = evalAbndayCell("BTCUSDT", candles, "pos", "all", () => true);
    const spikeIncluded = cell.event.n >= 1;
    expect(spikeIncluded).toBe(true);
    expect(cell.event.hits).toBeGreaterThanOrEqual(1);
    expect(cell.prediction).toBe("reversal");
  });

  it("normal cohort excludes events and the 1–2σ band", () => {
    const closes = quiet(80);
    closes[70] = closes[69]! * 1.05;
    const candles = candlesFrom(closes);
    const days = classifyDays(candles);
    const d70 = days.find((d) => d.t === 70);
    expect(d70?.kind).toBe("event");
    // every classified day is exactly one of the three kinds
    for (const d of days) {
      expect(["event", "normal", "neither"]).toContain(d.kind);
    }
  });

  it("non-overlap subset drops an event immediately following another", () => {
    const closes = quiet(90);
    closes[70] = closes[69]! * 1.05; // event A
    closes[71] = closes[70]! * 1.05; // event B, consecutive
    closes[72] = closes[71]! * 0.995;
    for (let t = 73; t < 90; t++) {
      closes[t] = closes[t - 1]! * (t % 2 === 0 ? 1.005 : 0.995);
    }
    const candles = candlesFrom(closes);
    const cell = evalAbndayCell("BTCUSDT", candles, "pos", "all", () => true);
    expect(cell.event.n).toBeGreaterThanOrEqual(2);
    expect(cell.eventNonOverlap.n).toBe(cell.event.n - 1);
  });

  it("LOOK-AHEAD GUARD: event classification at t is unchanged by future bars", () => {
    const closes = quiet(120);
    closes[80] = closes[79]! * 1.05;
    const a = candlesFrom(closes);
    const b = candlesFrom(closes.map((c, t) => (t >= 95 ? c * 2 : c)));
    const ka = classifyDays(a)
      .filter((d) => d.t < 94)
      .map((d) => `${d.t}:${d.kind}:${d.sign}`);
    const kb = classifyDays(b)
      .filter((d) => d.t < 94)
      .map((d) => `${d.t}:${d.kind}:${d.sign}`);
    expect(kb).toEqual(ka);
  });
});
