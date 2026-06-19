/**
 * collectors.ts — free-no-key feed collectors for the QUMO honest desk.
 *
 * Each collector wraps fetch in try/catch → FeedResult {value|null, asOf,
 * source, state}. Successful pulls append a snapshot to
 * ~/.patchwork/qumo-cache/<feed>.jsonl so the ~30d-retention derivative feeds
 * accrete history from launch date. NEVER fabricates a value — failure → null
 * + state 'offline'.
 *
 * Endpoints mirror src/recipes/tools/market.ts (same hosts/shapes). Run off-box
 * on the local Mac only (the VPS http tool is POST-only with no crypto tools).
 * Atlas adds a NET-NEW CoinGecko /coins/categories collector (DESIGN feed #13).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { coerceCandles } from "../backtest/ingest.js";
import type { Candle } from "../types.js";
import type {
  Collected,
  DepthBook,
  FeedResult,
  OptionRow,
  SectorRow,
} from "./types.js";

const CACHE_DIR = path.join(homedir(), ".patchwork", "qumo-cache");
const UA = { "User-Agent": "patchwork-qumo-desk/1.0" };

/** Append one snapshot line to the per-feed cache (best-effort, never throws). */
function cache(feed: string, value: unknown): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    appendFileSync(
      path.join(CACHE_DIR, `${feed}.jsonl`),
      `${JSON.stringify({ ts: new Date().toISOString(), value })}\n`,
    );
  } catch {
    // cache write failure is non-fatal — the desk still posts live values
  }
}

async function getJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function offline<T>(
  source: string,
  state: FeedResult["state"] = "offline",
): FeedResult<T> {
  return { value: null, asOf: null, source, state };
}

/** BTC 1d klines — the price-only validated substrate. */
async function collectBtc1d(): Promise<FeedResult<Candle[]>> {
  const src = "api.binance.com";
  try {
    const json = await getJson(
      "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=400",
    );
    const candles = coerceCandles(json);
    if (candles.length < 2) return offline("api.binance.com");
    cache("btc1d", {
      count: candles.length,
      last: candles[candles.length - 1],
    });
    return {
      value: candles,
      asOf: new Date(candles[candles.length - 1]!.openTime).toISOString(),
      source: src,
      state: "live",
    };
  } catch {
    return offline(src);
  }
}

/** 24h percent change for BTC (verbatim feed value). */
async function collectBtc24h(): Promise<FeedResult<number>> {
  const src = "api.binance.com";
  try {
    const json = (await getJson(
      "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT",
    )) as { priceChangePercent?: string };
    const pct = Number(json.priceChangePercent);
    if (!Number.isFinite(pct)) return offline(src);
    const rounded = Number(pct.toFixed(1));
    cache("btc24h", rounded);
    return { value: rounded, asOf: nowIso(), source: src, state: "live" };
  } catch {
    return offline(src);
  }
}

/** Current funding rate (fraction). */
async function collectFunding(): Promise<FeedResult<number>> {
  const src = "fapi.binance.com";
  try {
    const json = (await getJson(
      "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT",
    )) as { lastFundingRate?: string };
    const rate = Number(json.lastFundingRate);
    if (!Number.isFinite(rate)) return offline(src);
    // render as percent with 3dp (e.g. -0.006)
    const pct = Number((rate * 100).toFixed(3));
    cache("funding", pct);
    return { value: pct, asOf: nowIso(), source: src, state: "live" };
  } catch {
    return offline(src);
  }
}

/** Taker buy ratio → percent (archived, no lean). */
async function collectTakerBuy(): Promise<FeedResult<number>> {
  const src = "fapi.binance.com";
  try {
    const json = (await getJson(
      "https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=1d&limit=1",
    )) as Array<{ buySellRatio?: string }>;
    const last = Array.isArray(json) ? json[json.length - 1] : undefined;
    const ratio = Number(last?.buySellRatio);
    if (!Number.isFinite(ratio)) return offline(src);
    // buy share = ratio / (ratio + 1)
    const pct = Math.round((ratio / (ratio + 1)) * 100);
    cache("takerBuy", pct);
    return { value: pct, asOf: nowIso(), source: src, state: "live" };
  } catch {
    return offline(src);
  }
}

/** Global crowd long percent (archived, no lean). */
async function collectCrowdLong(): Promise<FeedResult<number>> {
  const src = "fapi.binance.com";
  try {
    const json = (await getJson(
      "https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1d&limit=1",
    )) as Array<{ longAccount?: string }>;
    const last = Array.isArray(json) ? json[json.length - 1] : undefined;
    const longFrac = Number(last?.longAccount);
    if (!Number.isFinite(longFrac)) return offline(src);
    const pct = Math.round(longFrac * 100);
    cache("crowdLong", pct);
    return { value: pct, asOf: nowIso(), source: src, state: "live" };
  } catch {
    return offline(src);
  }
}

/**
 * OI change percent first→last over ~30d window (archived, no lean) PLUS the
 * latest absolute perp-OI notional ($) — the LAST element's sumOpenInterestValue.
 * Both derive from the SAME openInterestHist fetch (no extra network call). The
 * notional is the total perp OI $ pool the liq-geometry surface reports as the
 * pool that COULD be exposed (NOT distributed — no per-position entry/leverage).
 */
async function collectOiChange(): Promise<{
  pct: FeedResult<number>;
  notional: FeedResult<number>;
}> {
  const src = "fapi.binance.com";
  try {
    const json = (await getJson(
      "https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=30",
    )) as Array<{ sumOpenInterestValue?: string }>;
    if (!Array.isArray(json) || json.length < 2) {
      return { pct: offline(src), notional: offline(src) };
    }
    const first = Number(json[0]?.sumOpenInterestValue);
    const last = Number(json[json.length - 1]?.sumOpenInterestValue);
    if (!(first > 0) || !Number.isFinite(last)) {
      return { pct: offline(src), notional: offline(src) };
    }
    const pct = Math.round(((last - first) / first) * 100);
    cache("oiChange", pct);
    const notionalVal = last > 0 ? Math.round(last) : null;
    if (notionalVal !== null) cache("oiNotional", notionalVal);
    const stamp = nowIso();
    return {
      pct: { value: pct, asOf: stamp, source: src, state: "live" },
      notional:
        notionalVal !== null
          ? { value: notionalVal, asOf: stamp, source: src, state: "live" }
          : offline(src),
    };
  } catch {
    return { pct: offline(src), notional: offline(src) };
  }
}

/** Fear & Greed 0-100. */
async function collectFeargreed(): Promise<FeedResult<number>> {
  const src = "api.alternative.me";
  try {
    const json = (await getJson("https://api.alternative.me/fng/?limit=1")) as {
      data?: Array<{ value?: string }>;
    };
    const v = Number(json.data?.[0]?.value);
    if (!Number.isFinite(v)) return offline(src);
    cache("feargreed", v);
    return { value: v, asOf: nowIso(), source: src, state: "live" };
  } catch {
    return offline(src);
  }
}

/**
 * Breadth — count of tracked majors green/red over 24h. Deterministic realized
 * count, not a composite. Uses a fixed small tracked set (no survivorship math).
 */
const BREADTH_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "ADAUSDT",
];

async function collectBreadth(): Promise<
  FeedResult<{ green: number; red: number; universe: number }>
> {
  const src = "api.binance.com";
  try {
    const json = (await getJson(
      "https://api.binance.com/api/v3/ticker/24hr",
    )) as Array<{ symbol?: string; priceChangePercent?: string }>;
    if (!Array.isArray(json)) return offline(src);
    const want = new Set(BREADTH_SYMBOLS);
    let green = 0;
    let red = 0;
    let universe = 0;
    for (const t of json) {
      if (!want.has(String(t.symbol))) continue;
      const pct = Number(t.priceChangePercent);
      if (!Number.isFinite(pct)) continue;
      universe++;
      if (pct >= 0) green++;
      else red++;
    }
    if (universe === 0) return offline(src);
    const value = { green, red, universe };
    cache("breadth", value);
    return { value, asOf: nowIso(), source: src, state: "live" };
  } catch {
    return offline(src);
  }
}

/**
 * Atlas — NET-NEW CoinGecko /coins/categories collector. 24h realized sector
 * market-cap change + leader symbols (location only, no edge). Ships
 * offline-gracefully if rate-limited (the most fragile v1 surface).
 *
 * /coins/categories serves a 24h market-cap change — that is the honest
 * realized number and is labeled as 24h everywhere (NOT 7d). The free endpoint
 * serves NO per-leader %, so leaders carry symbols only (no fabricated %).
 *
 * Demo key via env COINGECKO_API_KEY (header x-cg-demo-api-key); falls back to
 * the public no-key endpoint (unstable rate limit).
 */
async function collectAtlas(): Promise<FeedResult<SectorRow[]>> {
  const src = "api.coingecko.com";
  const key = process.env.COINGECKO_API_KEY;
  const base =
    "https://api.coingecko.com/api/v3/coins/categories?order=market_cap_change_24h_desc";
  const url = key
    ? `${base}&x_cg_demo_api_key=${encodeURIComponent(key)}`
    : base;
  try {
    const json = (await getJson(url, 12_000)) as Array<{
      name?: string;
      market_cap_change_24h?: number;
      top_3_coins_id?: string[];
    }>;
    if (!Array.isArray(json) || json.length === 0) return offline(src);
    // Curated MACRO sectors only. CoinGecko's /categories returns hundreds of
    // niche buckets ("Backpack Securities Ecosystem", launchpads, etc.); sorting
    // those by 24h change surfaces micro-cap noise, not a meaningful rotation
    // read. Anchor to the canonical broad-category names so we get the real
    // AI / L1 / L2 / DeFi / RWA / Meme / Gaming / DePIN macro buckets.
    const SECTOR_ALLOW: { re: RegExp; label: string }[] = [
      { re: /^artificial intelligence/i, label: "AI" },
      { re: /^layer 1\b/i, label: "L1" },
      { re: /^layer 2\b/i, label: "L2" },
      { re: /^decentralized finance/i, label: "DeFi" },
      { re: /^real world assets/i, label: "RWA" },
      { re: /^meme$/i, label: "Meme" },
      { re: /^gaming/i, label: "Gaming" },
      { re: /^depin\b/i, label: "DePIN" },
    ];
    const seen = new Set<string>();
    const rows: SectorRow[] = [];
    for (const c of json) {
      if (!Number.isFinite(c.market_cap_change_24h)) continue;
      const hit = SECTOR_ALLOW.find((s) => s.re.test(String(c.name ?? "")));
      if (!hit || seen.has(hit.label)) continue; // one row per macro sector
      seen.add(hit.label);
      rows.push({
        name: hit.label,
        change24hPct: Number((c.market_cap_change_24h as number).toFixed(1)),
        leaders: (c.top_3_coins_id ?? []).slice(0, 2).map((id) => String(id)),
      });
    }
    rows.sort((a, b) => b.change24hPct - a.change24hPct);
    if (rows.length === 0) return offline(src);
    cache("atlas", rows);
    return { value: rows, asOf: nowIso(), source: src, state: "live" };
  } catch {
    return offline(src);
  }
}

/**
 * Order-book depth — Binance USDM futures REST snapshot (BTC v1, no key).
 * Returns the raw book (price/qty coerced to numbers, qty in BTC). The surface
 * derives structure/location only (no direction). Fail-soft → null.
 */
async function collectDepth(): Promise<FeedResult<DepthBook>> {
  const src = "fapi.binance.com";
  try {
    const json = (await getJson(
      "https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000",
    )) as { bids?: [string, string][]; asks?: [string, string][] };
    const coerce = (
      rows: [string, string][] | undefined,
    ): Array<[number, number]> =>
      (Array.isArray(rows) ? rows : [])
        .map(([p, q]) => [Number(p), Number(q)] as [number, number])
        .filter(
          ([p, q]) =>
            Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0,
        );
    const bids = coerce(json.bids);
    const asks = coerce(json.asks);
    if (bids.length === 0 || asks.length === 0) return offline(src);
    // Binance returns bids descending, asks ascending — keep that ordering.
    const book: DepthBook = { bids, asks };
    cache("depth", {
      bidLevels: bids.length,
      askLevels: asks.length,
      bestBid: bids[0]?.[0],
      bestAsk: asks[0]?.[0],
    });
    return { value: book, asOf: nowIso(), source: src, state: "live" };
  } catch {
    return offline(src);
  }
}

/**
 * Deribit BTC options book summary — front-expiry max-pain substrate (no key).
 * Parses strike + C/P + expiry from each instrument_name; carries open_interest
 * (BTC). The surface filters to the nearest expiry and computes max-pain.
 * Fail-soft → null (rendered as "Deribit options: feed offline").
 */
async function collectDeribitOptions(): Promise<FeedResult<OptionRow[]>> {
  const src = "deribit.com";
  try {
    const json = (await getJson(
      "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option",
      12_000,
    )) as {
      result?: Array<{ instrument_name?: string; open_interest?: number }>;
    };
    const result = Array.isArray(json.result) ? json.result : [];
    if (result.length === 0) return offline(src);
    const rows: OptionRow[] = [];
    for (const r of result) {
      const parsed = parseInstrument(String(r.instrument_name ?? ""));
      if (!parsed) continue;
      const oi = Number(r.open_interest);
      if (!Number.isFinite(oi) || oi <= 0) continue;
      rows.push({ ...parsed, openInterest: oi });
    }
    if (rows.length === 0) return offline(src);
    cache("options", { instruments: rows.length });
    return { value: rows, asOf: nowIso(), source: src, state: "live" };
  } catch {
    return offline(src);
  }
}

const MONTHS: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

/**
 * Parse a Deribit option instrument_name "BTC-27JUN26-60000-C" →
 * { strike, kind, expiry, expiryMs }. Returns null on any malformed token.
 */
function parseInstrument(name: string): {
  strike: number;
  kind: "C" | "P";
  expiry: string;
  expiryMs: number;
} | null {
  const parts = name.split("-");
  if (parts.length !== 4) return null;
  const [, expiry, strikeStr, cp] = parts;
  if (cp !== "C" && cp !== "P") return null;
  const strike = Number(strikeStr);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  // expiry shape: DDMMMYY (e.g. 27JUN26).
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(String(expiry));
  if (!m) return null;
  const day = Number(m[1]);
  const mon = MONTHS[m[2]!];
  const yr = 2000 + Number(m[3]);
  if (mon === undefined || !Number.isFinite(day)) return null;
  // Deribit options expire 08:00 UTC.
  const expiryMs = Date.UTC(yr, mon, day, 8, 0, 0);
  if (!Number.isFinite(expiryMs)) return null;
  return { strike, kind: cp, expiry: String(expiry), expiryMs };
}

/** Collect all free feeds concurrently. Each is independently fail-soft. */
export async function collectAll(): Promise<Collected> {
  const [
    btc1d,
    btc24hPct,
    funding,
    takerBuyPct,
    crowdLongPct,
    oi,
    feargreed,
    breadth,
    atlas,
    depth,
    options,
  ] = await Promise.all([
    collectBtc1d(),
    collectBtc24h(),
    collectFunding(),
    collectTakerBuy(),
    collectCrowdLong(),
    collectOiChange(),
    collectFeargreed(),
    collectBreadth(),
    collectAtlas(),
    collectDepth(),
    collectDeribitOptions(),
  ]);
  return {
    btc1d,
    btc24hPct,
    funding,
    takerBuyPct,
    crowdLongPct,
    oiChangePct: oi.pct,
    oiNotional: oi.notional,
    feargreed,
    breadth,
    atlas,
    depth,
    options,
  };
}

/** A fully-offline Collected — used when --dry-run wants no network. */
export function offlineCollected(): Collected {
  return {
    btc1d: offline("api.binance.com"),
    btc24hPct: offline("api.binance.com"),
    funding: offline("fapi.binance.com"),
    takerBuyPct: offline("fapi.binance.com"),
    crowdLongPct: offline("fapi.binance.com"),
    oiChangePct: offline("fapi.binance.com"),
    oiNotional: offline("fapi.binance.com"),
    feargreed: offline("api.alternative.me"),
    breadth: offline("api.binance.com"),
    atlas: offline("api.coingecko.com"),
    depth: offline("fapi.binance.com"),
    options: offline("deribit.com"),
  };
}
