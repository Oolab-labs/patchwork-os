export function relTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Human-readable duration. Renders the two largest non-zero units so
 * "1d 7h 12m 38s" doesn't blow up the layout — at typical scales the user
 * cares about days+hours OR hours+minutes OR minutes+seconds, never four.
 *
 * Earlier behaviour capped at minutes ("1861m 38s" for 31 hours) — a
 * 2026-04-29 dogfood pass found the bridge running for ~31 h was rendered
 * as "1861m 38s" on the Overview, "112,219s" on Settings, and "112,157"
 * raw on the Metrics page. Now uniformly "1d 7h" / "1d 7h 12m" / etc.
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.floor(ms)}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`;
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${sec}s`;
  const min = totalMin % 60;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) return `${totalHr}h ${min}m`;
  const hr = totalHr % 24;
  const days = Math.floor(totalHr / 24);
  return hr > 0 ? `${days}d ${hr}h` : `${days}d`;
}
