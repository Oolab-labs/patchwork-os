/**
 * Aggregate predictions into per-claim summaries: hit-rate, Wilson CI,
 * baseline rate, edge (method − baseline), and the min-N sufficiency flag.
 */

import { MIN_N, wilson } from "./scoring.js";
import type { Prediction } from "./walkForward.js";

export interface ClaimSummary {
  key: string;
  type: string;
  n?: number;
  count: number;
  hits: number;
  hitRate: number;
  ciLo: number;
  ciHi: number;
  baselineHits: number;
  baselineRate: number;
  edge: number;
  sufficientN: boolean;
}

export function summarize(preds: Prediction[]): ClaimSummary[] {
  const groups = new Map<string, Prediction[]>();
  for (const p of preds) {
    const key = p.type === "time-cycle" ? `time-cycle:${p.n}` : p.type;
    const arr = groups.get(key);
    if (arr) arr.push(p);
    else groups.set(key, [p]);
  }

  const out: ClaimSummary[] = [];
  for (const [key, arr] of groups) {
    const count = arr.length;
    const hits = arr.filter((p) => p.hit).length;
    const baselineHits = arr.filter((p) => p.baselineHit).length;
    const hitRate = count ? hits / count : 0;
    const baselineRate = count ? baselineHits / count : 0;
    const ci = wilson(hits, count);
    out.push({
      key,
      type: arr[0]!.type,
      n: arr[0]!.n,
      count,
      hits,
      hitRate,
      ciLo: ci.lo,
      ciHi: ci.hi,
      baselineHits,
      baselineRate,
      edge: hitRate - baselineRate,
      sufficientN: count >= MIN_N,
    });
  }

  out.sort((a, b) => b.edge - a.edge);
  return out;
}
