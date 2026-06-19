/**
 * surfaces.ts — PURE fact-producing functions for each desk surface.
 *
 * Every function returns plain facts (numbers/labels/booleans). NEVER computes a
 * probability, midpoint, composite, or target. Risk math is deterministic
 * arithmetic on a user-supplied trade. Positioning data (taker-buy%, crowd%) is
 * returned as RAW ARCHIVED FACT with NO directional lean (deterministic ≠
 * validated). Ichimoku is computed ONLY as a no-edge LOCATION line.
 *
 * See /tmp/qumo-design/signals-spec.md + DESIGN.md §5/§6.
 */

import type { Candle } from "../types.js";
import type {
  Collected,
  DepthBook,
  OptionRow,
  Posture,
  QumoTrade,
  SectorRow,
} from "./types.js";

// ── Pre-registered thresholds (frozen; docs/qumo-desk-precommit.md) ──────────

/** Liq-distance posture bands (rendered inline, never a forward call). */
export const LIQ_WIDE_PCT = 8; // > 8% → WIDE
export const LIQ_CONTESTED_PCT = 2; // < 2% → CONTESTED; else NEAR
/** Linear-perp maintenance-margin proxy for the liq-price estimate. */
export const MAINTENANCE_MARGIN = 0.005;
/** Trend CONSISTENT band: |24h%| <= this → neutral. */
export const TREND_NEUTRAL_BAND = 1.0;
/** Rekt Shield outcome window (bookkeeping grade-at). */
export const REKT_WINDOW_DAYS = 7;

// ── TODAY'S READ — desk posture (closed-vocab deterministic rule) ────────────

export interface TodaysReadFacts {
  posture: Posture;
  reason: string;
  nRisk: number;
  nWatch: number;
  nConfirm: number;
  nGreen: number | null;
  nRed: number | null;
  universeN: number | null;
}

/**
 * Deterministic posture rule (pre-registered):
 *  - load-bearing feed offline WHILE an open risk tally stands → "Alarm fired"
 *    (cannot manage live risk blind)
 *  - any other load-bearing feed offline OR zero confirms → "Standing aside"
 *  - any risk tally → "Holding-defensive"
 *  - any watch tally (no risk) → "Watching X"
 *  - confirms present, no risk/watch, feeds healthy → "Holding"
 * Engine-decided, never LLM vibe. Every one of the five ALLOWED_POSTURES is
 * reachable by this rule.
 */
export function computeTodaysRead(
  feeds: Collected,
  tri: { nRisk: number; nWatch: number; nConfirm: number },
): TodaysReadFacts {
  const breadth = feeds.breadth.value;
  const loadBearingOffline =
    feeds.btc1d.state !== "live" || feeds.btc24hPct.state !== "live";

  let posture: Posture;
  let reason: string;

  if (loadBearingOffline && tri.nRisk > 0) {
    posture = "Alarm fired";
    reason =
      "load-bearing price feed offline while open risk stands — cannot manage risk blind";
  } else if (loadBearingOffline) {
    posture = "Standing aside";
    reason = "load-bearing price feed offline — no read";
  } else if (tri.nRisk > 0) {
    posture = "Holding-defensive";
    reason = "open risk tally on the live ledger";
  } else if (tri.nWatch > 0) {
    posture = "Watching X";
    reason = "watch tally accruing, no confirmed risk";
  } else if (tri.nConfirm === 0) {
    posture = "Standing aside";
    reason = "no confirmed signals and no open tallies";
  } else {
    const pct = feeds.btc24hPct.value;
    posture = "Holding";
    reason =
      pct !== null && Math.abs(pct) <= TREND_NEUTRAL_BAND
        ? `trend flat (24h ${fmtSigned(pct)}%), confirms present`
        : "confirms present, no open risk";
  }

  return {
    posture,
    reason,
    nRisk: tri.nRisk,
    nWatch: tri.nWatch,
    nConfirm: tri.nConfirm,
    nGreen: breadth ? breadth.green : null,
    nRed: breadth ? breadth.red : null,
    universeN: breadth ? breadth.universe : null,
  };
}

// ── REKT SHIELD — deterministic risk arithmetic on a supplied trade ──────────

export interface RektFacts {
  idle: boolean;
  /** the supplied stop price (for the structural stop-vs-band line). */
  stop?: number;
  liqPrice?: number;
  liqDistancePct?: number;
  rrRatio?: number;
  riskLegPct?: number;
  rewardLegPct?: number;
  capitalAtRiskPct?: number;
  liqPosture?: "WIDE" | "NEAR" | "CONTESTED";
  gradeAt?: string;
}

/**
 * Pure risk arithmetic. No prediction. liqPrice from leverage + maintenance;
 * R:R from entry/stop/target legs; capital-at-risk = riskLeg/leverage proxy.
 */
export function computeRektShield(
  trade: QumoTrade | null,
  nowMs: number,
): RektFacts {
  if (!trade) return { idle: true };
  const { side, entry, stop, target, leverage } = trade;
  if (
    !(entry > 0) ||
    !(leverage > 0) ||
    !Number.isFinite(stop) ||
    !Number.isFinite(target)
  ) {
    return { idle: true };
  }

  const long = side === "long";
  // Liquidation price for an isolated linear perp (maintenance-margin proxy).
  const liqFrac = 1 / leverage - MAINTENANCE_MARGIN;
  const liqPrice = long ? entry * (1 - liqFrac) : entry * (1 + liqFrac);
  const liqDistancePct = Number((Math.abs(liqFrac) * 100).toFixed(1));

  const riskLeg = Math.abs(entry - stop);
  const rewardLeg = Math.abs(target - entry);
  const riskLegPct = Number(((riskLeg / entry) * 100).toFixed(1));
  const rewardLegPct = Number(((rewardLeg / entry) * 100).toFixed(1));
  const rrRatio = riskLeg > 0 ? Number((rewardLeg / riskLeg).toFixed(2)) : 0;
  // Capital at risk: price-delta risk leg multiplied by leverage (H9).
  // Without the leverage factor, a 1% stop at 10x reports only 1% at risk
  // instead of the correct 10% of margin capital.
  const capitalAtRiskPct = Number((riskLegPct * leverage).toFixed(1));

  const liqPosture: "WIDE" | "NEAR" | "CONTESTED" =
    liqDistancePct > LIQ_WIDE_PCT
      ? "WIDE"
      : liqDistancePct < LIQ_CONTESTED_PCT
        ? "CONTESTED"
        : "NEAR";

  const gradeAt = new Date(nowMs + REKT_WINDOW_DAYS * 86_400_000).toISOString();

  return {
    idle: false,
    stop: Number(stop.toFixed(roundDigits(stop))),
    liqPrice: Number(liqPrice.toFixed(roundDigits(liqPrice))),
    liqDistancePct,
    rrRatio,
    riskLegPct,
    rewardLegPct,
    capitalAtRiskPct,
    liqPosture,
    gradeAt,
  };
}

// ── BTC DNA — raw evidence lines ─────────────────────────────────────────────

export interface DnaFacts {
  /** trend lean is allowed (price-only validated). */
  trend: { live: boolean; pct: number | null; lean: string };
  /** funding raw (lean only if a funding claim matured — never in v1). */
  funding: { live: boolean; pct: number | null };
  spotConfirm: { live: boolean; pct: number | null };
  leverage: { live: boolean; crowdPct: number | null; oiPct: number | null };
  liveCount: number;
}

export function computeBtcDna(feeds: Collected): DnaFacts {
  const pct = feeds.btc24hPct.value;
  const trendLive = feeds.btc24hPct.state === "live" && pct !== null;
  let lean = "feed offline";
  if (trendLive && pct !== null) {
    lean =
      Math.abs(pct) <= TREND_NEUTRAL_BAND
        ? "neutral (consistent)"
        : pct > 0
          ? "up — consistent"
          : "down — consistent";
  }

  const fundingLive =
    feeds.funding.state === "live" && feeds.funding.value !== null;
  const spotLive =
    feeds.takerBuyPct.state === "live" && feeds.takerBuyPct.value !== null;
  const levLive =
    feeds.crowdLongPct.state === "live" && feeds.crowdLongPct.value !== null;

  // Only price-trend counts as a LIVE lean-bearing strand. Funding/positioning
  // are archived/raw, not "read", per the moat — so the live-strand count is
  // trend-only when present.
  const liveCount = trendLive ? 1 : 0;

  return {
    trend: { live: trendLive, pct, lean },
    funding: { live: fundingLive, pct: feeds.funding.value },
    spotConfirm: { live: spotLive, pct: feeds.takerBuyPct.value },
    leverage: {
      live: levLive,
      crowdPct: feeds.crowdLongPct.value,
      oiPct: feeds.oiChangePct.value,
    },
    liveCount,
  };
}

// ── ICHIMOKU — NO-EDGE LOCATION CONTEXT ONLY (user decision 1) ───────────────

export interface IchimokuLocation {
  available: boolean;
  /** "above" | "below" | "in" the cloud, location only. */
  cloud?: "above" | "below" | "in";
  /** bars since the last TK cross, location only. */
  tkCrossBarsAgo?: number | null;
}

/**
 * Compute cloud position + TK cross as a LOCATION line. NEVER a directional
 * lean, NEVER graded, NEVER in numbersIndex as a tradeable claim. The render
 * layer attaches the explicit no-edge label. Standard 9/26/52 Hosoda params.
 */
export function computeIchimokuLocation(
  candles: Candle[] | null,
): IchimokuLocation {
  if (!candles || candles.length < 53) return { available: false };
  const n = candles.length;
  const last = candles[n - 1]!;

  const periodHL = (lookback: number, end: number) => {
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = end - lookback + 1; i <= end; i++) {
      if (i < 0) continue;
      hi = Math.max(hi, candles[i]!.high);
      lo = Math.min(lo, candles[i]!.low);
    }
    return (hi + lo) / 2;
  };

  // Senkou A/B projected 26 forward; for "current cloud" use the spans plotted
  // at the current bar (computed from 26 bars ago).
  const tenkanAt = (end: number) => periodHL(9, end);
  const kijunAt = (end: number) => periodHL(26, end);
  const senkouAAt = (end: number) => (tenkanAt(end) + kijunAt(end)) / 2;
  const senkouBAt = (end: number) => periodHL(52, end);

  const spanEnd = n - 1 - 26;
  if (spanEnd < 52) {
    // not enough history for a plotted cloud at the current bar
    return { available: false };
  }
  const a = senkouAAt(spanEnd);
  const b = senkouBAt(spanEnd);
  const cloudTop = Math.max(a, b);
  const cloudBot = Math.min(a, b);
  const cloud: "above" | "below" | "in" =
    last.close > cloudTop ? "above" : last.close < cloudBot ? "below" : "in";

  // TK cross: walk back to find the most recent tenkan/kijun sign change.
  let tkCrossBarsAgo: number | null = null;
  let prevSign = 0;
  for (let i = 26; i < n; i++) {
    const t = tenkanAt(i);
    const k = kijunAt(i);
    const sign = Math.sign(t - k);
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) {
      tkCrossBarsAgo = n - 1 - i;
    }
    if (sign !== 0) prevSign = sign;
  }

  return { available: true, cloud, tkCrossBarsAgo };
}

// ── ATLAS — realized sector returns + leaders (location only) ────────────────

export interface AtlasFacts {
  available: boolean;
  sectors: SectorRow[];
  leaders: string[];
  laggards: string[];
}

export function computeAtlas(rows: SectorRow[] | null): AtlasFacts {
  if (!rows || rows.length === 0)
    return { available: false, sectors: [], leaders: [], laggards: [] };
  const sorted = [...rows].sort((x, y) => y.change24hPct - x.change24hPct);
  return {
    available: true,
    sectors: sorted,
    leaders: sorted.slice(0, 1).map((s) => s.name),
    laggards: sorted.slice(-1).map((s) => s.name),
  };
}

// ── ORDER-BOOK DEPTH — structure/location ONLY (no direction) ────────────────

export interface DepthFacts {
  available: boolean;
  mid?: number;
  /** bid notional $ within ±1% / ±2% of mid. */
  bid1Pct?: number;
  bid2Pct?: number;
  /** ask notional $ within ±1% / ±2% of mid. */
  ask1Pct?: number;
  ask2Pct?: number;
  /** descriptive ratio word (NOT a forecast). */
  skew?: "bid-heavy" | "ask-heavy" | "balanced";
  /** single largest bid wall within ±2% (price + $ notional). */
  bidWallPrice?: number;
  bidWallUsd?: number;
  /** single largest ask wall within ±2% (price + $ notional). */
  askWallPrice?: number;
  askWallUsd?: number;
  /** widest adjacent-level price gap (thin zone) within ±2% [lo, hi]. */
  thinLo?: number;
  thinHi?: number;
  /** false when the book is too dense for a meaningful vacuum (sub-tick gap). */
  thinZone?: boolean;
}

/** Skew threshold — ratio outside [1/x, x] is heavy; inside is balanced. */
const DEPTH_SKEW_RATIO = 1.25;

/**
 * Pure book-structure facts. mid = (bestBid+bestAsk)/2. Notional = price*qty
 * summed within ±1%/±2% bands; largest single-level wall per side; widest
 * adjacent-level gap as a "thin zone". NEVER a direction/target/signal — "skew"
 * is a descriptive ratio word only.
 */
export function depthSurface(book: DepthBook | null): DepthFacts {
  if (!book || book.bids.length === 0 || book.asks.length === 0) {
    return { available: false };
  }
  const bestBid = book.bids[0]![0];
  const bestAsk = book.asks[0]![0];
  if (!(bestBid > 0) || !(bestAsk > 0)) return { available: false };
  const mid = (bestBid + bestAsk) / 2;
  const band1 = mid * 0.01;
  const band2 = mid * 0.02;

  let bid1 = 0;
  let bid2 = 0;
  let bidWallUsd = 0;
  let bidWallPrice = 0;
  // Bids: prices <= mid, walk down. Within-band = mid-price <= band.
  const bidLevels: Array<[number, number]> = [];
  for (const [p, q] of book.bids) {
    const dist = mid - p;
    if (dist > band2) break; // bids descend → past ±2% we can stop
    if (dist < 0) continue; // crossed level (rare); skip
    const notional = p * q;
    if (dist <= band1) bid1 += notional;
    bid2 += notional;
    bidLevels.push([p, notional]);
    if (notional > bidWallUsd) {
      bidWallUsd = notional;
      bidWallPrice = p;
    }
  }

  let ask1 = 0;
  let ask2 = 0;
  let askWallUsd = 0;
  let askWallPrice = 0;
  const askLevels: Array<[number, number]> = [];
  for (const [p, q] of book.asks) {
    const dist = p - mid;
    if (dist > band2) break; // asks ascend → past ±2% stop
    if (dist < 0) continue;
    const notional = p * q;
    if (dist <= band1) ask1 += notional;
    ask2 += notional;
    askLevels.push([p, notional]);
    if (notional > askWallUsd) {
      askWallUsd = notional;
      askWallPrice = p;
    }
  }

  // Descriptive skew on ±1% notional (closed vocab, not a forecast).
  let skew: "bid-heavy" | "ask-heavy" | "balanced" = "balanced";
  if (ask1 > 0 && bid1 > 0) {
    const ratio = bid1 / ask1;
    skew =
      ratio >= DEPTH_SKEW_RATIO
        ? "bid-heavy"
        : ratio <= 1 / DEPTH_SKEW_RATIO
          ? "ask-heavy"
          : "balanced";
  }

  // Thin zone — widest adjacent-level price gap across the merged ±2% window
  // (low cumulative depth between two priced levels). Location only.
  const merged: number[] = [
    ...bidLevels.map(([p]) => p),
    ...askLevels.map(([p]) => p),
  ].sort((a, b) => a - b);
  let thinLo = 0;
  let thinHi = 0;
  let widest = 0;
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i]! - merged[i - 1]!;
    if (gap > widest) {
      widest = gap;
      thinLo = merged[i - 1]!;
      thinHi = merged[i]!;
    }
  }

  const round0 = (n: number) => Math.round(n);
  const round1 = (n: number) => Number(n.toFixed(1)); // BTC-perp tick precision
  const usdM = (n: number) => Number((n / 1_000_000).toFixed(1)); // $ millions, 1dp

  // A thin zone is meaningful only when the widest gap clears multiple ticks —
  // on a dense 1000-level book the gap is sub-dollar (no real vacuum). Honest:
  // report the zone only when it is materially wider than the typical spacing
  // (>= $5 here), else flag it as negligible so we never paint a fake vacuum.
  const THIN_MIN_USD = 5;
  const thinZone = widest >= THIN_MIN_USD && round1(thinLo) !== round1(thinHi);

  return {
    available: true,
    mid: round0(mid),
    bid1Pct: usdM(bid1),
    bid2Pct: usdM(bid2),
    ask1Pct: usdM(ask1),
    ask2Pct: usdM(ask2),
    skew,
    bidWallPrice: round0(bidWallPrice),
    bidWallUsd: usdM(bidWallUsd),
    askWallPrice: round0(askWallPrice),
    askWallUsd: usdM(askWallUsd),
    thinLo: round1(thinLo),
    thinHi: round1(thinHi),
    thinZone,
  };
}

// ── OPTIONS MAX-PAIN — front-expiry OI snapshot (labeled FACT, not a magnet) ──

export interface MaxPainFacts {
  available: boolean;
  /** parsed expiry token of the front (nearest) expiry (e.g. "27JUN26"). */
  expiry?: string;
  /**
   * Front expiry as a canonical ISO date (YYYY-MM-DD). The render layer narrates
   * THIS, never the raw Deribit DDMMMYY token — the DDMMMYY form embeds bare
   * digits (27, 26) that would otherwise leak as un-indexed narrated numbers
   * (only ISO YYYY-MM-DD dates are machine-exempt from the numbersIndex spine).
   */
  expiryIso?: string;
  /** max-pain strike = argmin total intrinsic value (OI-weighted). */
  maxPainStrike?: number;
  /** put/call OI ratio for that expiry. */
  putCallRatio?: number;
  /** total option OI (BTC) for that expiry. */
  totalOi?: number;
}

/**
 * Front-expiry max-pain. Selects the NEAREST not-yet-expired expiry, then for
 * each listed strike S computes pain(S) = Σ_calls OI*max(0,S-K) +
 * Σ_puts OI*max(0,K-S); max-pain = argmin. Also the put/call OI ratio + total
 * OI for that expiry. This is an OI SNAPSHOT — NOT a price magnet/target. The
 * render layer attaches the explicit no-magnet label.
 */
export function maxPainSurface(
  rows: OptionRow[] | null,
  nowMs: number,
): MaxPainFacts {
  if (!rows || rows.length === 0) return { available: false };
  // Nearest expiry strictly in the future; fall back to nearest overall if all
  // listed expiries are past (stale Deribit snapshot).
  let frontMs = Infinity;
  for (const r of rows) {
    if (r.expiryMs >= nowMs && r.expiryMs < frontMs) frontMs = r.expiryMs;
  }
  if (!Number.isFinite(frontMs)) {
    for (const r of rows) {
      if (r.expiryMs < frontMs || frontMs === Infinity) frontMs = r.expiryMs;
    }
  }
  const front = rows.filter((r) => r.expiryMs === frontMs);
  if (front.length === 0) return { available: false };
  const expiry = front[0]!.expiry;
  // Canonical ISO date for the narrated prose (date-exempt class). Derived from
  // the authoritative expiryMs so it never depends on parsing the DDMMMYY token.
  const expiryIso = new Date(frontMs).toISOString().slice(0, 10);

  const strikes = Array.from(new Set(front.map((r) => r.strike))).sort(
    (a, b) => a - b,
  );
  if (strikes.length === 0) return { available: false };

  let callOi = 0;
  let putOi = 0;
  for (const r of front) {
    if (r.kind === "C") callOi += r.openInterest;
    else putOi += r.openInterest;
  }
  const totalOi = callOi + putOi;

  let bestStrike = strikes[0]!;
  let bestPain = Infinity;
  for (const S of strikes) {
    let pain = 0;
    for (const r of front) {
      if (r.kind === "C") pain += r.openInterest * Math.max(0, S - r.strike);
      else pain += r.openInterest * Math.max(0, r.strike - S);
    }
    if (pain < bestPain) {
      bestPain = pain;
      bestStrike = S;
    }
  }

  const putCallRatio = callOi > 0 ? Number((putOi / callOi).toFixed(2)) : 0;

  return {
    available: true,
    expiry,
    expiryIso,
    maxPainStrike: bestStrike,
    putCallRatio,
    totalOi: Number(totalOi.toFixed(1)),
  };
}

// ── MODELED LIQUIDATION GEOMETRY — leverage-bucket location (NOT a forecast) ──

/** Standard leverage buckets the geometry is modeled at (frozen). */
export const LIQ_LEVERAGE_BUCKETS = [10, 25, 50, 100] as const;

/** One leverage bucket's modeled long/short liq price bands (whole dollars). */
export interface LiqBand {
  n: number;
  /** long-liq price ≈ mid·(1 − 1/N), rounded to whole dollars. */
  longLiq: number;
  /** short-liq price ≈ mid·(1 + 1/N), rounded to whole dollars. */
  shortLiq: number;
}

export interface LiqGeoFacts {
  available: boolean;
  /** order-book mid (or fallback close) the geometry is modeled from. */
  mid?: number;
  /** total perp OI notional ($) — pool that COULD be exposed (not distributed). */
  oiNotional?: number | null;
  bands?: LiqBand[];
}

/**
 * Pure leverage-bucket geometry — NO network fetch, NO forecast. For each
 * standard leverage N ∈ {10,25,50,100}: long-liq ≈ mid·(1−1/N), short-liq ≈
 * mid·(1+1/N), rounded to whole dollars. The total perp OI $ is reported as the
 * pool that COULD be exposed, NOT distributed (we do not know per-position entry
 * or leverage). This is GEOMETRY/LOCATION, exactly like order-book walls — never
 * a magnet, never a forecast, never directional. The render layer attaches the
 * explicit no-forecast/no-magnet label.
 */
export function liqGeometrySurface(
  mid: number | null,
  oiNotional: number | null,
): LiqGeoFacts {
  if (mid === null || !(mid > 0) || !Number.isFinite(mid)) {
    return { available: false };
  }
  const bands: LiqBand[] = LIQ_LEVERAGE_BUCKETS.map((n) => ({
    n,
    longLiq: Math.round(mid * (1 - 1 / n)),
    shortLiq: Math.round(mid * (1 + 1 / n)),
  }));
  return {
    available: true,
    mid: Math.round(mid),
    oiNotional:
      oiNotional !== null && Number.isFinite(oiNotional) && oiNotional > 0
        ? Math.round(oiNotional)
        : null,
    bands,
  };
}

/**
 * Structural stop-vs-band read for Rekt Shield — PURE location, NO recommendation
 * and NO forecast. Given the trade's stop + side, find the modeled liq band on
 * the SAME side (long trade → long-liq bands; short → short-liq) NEAREST the stop,
 * and report whether the stop sits within NEAR_PCT of it or clear of it. Returns
 * null when geometry is unavailable. Wording is assembled in the render layer.
 */
export interface StopBandFact {
  /** leverage bucket of the nearest same-side band. */
  n: number;
  /** the band price (whole dollars). */
  bandPrice: number;
  /** absolute % distance stop→band. */
  pct: number;
  /** within NEAR_PCT → "within", else "clear of". */
  within: boolean;
  side: "long" | "short";
}

/** Stop-vs-band proximity threshold (%). Pure structure, not a recommendation. */
export const STOP_BAND_NEAR_PCT = 5;

export function stopVsBand(
  trade: QumoTrade | null,
  geo: LiqGeoFacts,
): StopBandFact | null {
  if (!trade || !geo.available || !geo.bands) return null;
  const { side, stop } = trade;
  if (!Number.isFinite(stop) || !(stop > 0)) return null;
  let best: StopBandFact | null = null;
  for (const b of geo.bands) {
    const bandPrice = side === "long" ? b.longLiq : b.shortLiq;
    if (!(bandPrice > 0)) continue;
    const pct = Number(((Math.abs(stop - bandPrice) / stop) * 100).toFixed(1));
    if (best === null || pct < best.pct) {
      best = {
        n: b.n,
        bandPrice,
        pct,
        within: pct <= STOP_BAND_NEAR_PCT,
        side,
      };
    }
  }
  return best;
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function fmtSigned(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function roundDigits(price: number): number {
  if (price >= 1000) return 0;
  if (price >= 1) return 2;
  return 4;
}
