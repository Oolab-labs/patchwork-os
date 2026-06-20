import { describe, expect, it } from "vitest";
import {
  type LedgerRow,
  parseLedger,
  scoreLedger,
  serializeRow,
} from "../ledger.js";
import type { Candle } from "../types.js";

const HOUR4 = 14_400_000;
function mk(highs: number[], lows: number[], t0 = 0): Candle[] {
  return highs.map((h, i) => ({
    openTime: t0 + i * HOUR4,
    open: (h + lows[i]!) / 2,
    high: h,
    low: lows[i]!,
    close: (h + lows[i]!) / 2,
    volume: 0,
    closeTime: t0 + i * HOUR4 + (HOUR4 - 1),
  }));
}

function row(over: Partial<LedgerRow>): LedgerRow {
  return {
    id: "x",
    asset: "BTCUSDT",
    type: "price-fifty",
    predictedLevel: 100,
    margin: 0.005,
    timeframe: "4h",
    madeAt: new Date(0).toISOString(),
    outcomeWindowEndsAt: new Date(20 * HOUR4).toISOString(),
    methodVersion: "ta-cycles-1",
    ...over,
  };
}

describe("serializeRow / parseLedger", () => {
  it("round-trips append-only rows and skips corrupt lines", () => {
    const text =
      serializeRow(row({ id: "a" })) +
      "garbage\n" +
      serializeRow(row({ id: "b" }));
    const parsed = parseLedger(text);
    expect(parsed.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("scoreLedger", () => {
  it("does not score predictions whose window hasn't matured", () => {
    const future = row({
      outcomeWindowEndsAt: new Date(Date.now() + 1e9).toISOString(),
    });
    const out = scoreLedger([future], mk([101], [99]), Date.now());
    expect(out).toHaveLength(0);
  });

  it("scores a matured prediction as a hold and reports edge vs baseline", () => {
    // approach from above (close>100) then bounce up >1.5% before breaking down
    const candles = mk(
      [110, 108, 100.3, 105, 106, 107],
      [109, 101, 99.9, 103, 104, 105],
    );
    const out = scoreLedger(
      [row({ predictedLevel: 100 })],
      candles,
      30 * HOUR4,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.matured).toBe(1);
    expect(out[0]!.scorable).toBe(1);
    expect(out[0]!.holds).toBe(1);
    expect(out[0]!.baselineRate).toBe(0.53); // 4h baseline
    expect(out[0]!.edge).toBeCloseTo(1 - 0.53, 5);
  });
});
