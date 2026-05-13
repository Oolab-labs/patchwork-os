/**
 * Single source of truth for "what counts as a halted run".
 *
 * Before this module, `app/page.tsx` and `app/analytics/page.tsx`
 * disagreed: the overview treated error/failed/cancelled/interrupted
 * as halts, while analytics only counted "error". Same KPI, two values.
 */

export type HaltStatus = "error" | "failed" | "cancelled" | "interrupted";

const HALT_STATUSES: ReadonlySet<string> = new Set([
  "error",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isHaltStatus(status: string | undefined | null): boolean {
  if (!status) return false;
  return HALT_STATUSES.has(status);
}
