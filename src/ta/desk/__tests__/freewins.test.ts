/**
 * Desk surface honesty tests — assert the rendered surface MARKDOWN (the
 * user-facing output of maxPainSurface / depthSurface) never paints a
 * magnet/target/direction, always carries its honesty label, stays under the
 * shared byte budget, and degrades to a feed-offline line on a null feed.
 *
 * These complement contract.test.ts: contract.ts asserts banned vocab over the
 * WHOLE payload; here we pin the two location-only surfaces (depth + max-pain)
 * directly so a regression in either render path fails the build on its own.
 */

import { describe, expect, it } from "vitest";
import type { Candle } from "../../types.js";
import type { AssembleInput } from "../contract.js";
import { assemblePayload } from "../contract.js";
import type { LedgerSummary } from "../deskLedger.js";
import { renderDepth, renderMaxPain } from "../render.js";
import {
  depthSurface,
  type MaxPainFacts,
  maxPainSurface,
} from "../surfaces.js";
import type { Collected, FeedResult, OptionRow } from "../types.js";
import { PAYLOAD_BYTE_BUDGET } from "../types.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Banned "magnet"-class vocab the task forbids in the max-pain surface. */
const MAGNET_VOCAB = ["pins", "gravitates", "magnet", "target", "draws"];

/** Directional / forecast words the depth surface must never emit. */
const DIRECTIONAL_VOCAB = [
  "bullish",
  "bearish",
  "rally",
  "dump",
  "breakout",
  "breakdown",
  "uptrend",
  "downtrend",
  "buy signal",
  "sell signal",
  "will ",
  "expect",
  "forecast",
  "predict",
  "reversal",
  "long here",
  "short here",
];

function liveOptions(asOf: string, nowMs: number): OptionRow[] {
  const expiryMs = nowMs + 5 * 86_400_000;
  void asOf;
  return [
    {
      strike: 60000,
      kind: "C",
      expiry: "27JUN26",
      expiryMs,
      openInterest: 1234.5,
    },
    {
      strike: 60000,
      kind: "P",
      expiry: "27JUN26",
      expiryMs,
      openInterest: 987.6,
    },
    {
      strike: 65000,
      kind: "C",
      expiry: "27JUN26",
      expiryMs,
      openInterest: 2345.6,
    },
    {
      strike: 65000,
      kind: "P",
      expiry: "27JUN26",
      expiryMs,
      openInterest: 1456.7,
    },
    {
      strike: 70000,
      kind: "C",
      expiry: "27JUN26",
      expiryMs,
      openInterest: 3210.9,
    },
    {
      strike: 70000,
      kind: "P",
      expiry: "27JUN26",
      expiryMs,
      openInterest: 765.4,
    },
  ];
}

function liveBook() {
  return {
    bids: [
      [64320.5, 12.3456],
      [64200.1, 40.987],
      [63100.7, 5.5],
      [63000.0, 88.8],
    ] as Array<[number, number]>,
    asks: [
      [64321.5, 11.2345],
      [64450.9, 33.21],
      [65300.3, 6.6],
      [65500.0, 77.7],
    ] as Array<[number, number]>,
  };
}

// fully-live assemble input (mirrors contract.test.ts worst case) so check (3)
// runs against the real worst-case depthMd + maxPainMd, not a degraded shell.
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

function live<T>(value: T, asOf: string, source: string): FeedResult<T> {
  return { value, asOf, source, state: "live" };
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
    depth: live(liveBook(), asOf, "binanceFutures"),
    options: live(liveOptions(asOf, nowMs), asOf, "deribit.com"),
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

describe("desk surface honesty (depth + max-pain)", () => {
  const NOW = Date.parse("2026-06-18T06:30:00.000Z");

  // (1) max-pain surface — no magnet vocab, carries the OI-snapshot label
  it("(1) max-pain surface output contains NO magnet vocab and DOES carry the OI-snapshot / not-a-magnet label", () => {
    const facts: MaxPainFacts = maxPainSurface(liveOptions("", NOW), NOW);
    expect(facts.available).toBe(true);
    const md = renderMaxPain(facts).md;
    const lower = md.toLowerCase();

    // honesty label present: "OI snapshot" (and/or "not a price magnet" wording).
    const hasLabel =
      lower.includes("oi snapshot") || lower.includes("not a price magnet");
    expect(hasLabel).toBe(true);

    // Magnet vocab is banned as a POSITIVE claim. The honesty label negates it
    // ("not a price magnet" / "not a price target") — strip the explicit
    // negating clause before scanning, mirroring the closed/location exemption
    // in assertContract. Any magnet word OUTSIDE that clause is a real breach.
    const claimText = lower
      .replace(/not a price magnet/g, "")
      .replace(/not a price target/g, "");
    for (const banned of MAGNET_VOCAB) {
      expect(claimText).not.toContain(banned);
    }
  });

  // (2) depth surface — no directional / forecast words
  it("(2) depth surface output contains no directional / forecast words", () => {
    const facts = depthSurface(liveBook());
    expect(facts.available).toBe(true);
    const md = renderDepth(facts).md;
    const lower = md.toLowerCase();

    for (const word of DIRECTIONAL_VOCAB) {
      expect(lower).not.toContain(word);
    }
    // positively asserts the structure-only disclaimer is present.
    expect(lower).toContain("no direction");
  });

  // (3) full payload with live depthMd + maxPainMd still under the byte budget
  it("(3) payload with depthMd + maxPainMd still < 7000 bytes", () => {
    const p = assemblePayload(fullyLiveInput(NOW));
    // both surfaces are genuinely live, not degraded shells
    expect(p.depthMd).not.toBe("Order book: feed offline.");
    expect(p.maxPainMd).not.toBe("Deribit options: feed offline.");
    const bytes = Buffer.byteLength(JSON.stringify(p), "utf-8");
    expect(bytes).toBeLessThan(PAYLOAD_BYTE_BUDGET);
  });

  // (4) both surfaces degrade to a feed-offline line on a null feed
  it("(4) both surfaces degrade to a feed-offline line when given null feed input", () => {
    const depthMd = renderDepth(depthSurface(null)).md;
    const maxPainMd = renderMaxPain(maxPainSurface(null, NOW)).md;

    expect(depthSurface(null).available).toBe(false);
    expect(maxPainSurface(null, NOW).available).toBe(false);

    expect(depthMd).toBe("Order book: feed offline.");
    expect(maxPainMd).toBe("Deribit options: feed offline.");
    expect(depthMd.toLowerCase()).toContain("offline");
    expect(maxPainMd.toLowerCase()).toContain("offline");
  });
});
