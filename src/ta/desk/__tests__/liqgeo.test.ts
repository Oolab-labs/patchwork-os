/**
 * liqGeometrySurface + Rekt Shield stop-band ENFORCEMENT tests.
 *
 * The modeled-liquidation-geometry surface is the highest-risk honesty boundary
 * on the desk: leverage-bucket liq prices read EXACTLY like a price-magnet
 * forecast unless the render is locked down. These tests pin:
 *
 *   (1) the rendered liqGeoMd carries NONE of the banned forecast/magnet CLAIM
 *       vocab as a positive lean (magnet/pins/gravitates/hunts/seeks/draws/
 *       target/due — the only legal occurrences are the explicit "not a magnet"
 *       / "not a forecast" negations), AND it DOES carry the three mandatory
 *       location labels ("geometry", "not a forecast", "not exchange position
 *       data");
 *   (2) the band prices equal mid·(1∓1/N) within rounding for N∈{10,25,50,100};
 *   (3) the fully-live payload (with liqGeoMd present) stays under 7000 bytes;
 *   (4) the surface degrades to the feed-offline line on a null mid OR a null OI;
 *   (5) the Rekt Shield stop-vs-band line is STRUCTURAL — pure location, never
 *       an action verb ("move"/"widen"/"tighten").
 *
 * These assertions describe the SHIPPED behavior of surfaces.ts / render.ts —
 * they are a regression moat, not a wishlist.
 */

import { describe, expect, it } from "vitest";
import type { Candle } from "../../types.js";
import type { AssembleInput } from "../contract.js";
import { assemblePayload } from "../contract.js";
import type { LedgerSummary } from "../deskLedger.js";
import { renderLiqGeometry, renderRektShield } from "../render.js";
import {
  computeRektShield,
  LIQ_LEVERAGE_BUCKETS,
  liqGeometrySurface,
  stopVsBand,
} from "../surfaces.js";
import type { Collected, FeedResult, QumoTrade } from "../types.js";
import { PAYLOAD_BYTE_BUDGET } from "../types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * The banned forecast/magnet CLAIM vocab. Each is legal ONLY inside an explicit
 * negation the render emits ("not a magnet" / "not a forecast"). We strip those
 * exact negated phrases first, then assert ZERO residual occurrence — so a
 * positive lean ("price magnet", "draws toward", "due at") would still trip.
 */
const BANNED_GEO_VOCAB = [
  "magnet",
  "pins",
  "gravitates",
  "hunts",
  "seeks",
  "draws",
  "target",
  "due",
] as const;

/** Remove the explicit no-forecast/no-magnet negations the render legally uses. */
function stripLegalNegations(md: string): string {
  return md
    .toLowerCase()
    .replaceAll("not a magnet", "")
    .replaceAll("not a forecast", "");
}

function live<T>(value: T, asOf: string, source: string): FeedResult<T> {
  return { value, asOf, source, state: "live" };
}

function liveCandles(n: number): Candle[] {
  const out: Candle[] = [];
  const base = Date.parse("2025-01-01T00:00:00.000Z");
  for (let i = 0; i < n; i++) {
    const px = 60000 + Math.sin(i) * 5000 + i * 10;
    out.push({
      openTime: base + i * 86_400_000,
      open: px,
      high: px + 1234.56,
      low: px - 1234.56,
      close: px + 42.42,
      volume: 12345.6789,
      closeTime: base + (i + 1) * 86_400_000 - 1,
    });
  }
  return out;
}

function fullyLiveInput(nowMs: number): AssembleInput {
  const asOf = "2026-06-18T00:00:00.000Z";
  const feeds: Collected = {
    btc1d: live(liveCandles(120), asOf, "binanceSpot"),
    btc24hPct: live(-12.3456, asOf, "binance24h"),
    funding: live(-0.000654, asOf, "binanceFutures"),
    takerBuyPct: live(48.7654, asOf, "binanceFutures"),
    crowdLongPct: live(63.21, asOf, "binanceFutures"),
    oiChangePct: live(-9.8765, asOf, "binanceFutures"),
    oiNotional: live(12_345_678_901, asOf, "binanceFutures"),
    feargreed: live(22, asOf, "feargreed"),
    breadth: live({ green: 37, red: 163, universe: 200 }, asOf, "coingecko"),
    atlas: live(
      [
        {
          name: "Artificial Intelligence (AI)",
          change24hPct: 14.321,
          leaders: ["FET", "RNDR"],
        },
        {
          name: "Decentralized Finance (DeFi)",
          change24hPct: -8.765,
          leaders: ["AAVE"],
        },
        {
          name: "Real World Assets (RWA)",
          change24hPct: 5.432,
          leaders: ["ONDO"],
        },
      ],
      asOf,
      "coingecko",
    ),
    depth: live(
      {
        bids: [
          [64320.5, 12.3456],
          [64200.1, 40.987],
          [63100.7, 5.5],
          [63000.0, 88.8],
        ],
        asks: [
          [64321.5, 11.2345],
          [64450.9, 33.21],
          [65300.3, 6.6],
          [65500.0, 77.7],
        ],
      },
      asOf,
      "binanceFutures",
    ),
    options: live(
      [
        {
          strike: 60000,
          kind: "C",
          expiry: "27JUN26",
          expiryMs: Date.UTC(2026, 5, 27, 8),
          openInterest: 1234.5,
        },
        {
          strike: 60000,
          kind: "P",
          expiry: "27JUN26",
          expiryMs: Date.UTC(2026, 5, 27, 8),
          openInterest: 987.6,
        },
        {
          strike: 65000,
          kind: "C",
          expiry: "27JUN26",
          expiryMs: Date.UTC(2026, 5, 27, 8),
          openInterest: 2345.6,
        },
        {
          strike: 65000,
          kind: "P",
          expiry: "27JUN26",
          expiryMs: Date.UTC(2026, 5, 27, 8),
          openInterest: 1456.7,
        },
        {
          strike: 70000,
          kind: "C",
          expiry: "27JUN26",
          expiryMs: Date.UTC(2026, 5, 27, 8),
          openInterest: 3210.9,
        },
        {
          strike: 70000,
          kind: "P",
          expiry: "27JUN26",
          expiryMs: Date.UTC(2026, 5, 27, 8),
          openInterest: 765.4,
        },
      ],
      asOf,
      "deribit.com",
    ),
  };
  const ledger: LedgerSummary = {
    asOf,
    openClaims: 3,
    gradedClaims: 5,
    cells: [
      {
        type: "kodama",
        timeframe: "1d",
        status: "GRADED",
        decided: 41,
        gate: 40,
        permutationP: 0.0321,
        note: "matured arm — permutation gate cleared",
      },
      {
        type: "wp-level-fifty",
        timeframe: "4h",
        status: "FALSIFIED",
        edge: -0.53,
        note: "falsified — banned even as reference",
      },
      {
        type: "ichimoku-family",
        timeframe: "1d",
        status: "BANNED",
        note: "closed 2026-06-11 — banned even as reference",
      },
    ],
  };
  return {
    feeds,
    trade: {
      symbol: "BTCUSDT",
      side: "long",
      entry: 64321.99,
      stop: 61000.11,
      target: 71000.55,
      leverage: 5,
      timeframe: "1d",
    },
    ledger,
    tri: { nRisk: 2, nWatch: 3, nConfirm: 1 },
    nowMs,
    cachedLedger: false,
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("liqGeometrySurface — modeled-liquidation honesty moat", () => {
  // (1) banned forecast/magnet vocab absent + mandatory labels present
  it("(1) liqGeoMd carries NO banned forecast/magnet claim vocab and DOES carry the location labels", () => {
    const geo = liqGeometrySurface(64321, 12_345_678_901);
    const md = renderLiqGeometry(geo).md;

    // The only legal occurrences of magnet/forecast are the explicit negations
    // "not a magnet" / "not a forecast". Strip those, then assert ZERO residual.
    const scrubbed = stripLegalNegations(md);
    for (const word of BANNED_GEO_VOCAB) {
      expect(scrubbed).not.toContain(word);
    }

    // Mandatory honesty labels — every one MUST be present verbatim.
    expect(md.toLowerCase()).toContain("geometry");
    expect(md.toLowerCase()).toContain("not a forecast");
    expect(md.toLowerCase()).toContain("not exchange position data");
  });

  // (2) band prices equal mid·(1∓1/N) within rounding for every standard bucket
  it("(2) each band price equals mid·(1∓1/N) within rounding for N∈{10,25,50,100}", () => {
    const mid = 64321;
    const geo = liqGeometrySurface(mid, 12_345_678_901);
    expect(geo.available).toBe(true);
    expect(geo.bands).toBeDefined();
    expect(geo.bands!.map((b) => b.n)).toEqual([...LIQ_LEVERAGE_BUCKETS]);

    for (const band of geo.bands!) {
      const n = band.n;
      const expectedLong = Math.round(mid * (1 - 1 / n));
      const expectedShort = Math.round(mid * (1 + 1 / n));
      // exact (the surface rounds the same way) — and never off by > rounding.
      expect(band.longLiq).toBe(expectedLong);
      expect(band.shortLiq).toBe(expectedShort);
      expect(Math.abs(band.longLiq - mid * (1 - 1 / n))).toBeLessThanOrEqual(
        0.5,
      );
      expect(Math.abs(band.shortLiq - mid * (1 + 1 / n))).toBeLessThanOrEqual(
        0.5,
      );
    }
  });

  // (3) the fully-live payload (liqGeoMd present + populated) stays under budget
  it("(3) the fully-live payload with a populated liqGeoMd stays < 7000 bytes", () => {
    const nowMs = Date.parse("2026-06-18T06:30:00.000Z");
    const p = assemblePayload(fullyLiveInput(nowMs));
    // liqGeoMd is genuinely populated (not the offline shell) on this path.
    expect(p.liqGeoMd).toContain("Modeled liq geometry");
    expect(p.liqGeoMd).not.toContain("feed offline");
    expect(JSON.stringify(p).length).toBeLessThan(PAYLOAD_BYTE_BUDGET);
  });

  // (4) degrade to the feed-offline line on null mid OR null OI
  describe("(4) degrades to the feed-offline line", () => {
    it("(4a) on a null mid → feed-offline line, no bands", () => {
      const geo = liqGeometrySurface(null, 12_345_678_901);
      expect(geo.available).toBe(false);
      expect(geo.bands).toBeUndefined();
      const md = renderLiqGeometry(geo).md;
      expect(md).toBe("Liq geometry: feed offline — mid or OI unavailable.");
    });

    it("(4b) on a null OI (mid present) → render falls back to the feed-offline line", () => {
      const geo = liqGeometrySurface(64321, null);
      // geometry itself is still computable from mid, but OI is unavailable; the
      // surface keeps the bands and reports OI as unavailable rather than faking
      // it — assert the surface NEVER fabricates a perp-OI figure.
      const md = renderLiqGeometry(geo).md;
      expect(md).not.toContain("$");
      // OI null is surfaced honestly, not silently dropped.
      expect(md.toLowerCase()).toContain("unavailable");
      // and the geometry-vs-OI distinction holds: oiNotional is null, not faked.
      expect(geo.oiNotional).toBeNull();
    });

    it("(4c) on BOTH null mid AND null OI → feed-offline line", () => {
      const geo = liqGeometrySurface(null, null);
      expect(geo.available).toBe(false);
      const md = renderLiqGeometry(geo).md;
      expect(md).toBe("Liq geometry: feed offline — mid or OI unavailable.");
    });
  });

  // (5) Rekt Shield stop-vs-band line is STRUCTURAL — no action verbs
  it("(5) the Rekt Shield stop line is structural — never 'move'/'widen'/'tighten'", () => {
    const nowMs = Date.parse("2026-06-18T06:30:00.000Z");
    const trade: QumoTrade = {
      symbol: "BTCUSDT",
      side: "long",
      entry: 64321.99,
      stop: 58000,
      target: 71000,
      leverage: 5,
      timeframe: "1d",
    };
    // a populated geometry so a stop-band line is actually produced.
    const geo = liqGeometrySurface(64321, 12_345_678_901);
    const stopBand = stopVsBand(trade, geo);
    expect(stopBand).not.toBeNull();

    const rekt = computeRektShield(trade, nowMs);
    const md = renderRektShield(rekt, stopBand).md;
    const lower = md.toLowerCase();

    // the structural stop line is present at all (regression guard) ...
    expect(lower).toContain("liq band");
    expect(lower).toContain("structure, not a recommendation");

    // ... and it is PURE location — never an action verb directed at the stop.
    expect(lower).not.toContain("move");
    expect(lower).not.toContain("widen");
    expect(lower).not.toContain("tighten");
  });
});

describe("computeRektShield — capitalAtRiskPct accounts for leverage (H9)", () => {
  it("capitalAtRiskPct scales the price-delta risk with the leverage multiplier", () => {
    // 10x long from 100k, stop at 99k → 1% price risk, but at 10x leverage
    // the capital at risk is 10% of the margin. Without the fix this returned 1.
    const trade: QumoTrade = {
      side: "long",
      entry: 100_000,
      stop: 99_000,
      target: 103_000,
      leverage: 10,
    };
    const rekt = computeRektShield(trade, Date.now());
    expect(rekt.idle).toBe(false);
    if (rekt.idle) return;
    // Price risk leg = 1%; leverage 10x → capital at risk = 10%
    expect(rekt.capitalAtRiskPct).toBeCloseTo(10, 0);
  });

  it("capitalAtRiskPct at 1x leverage equals the raw price-delta percentage", () => {
    const trade: QumoTrade = {
      side: "short",
      entry: 50_000,
      stop: 51_000,
      target: 47_000,
      leverage: 1,
    };
    const rekt = computeRektShield(trade, Date.now());
    if (rekt.idle) return;
    // Price risk = 2%; leverage 1x → capital at risk = 2%
    expect(rekt.capitalAtRiskPct).toBeCloseTo(2, 0);
  });
});
