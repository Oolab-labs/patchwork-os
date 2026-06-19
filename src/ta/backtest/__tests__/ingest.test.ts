import { describe, expect, it } from "vitest";
import { dedupeCandles, parseKlineCsv } from "../ingest.js";

describe("parseKlineCsv", () => {
  it("parses headerless Binance Vision kline rows", () => {
    const csv = [
      "1609459200000,29000,29500,28800,29400,1234,1609545599999,0,0,0,0,0",
      "1609545600000,29400,30000,29300,29900,2345,1609631999999,0,0,0,0,0",
    ].join("\n");
    const c = parseKlineCsv(csv);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({
      open: 29000,
      high: 29500,
      low: 28800,
      close: 29400,
    });
    expect(c[0]!.openTime).toBe(1609459200000);
  });

  it("normalises microsecond epochs down to milliseconds", () => {
    const csv = "1609459200000000,1,2,0.5,1.5,10,1609545599999000,0,0,0,0,0";
    const c = parseKlineCsv(csv);
    expect(c[0]!.openTime).toBe(1609459200000);
  });

  it("skips blank and malformed rows rather than poisoning the series", () => {
    const csv = [
      "",
      "garbage",
      "1,2,3",
      "1609459200000,1,2,0.5,1.5,10,1609545599999",
    ].join("\n");
    const c = parseKlineCsv(csv);
    expect(c).toHaveLength(1);
  });

  it("sorts by openTime", () => {
    const csv = [
      "200,1,2,0.5,1.5,1,299,0,0,0,0,0",
      "100,1,2,0.5,1.5,1,199,0,0,0,0,0",
    ].join("\n");
    expect(parseKlineCsv(csv).map((c) => c.openTime)).toEqual([100, 200]);
  });
});

describe("dedupeCandles", () => {
  it("removes overlapping candles by openTime", () => {
    const csv = parseKlineCsv(
      [
        "100,1,2,0.5,1.5,1,199,0,0,0,0,0",
        "100,1,2,0.5,1.5,1,199,0,0,0,0,0",
        "200,1,2,0.5,1.5,1,299,0,0,0,0,0",
      ].join("\n"),
    );
    expect(dedupeCandles(csv)).toHaveLength(2);
  });
});
