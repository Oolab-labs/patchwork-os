/**
 * Binance Vision kline CSV parser.
 *
 * Bulk dumps from data.binance.vision are headerless CSV, 12 columns:
 *   openTime, open, high, low, close, volume, closeTime, quoteVolume,
 *   trades, takerBuyBase, takerBuyQuote, ignore
 * openTime/closeTime are epoch values; 2025-era dumps switched some pairs from
 * milliseconds to microseconds, so we normalise anything > 1e15 down to ms.
 */

import type { Candle } from "../types.js";

/** Normalise a Binance epoch (ms or µs) to milliseconds. */
function toMs(raw: number): number {
  return raw > 1e15 ? Math.floor(raw / 1000) : raw;
}

/** Parse headerless Binance Vision kline CSV text into chronological candles. */
export function parseKlineCsv(text: string): Candle[] {
  const out: Candle[] = [];
  for (const line of text.split("\n")) {
    const row = line.trim();
    if (!row) continue;
    const f = row.split(",");
    if (f.length < 7) continue;
    const openTime = toMs(Number(f[0]));
    const open = Number(f[1]);
    const high = Number(f[2]);
    const low = Number(f[3]);
    const close = Number(f[4]);
    const volume = Number(f[5]);
    const closeTime = toMs(Number(f[6]));
    if (
      !Number.isFinite(openTime) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue; // skip a malformed/partial row rather than poison the series
    }
    out.push({ openTime, open, high, low, close, volume, closeTime });
  }
  out.sort((a, b) => a.openTime - b.openTime);
  return out;
}

/**
 * Coerce loosely-typed input (a JSON string, an array of objects, or an array
 * of kline tuples [openTime,o,h,l,c,v,closeTime,...]) into candles. Used by the
 * recipe tools, which receive OHLCV from a WebFetch agent step.
 */
export function coerceCandles(raw: unknown): Candle[] {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: Candle[] = [];
  for (const r of arr) {
    if (Array.isArray(r) && r.length >= 6) {
      const openTime = toMs(Number(r[0]));
      out.push({
        openTime,
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
        closeTime: toMs(Number(r[6] ?? openTime)),
      });
    } else if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      const openTime = toMs(Number(o.openTime ?? o.time ?? 0));
      out.push({
        openTime,
        open: Number(o.open),
        high: Number(o.high),
        low: Number(o.low),
        close: Number(o.close),
        volume: Number(o.volume ?? 0),
        closeTime: toMs(Number(o.closeTime ?? o.openTime ?? openTime)),
      });
    }
  }
  return out.filter(
    (c) =>
      Number.isFinite(c.openTime) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close),
  );
}

/** De-duplicate candles by openTime (monthly dumps can overlap at edges). */
export function dedupeCandles(candles: Candle[]): Candle[] {
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const c of candles) {
    if (seen.has(c.openTime)) continue;
    seen.add(c.openTime);
    out.push(c);
  }
  return out;
}
