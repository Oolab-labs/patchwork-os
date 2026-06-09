/**
 * Pure, zero-dependency vector math. No imports — keep it that way so it can
 * be reused anywhere (ranking, dedup, semantic search) without pulling in
 * network / config / driver dependencies.
 */

/**
 * Cosine similarity = dot(a, b) / (|a| * |b|).
 *
 * Returns `0` (never `NaN`, never throws) on:
 *   - length mismatch between `a` and `b`
 *   - either vector being zero-magnitude
 *   - empty vectors
 *
 * Identical vectors → 1, orthogonal → 0, opposite → -1.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    // Bounds-safe: i < a.length === b.length (checked above).
    const av = a[i] as number;
    const bv = b[i] as number;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Return the `k` highest-scoring items, sorted score-descending. Stable for
 * ties — items with equal score keep their original relative order.
 *
 * `k` larger than the list returns all items (sorted). `k <= 0` returns `[]`.
 */
export function topK<T>(
  items: T[],
  scoreOf: (item: T) => number,
  k: number,
): T[] {
  if (k <= 0) return [];
  // Decorate with original index to make the sort stable across ties.
  const decorated = items.map((item, index) => ({
    item,
    index,
    score: scoreOf(item),
  }));
  decorated.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    return x.index - y.index;
  });
  return decorated.slice(0, k).map((d) => d.item);
}
