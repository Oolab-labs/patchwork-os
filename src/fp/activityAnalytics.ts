/**
 * Pure functions extracted from ActivityLog.
 * No side effects, no Date.now(), no fs, no process.*.
 */
import type { ActivityEntry } from "../activityTypes.js";

/** Max map entries during co-occurrence computation before evicting lowest-count entry. */
const CO_OCCURRENCE_MAP_CAP = 200;

export function computeStats(
  entries: readonly ActivityEntry[],
): Record<string, { count: number; avgDurationMs: number; errors: number }> {
  const map = new Map<
    string,
    { count: number; totalMs: number; errors: number }
  >();
  for (const entry of entries) {
    let s = map.get(entry.tool);
    if (!s) {
      s = { count: 0, totalMs: 0, errors: 0 };
      map.set(entry.tool, s);
    }
    s.count++;
    s.totalMs += entry.durationMs;
    if (entry.status === "error") s.errors++;
  }
  const result: Record<
    string,
    { count: number; avgDurationMs: number; errors: number }
  > = {};
  for (const [tool, s] of map) {
    result[tool] = {
      count: s.count,
      avgDurationMs: Math.round(s.totalMs / s.count),
      errors: s.errors,
    };
  }
  return result;
}

/** Nearest-rank percentile from a pre-sorted ascending array. */
function percentileValue(sorted: number[], pct: number): number {
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)] ?? 0);
}

/**
 * Per-tool p50/p95/p99 from bounded duration sample maps.
 * Tools with fewer than 2 samples are omitted.
 */
export function computePercentiles(
  samples: ReadonlyMap<string, readonly number[]>,
): Record<
  string,
  { p50: number; p95: number; p99: number; sampleCount: number }
> {
  const result: Record<
    string,
    { p50: number; p95: number; p99: number; sampleCount: number }
  > = {};
  for (const [tool, raw] of samples) {
    if (raw.length < 2) continue;
    const sorted = [...raw].sort((a, b) => a - b);
    result[tool] = {
      p50: percentileValue(sorted, 50),
      p95: percentileValue(sorted, 95),
      p99: percentileValue(sorted, 99),
      sampleCount: sorted.length,
    };
  }
  return result;
}

/**
 * Tool-pair co-occurrence within a sliding time window.
 * Pairs ordered (A < B alphabetically) to avoid double-counting.
 * Enforces a 200-key map cap during computation (evicts lowest-count entry).
 * Returns at most maxPairs results sorted by count desc (default 50).
 */
export function computeCoOccurrence(
  entries: readonly ActivityEntry[],
  windowMs: number,
  maxPairs = 50,
): Array<{ pair: string; count: number }> {
  const counts = new Map<string, number>();
  const n = entries.length;
  // Pre-compute epoch timestamps once to avoid repeated Date construction in nested loop.
  const times = new Array<number>(n);
  for (let k = 0; k < n; k++) {
    times[k] = Date.parse(entries[k]?.timestamp ?? "");
  }
  for (let i = 0; i < n; i++) {
    const a = entries[i];
    if (!a) continue;
    const tA = times[i] ?? 0;
    for (let j = i + 1; j < n; j++) {
      const b = entries[j];
      if (!b) continue;
      if ((times[j] ?? 0) - tA > windowMs) break;
      if (a.tool === b.tool) continue;
      const key =
        a.tool < b.tool ? `${a.tool}|${b.tool}` : `${b.tool}|${a.tool}`;
      if (counts.size >= CO_OCCURRENCE_MAP_CAP) continue; // skip new pairs at cap
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const pairs = Array.from(counts.entries());
  pairs.sort((a, b) => b[1] - a[1]);
  const result: Array<{ pair: string; count: number }> = [];
  for (let i = 0; i < pairs.length && i < maxPairs; i++) {
    const [pair, count] = pairs[i]!;
    result.push({ pair, count });
  }
  return result;
}

/**
 * Per-tool stats within a sliding time window.
 * Caller injects `now` so this function is deterministic.
 */
export function computeWindowedStats(
  entries: readonly ActivityEntry[],
  windowMs: number,
  now: number,
): Record<string, { count: number; errors: number; avgDurationMs: number }> {
  const cutoff = now - windowMs;
  const map = new Map<
    string,
    { count: number; totalMs: number; errors: number }
  >();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e) continue;
    if (Date.parse(e.timestamp) < cutoff) break;
    let s = map.get(e.tool);
    if (!s) {
      s = { count: 0, totalMs: 0, errors: 0 };
      map.set(e.tool, s);
    }
    s.count++;
    s.totalMs += e.durationMs;
    if (e.status === "error") s.errors++;
  }
  const result: Record<
    string,
    { count: number; errors: number; avgDurationMs: number }
  > = {};
  for (const [tool, s] of map) {
    result[tool] = {
      count: s.count,
      errors: s.errors,
      avgDurationMs: s.count > 0 ? Math.round(s.totalMs / s.count) : 0,
    };
  }
  return result;
}
