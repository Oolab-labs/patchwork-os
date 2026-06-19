/**
 * QUMO-style Honest Desk — shared types for the off-box engine.
 *
 * See /tmp/qumo-design/DESIGN.md §3 (data contract) + §4 (honesty matrix).
 * The engine emits a FLAT object of pre-rendered compact markdown-fragment
 * strings (one per surface) + numbersIndex, asserted < 7000 bytes before POST.
 * No nested objects/arrays on the wire (yamlRunner.ts:2369 has no array-index
 * support; recipeOrchestration.ts:420 truncates the payload at 8000 chars).
 */

import type { Candle } from "../types.js";

/** Per-feed health state. `offline-paid` = no free source in v1 (permanent). */
export type FeedState =
  | "live"
  | "stale"
  | "offline"
  | "offline-paid"
  | "offline-deferred";

/** A single collector result. `value` is null on failure (degrade visibly). */
export interface FeedResult<T = unknown> {
  value: T | null;
  asOf: string | null; // ISO of the newest datum, or null if offline
  source: string; // hostname / feed id
  state: FeedState;
}

/** The closed desk-posture vocabulary (the user's one authorized addition). */
export type Posture =
  | "Holding"
  | "Holding-defensive"
  | "Standing aside"
  | "Watching X"
  | "Alarm fired";

export const ALLOWED_POSTURES: readonly Posture[] = [
  "Holding",
  "Holding-defensive",
  "Standing aside",
  "Watching X",
  "Alarm fired",
] as const;

/** A user-supplied hypothetical trade (watched file ~/.patchwork/qumo-trade.json). */
export interface QumoTrade {
  symbol: string;
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  leverage: number;
  timeframe?: string;
}

/** The full set of collected feeds the surfaces read. */
export interface Collected {
  /** BTC 1d candles (price-only validated substrate). */
  btc1d: FeedResult<Candle[]>;
  /** 24h percent change for BTC (verbatim). */
  btc24hPct: FeedResult<number>;
  /** Current funding rate (fraction, e.g. -0.00006). */
  funding: FeedResult<number>;
  /** Taker buy ratio percent (archived, no lean). */
  takerBuyPct: FeedResult<number>;
  /** Global crowd long percent (archived, no lean). */
  crowdLongPct: FeedResult<number>;
  /** OI change percent first→last (archived, no lean). */
  oiChangePct: FeedResult<number>;
  /** Latest absolute perp-OI notional ($) — last sumOpenInterestValue (reused). */
  oiNotional: FeedResult<number>;
  /** Fear & Greed value 0-100. */
  feargreed: FeedResult<number>;
  /** Breadth: spot price map (alt-universe). */
  breadth: FeedResult<{ green: number; red: number; universe: number }>;
  /** Atlas: CoinGecko categories 24h sector returns + leader symbols. */
  atlas: FeedResult<SectorRow[]>;
  /** Order-book depth snapshot (Binance USDM futures, BTC v1). */
  depth: FeedResult<DepthBook>;
  /** Deribit BTC options book summary (front-expiry max-pain). */
  options: FeedResult<OptionRow[]>;
}

/** Raw order-book depth snapshot — price/qty already numeric (BTC qty). */
export interface DepthBook {
  /** [price, qtyBtc] ascending-by-relevance bids (highest price first). */
  bids: Array<[number, number]>;
  /** [price, qtyBtc] asks (lowest price first). */
  asks: Array<[number, number]>;
}

/** One parsed Deribit option instrument (front-expiry filtering done in surface). */
export interface OptionRow {
  /** Strike price in USD. */
  strike: number;
  /** "C" | "P". */
  kind: "C" | "P";
  /** Expiry token as parsed from instrument_name (e.g. "27JUN26"). */
  expiry: string;
  /** Expiry as ms epoch (for nearest-front selection). */
  expiryMs: number;
  /** Open interest in BTC. */
  openInterest: number;
}

export interface SectorRow {
  name: string;
  /** 24h market-cap change percent — the honest realized number /coins/categories serves. */
  change24hPct: number;
  /** Leader coin symbols only (location); the free endpoint serves NO per-leader %. */
  leaders: string[];
}

/** Provenance kinds for every numbersIndex token. */
export type Provenance =
  | "det" // deterministic arithmetic
  | "live-feed" // verbatim fresh feed value
  | "matured-ledger"; // a matured ScoreSummary row

/** A numeric token with its provenance (the byte-level traceability spine). */
export interface NumberToken {
  token: string; // the exact rendered numeric string
  provenance: Provenance;
}

/** What the engine assembles per surface before rendering numbersIndex. */
export interface SurfaceFragment {
  md: string;
  /** numeric tokens emitted by this fragment (each provenance-backed). */
  numbers: NumberToken[];
}

/** The flat payload POSTed to /hooks/qumo-desk. */
export interface QumoPayload {
  schemaVersion: 1;
  generatedAt: string;
  asOfData: string;
  feedHealthMd: string;
  allowedPostures: string;
  todaysReadMd: string;
  rektShieldMd: string;
  btcDnaMd: string;
  atlasMd: string;
  depthMd: string;
  maxPainMd: string;
  liqGeoMd: string;
  liqTapeMd?: string; // present only when resident collector tape files exist
  ledgerMd: string;
  navMd: string;
  numbersIndex: string;
}

/** Banned field/token names — assertion aborts the POST if any appears. */
export const BANNED_TOKENS: readonly string[] = [
  "probabilityPct",
  "confScore",
  "dangerScore",
  "strandScore",
  "sweepPct",
  "grade",
  "avgR",
  "totalR",
  "weightedWinPct",
] as const;

/**
 * Falsified/banned claim names + magnet/reversion English — never shown as a
 * positive cell or lean. Mirrors the recipe judge rubric so the deterministic
 * engine assert is at least as strict as the advertised moat (no longer relies
 * on the fail-soft Sonnet judge to catch these). Matched as whole identifiers /
 * word-runs, and exempted ONLY inside an explicit closed/location audit label.
 */
export const BANNED_CLAIM_VOCAB: readonly string[] = [
  "ichimoku",
  "tenkan",
  "kijun",
  "kumo",
  "chikou",
  "price-fifty",
  "price-thirds",
  "seeks",
  "magnet",
  "reverts to",
  "draws toward",
  "due at",
  "gravitates",
  "pins toward",
  "pin toward",
  "pulls toward",
] as const;

/** Ledger cell render state. */
export type CellStatus =
  | "GRADED"
  | "WATCH"
  | "FALSIFIED"
  | "BANNED"
  | "PENDING";

/** A single ledger cell (real ScoreSummary fields only; no R / no grade). */
export interface LedgerCell {
  type: string;
  timeframe: string;
  status: CellStatus;
  matured?: number;
  scorable?: number;
  holds?: number;
  holdRate?: number;
  baselineRate?: number;
  edge?: number;
  /** WATCH (altsetup arms): decided per arm toward the gate. */
  decided?: number;
  gate?: number;
  /** GRADED altsetup arms: permutation p. */
  permutationP?: number;
  note?: string;
}

export const SCHEMA_VERSION = 1 as const;
export const PAYLOAD_BYTE_BUDGET = 7000;

/**
 * The numbers spine's date/time-exempt class. A narrated number is exempt from
 * the numbersIndex requirement ONLY when it is part of a canonical ISO
 * date-time — `YYYY-MM-DD` optionally followed by `THH:MM:SS(.sss)(Z|±hh:mm)`.
 * This is the SOLE temporal format any surface may print — the engine
 * normalises every date (incl. the Deribit DDMMMYY option expiry) to ISO before
 * rendering, so this one rule fully covers the temporal class (date AND the
 * time-of-day fragments of a grade-at timestamp). Shared by the runtime contract
 * assert (printed-number → index) and the CI grep test so they can never drift.
 */
const ISO_DATETIME_RE =
  /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?/g;

/**
 * Extract every narrated NUMERIC CLAIM from a markdown surface — i.e. every
 * number that asserts a fact and therefore MUST trace to numbersIndex. Excludes
 * three identifier/label classes that are NOT numeric claims and so are exempt:
 *
 *   1. ISO date-times (`YYYY-MM-DD[THH:MM:SS…]`) — temporal labels. The engine
 *      normalises EVERY date (incl. the Deribit DDMMMYY option expiry) to ISO
 *      before rendering, so this single rule covers the whole temporal class.
 *   2. Alphanumeric identifiers — any digit glued to a letter: timeframe/window
 *      labels (`4h`, `24h`, `1d`), sector names (`Layer 1`→`L1`, `Web3`), leader
 *      tickers (`C98`, `1INCH`), and the legacy `27JUN26` expiry token. These
 *      are names, not claims. Bounding numeric tokens by non-letter edges is the
 *      principled "claim vs identifier" line.
 *   3. Numeric ranges (`2-8`, `64321.5-65500`): the joining hyphen is a
 *      separator, not a sign, so the second operand is not a negative number.
 *
 * What survives is exactly the standalone fact numbers (`65000`, `1.18`,
 * `2691.2`, `19.5`, `-12.3456`, `999`) the byte-traceability spine must back.
 */
export function narratedNumbers(markdown: string): string[] {
  // 1. blank ISO date-times (incl. their H:M:S + hyphen fragments).
  const dateless = markdown.replace(ISO_DATETIME_RE, " ");
  // 2. peel SCALE-UNIT suffixes off fact numbers FIRST: `$5m`, `$30m`, `2.5k`,
  //    `1.2b` → the trailing m/k/b is a magnitude unit, the digits are the FACT
  //    and MUST still be traced. Strip the unit letter so the number survives
  //    step 3's identifier blanking. (Percent uses `%`, not a letter, so it is
  //    already safe.) Bounded by a word edge so it never eats a real identifier.
  const unitless = dateless.replace(
    /(\d+(?:\.\d+)?)[mkb](?![A-Za-z0-9])/gi,
    "$1 ",
  );
  // 3. blank alphanumeric identifier tokens — a maximal [A-Za-z0-9]+ run that
  //    mixes letters AND digits (timeframes `4h`/`1d`, windows `24h`, tickers
  //    `C98`/`1INCH`, sector tags `L1`/`Web3`, legacy `27JUN26`). NOT preceded
  //    by `<digit>.` so the fractional tail of a decimal is not consumed.
  const identifierless = unitless.replace(
    /(?<!\d\.)\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+\b/g,
    " ",
  );
  // 4. de-range: digit(.digit)? '-' digit → the hyphen is a separator.
  const deranged = identifierless.replace(/(\d(?:\.\d+)?)-(?=\d)/g, "$1 ");
  return deranged.match(/-?\d+(?:\.\d+)?/g) ?? [];
}
