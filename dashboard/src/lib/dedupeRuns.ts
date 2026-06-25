/**
 * Defensive de-duplication for the /runs list.
 *
 * The bridge `/runs` response can carry the same logical run twice — the
 * 5s poll racing the SSE-triggered reload, or an upstream duplicate. The
 * run row key is `${taskId}-${seq}`, so a collision triggers React's
 * "Encountered two children with the same key" error (≈72 console errors
 * per load) and risks dropped/duplicated rows + double-counted stats.
 *
 * `taskId` embeds a timestamp and `seq` is a monotonic counter, so an
 * identical (taskId, seq) pair is the same run — safe to collapse to the
 * first occurrence. Order is preserved.
 */
export function dedupeRunsByKey<
  T extends { taskId?: string | null; seq?: number | null },
>(runs: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of runs) {
    const key = `${r.taskId ?? ""}-${r.seq ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
