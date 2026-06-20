/**
 * Desk contract ENFORCEMENT tests — the BUILD-FAILING moat boundary.
 *
 * A faithful LLM narrating a dishonest JSON would pass a byte-present judge, so
 * the JSON must be honest by construction. These four enforcement checks fail
 * the build if:
 *   (1) a banned token NAME reaches a generated payload,
 *   (2) the worst-case fully-live payload breaches the 7000-byte budget,
 *   (3) a number is narrated but absent from numbersIndex (grep helper),
 *   (4) total feed failure does NOT yield a degraded 'Standing aside' payload.
 */

import { describe, expect, it } from "vitest";
import type { Candle } from "../../types.js";
import type { AssembleInput } from "../contract.js";
import {
  assemblePayload,
  assertContract,
  ContractError,
  degradedPayload,
} from "../contract.js";
import type { LedgerSummary } from "../deskLedger.js";
import type {
  Collected,
  FeedResult,
  QumoPayload,
  SurfaceFragment,
} from "../types.js";
import { narratedNumbers, PAYLOAD_BYTE_BUDGET } from "../types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function basePayload(overrides: Partial<QumoPayload> = {}): QumoPayload {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-18T06:30:00.000Z",
    asOfData: "2026-06-18T00:00:00.000Z",
    feedHealthMd: "binanceSpot: live",
    allowedPostures: "Holding | Standing aside",
    todaysReadMd:
      "**Desk posture: Standing aside.** Tri-count — risk 0 / watch 0 / confirm 0.",
    rektShieldMd: "No hypothetical trade supplied — Rekt Shield idle.",
    btcDnaMd:
      "Trend: 24h +0.5% — neutral. Location (no edge): price in cloud. Ichimoku family closed 2026-06-11 — location context, not a signal.",
    atlasMd: "Atlas offline — sector feed unavailable.",
    depthMd: "Order book: feed offline.",
    maxPainMd: "Deribit options: feed offline.",
    liqGeoMd: "Liq geometry: feed offline — mid or OI unavailable.",
    ledgerMd:
      "LEDGER (history, not a forward probability). FALSIFIED/BANNED (audit): ichimoku-family @1d — closed 2026-06-11.",
    navMd: "Read Market → Stand Aside.",
    numbersIndex: "0\n0.5",
    ...overrides,
  };
}

function frags(
  numbers: {
    token: string;
    provenance: "det" | "live-feed" | "matured-ledger";
  }[],
): SurfaceFragment[] {
  return [{ md: "x", numbers }];
}

/**
 * Grep helper for check (3): find numbers narrated in the markdown surfaces
 * that are NOT listed in numbersIndex. Mirrors the byte-level traceability
 * requirement — every narrated number must trace to an indexed token.
 *
 * Uses the SHARED narratedNumbers() extractor (types.ts) — the SAME rule the
 * runtime assert applies — so the CI grep and the runtime guard can never drift.
 * ISO dates (YYYY-MM-DD) are the one machine-exempt class and are stripped
 * before the scan (the old inline regex did NOT actually exclude them).
 */
function narratedButNotIndexed(p: QumoPayload): string[] {
  const indexed = new Set(p.numbersIndex.split("\n").filter(Boolean));
  // Same fact-surface set the runtime assert (contract.ts factSurfaces) guards:
  // atlasMd is excluded (live sector NAMES carry unpredictable identifier digits
  // the engine cannot pre-register; its change% values are provenance-backed).
  const surfaces = [
    p.todaysReadMd,
    p.rektShieldMd,
    p.btcDnaMd,
    p.depthMd,
    p.maxPainMd,
    p.liqGeoMd,
    p.ledgerMd,
    p.navMd,
  ].join("\n");
  const missing: string[] = [];
  for (const m of narratedNumbers(surfaces)) {
    if (!indexed.has(m)) missing.push(m);
  }
  return missing;
}

// ── fully-live fixture (worst case) ───────────────────────────────────────────

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
    depth: live(
      {
        // bids descending, asks ascending; dense levels near a ~64321 mid plus a
        // wide vacuum so the worst-case payload renders a thin zone too.
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

describe("desk contract enforcement", () => {
  // (1) banned token name fails the build
  it("(1) FAILS the build when a banned token name (dangerScore) reaches the payload", () => {
    const p = basePayload({
      btcDnaMd: "dangerScore 7 reported by the engine",
      numbersIndex: "7",
    });
    expect(() =>
      assertContract(p, frags([{ token: "7", provenance: "det" }])),
    ).toThrow(ContractError);
    expect(() =>
      assertContract(p, frags([{ token: "7", provenance: "det" }])),
    ).toThrow(/banned token name "dangerScore"/);
  });

  it("(1b) accepts an honest payload with no banned names", () => {
    const p = basePayload();
    expect(() =>
      assertContract(
        p,
        frags([
          { token: "0", provenance: "det" },
          { token: "0.5", provenance: "live-feed" },
        ]),
      ),
    ).not.toThrow();
  });

  // (2) worst-case fully-live payload stays under budget
  it("(2) worst-case fully-live payload is < 7000 bytes", () => {
    const nowMs = Date.parse("2026-06-18T06:30:00.000Z");
    const p = assemblePayload(fullyLiveInput(nowMs));
    const bytes = JSON.stringify(p).length;
    expect(bytes).toBeLessThan(PAYLOAD_BYTE_BUDGET);
    // sanity: it is genuinely fully-live, not an accidentally-degraded shell
    expect(p.todaysReadMd).not.toContain("all market feeds offline");
  });

  // (2b) verdict-populated payload stays under budget
  it("(2b) fully-live payload WITH verdicts is < 7000 bytes", () => {
    const nowMs = Date.parse("2026-06-18T06:30:00.000Z");
    const verdicts = new Map([
      [
        "wp-volume-climax",
        {
          cellName: "wp-volume-climax",
          methodVersion: "wpvc-1d-v1",
          gitSha: "abc123",
          seeds: { rng: 101, permutation: 777, null: 4242 },
          candleSetHash: "deadbeef",
          N: 115,
          methodWinRate: 0.57,
          nullWinRate: 0.5,
          edge: 0.07,
          wilsonLow: 0.48,
          wilsonHigh: 0.66,
          permutationP: 0.088,
          familyAdjustedP: 0.088,
          perRegime: [],
          signConsistent: false,
          gateState: "WATCH" as const,
          failReason: "permutationP=0.088 ≥ 0.05",
          runTs: "2026-06-19T07:00:00.000Z",
          familyN: 1,
          timeframe: "1d" as const,
        },
      ],
    ]);
    const p = assemblePayload({ ...fullyLiveInput(nowMs), verdicts });
    const bytes = JSON.stringify(p).length;
    expect(bytes).toBeLessThan(PAYLOAD_BYTE_BUDGET);
    expect(p.ledgerMd).toContain("wp-volume-climax");
    expect(p.ledgerMd).toContain("N=115");
    expect(p.ledgerMd).toContain("gate not reached");
  });

  // (3) a narrated-but-unindexed number is detectable
  it("(3) detects a number narrated but absent from numbersIndex", () => {
    const dishonest = basePayload({
      btcDnaMd: "Trend: 24h +0.5% — neutral. Whale netflow 999 (not indexed).",
      numbersIndex: "0\n0.5",
    });
    const missing = narratedButNotIndexed(dishonest);
    expect(missing).toContain("999");
  });

  it("(3b) the grep helper does not false-flag numbers that ARE indexed", () => {
    // Every token in numbersIndex, when narrated, must NOT show up as missing.
    const p = basePayload({
      btcDnaMd: "Trend 0.5 reported; baseline 0.",
      numbersIndex: "0\n0.5",
    });
    const missing = narratedButNotIndexed(p);
    expect(missing).not.toContain("0");
    expect(missing).not.toContain("0.5");
  });

  // (3c) THE LEAK GUARD — run the grep helper over the ASSEMBLED fully-live
  // payload (not a hand-built fixture). This is the CI gap the audit named: the
  // max-pain surface used to narrate the Deribit DDMMMYY expiry (e.g. 27JUN26),
  // leaking 27/26 as un-indexed numbers, and no test ever exercised the live
  // payload. Asserts ZERO narrated-but-unindexed numbers across every surface.
  it("(3c) the assembled fully-live payload narrates NO number absent from numbersIndex (max-pain expiry leak guard)", () => {
    const nowMs = Date.parse("2026-06-18T06:30:00.000Z");
    const p = assemblePayload(fullyLiveInput(nowMs));
    const missing = narratedButNotIndexed(p);
    expect(missing).toEqual([]);
    // pin the specific historic leak: the raw DDMMMYY expiry token must not be
    // narrated at all — the surface renders the ISO date form instead.
    expect(p.maxPainMd).not.toContain("27JUN26");
    expect(p.maxPainMd).toMatch(/expiry \d{4}-\d{2}-\d{2}/);
  });

  // (3d) the runtime assert ABORTS on a printed-but-unindexed number (the
  // bidirectional guard that did not exist before — direction (b2)).
  it("(3d) assertContract ABORTS when a surface narrates a number absent from numbersIndex", () => {
    const p = basePayload({
      maxPainMd:
        "Deribit BTC expiry 2026-06-27 max-pain strike 65000 — OI snapshot, not a price magnet. location.",
      numbersIndex: "0\n0.5", // 65000 deliberately omitted
    });
    expect(() =>
      assertContract(
        p,
        frags([
          { token: "0", provenance: "det" },
          { token: "0.5", provenance: "live-feed" },
        ]),
      ),
    ).toThrow(/narrated number "65000" is not in numbersIndex/);
  });

  // (4) total feed failure → degraded 'Standing aside' payload
  it("(4) total feed failure still yields a degraded 'Standing aside' payload", () => {
    const p = degradedPayload(Date.parse("2026-06-18T06:30:00.000Z"));
    expect(p.todaysReadMd).toContain("Standing aside");
    expect(JSON.stringify(p).length).toBeLessThan(PAYLOAD_BYTE_BUDGET);
    // and it is itself contract-valid (no banned names, etc.)
    expect(() =>
      assertContract(
        p,
        frags([
          { token: "0", provenance: "det" },
          { token: "7", provenance: "det" },
          { token: "-0.53", provenance: "matured-ledger" },
        ]),
      ),
    ).not.toThrow();
  });
});
