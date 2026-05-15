/**
 * "Halts since last visit" notification baseline.
 *
 * The Live nav badge used to render the rolling 24h halt total directly,
 * which has two failure modes for a glanceable badge:
 *
 *   1. The number monotonically increases as halts pile up — the user sees
 *      "36" beside Live, opens /activity, and the 36 stays. There is no
 *      UI affordance to acknowledge it; the only "clear" is waiting 24h.
 *   2. The label "Live" implies real-time event count; the underlying
 *      signal is post-hoc historical totals.
 *
 * This module replaces that with the standard messaging-app pattern:
 * the badge counts halts that arrived AFTER the user last looked. Visiting
 * /activity calls `markHaltsSeen()` which stamps `Date.now()` into
 * localStorage; subsequent `useHaltCount` polls scope their `sinceMs` to
 * `now - lastSeenAt` (capped at 24h so a stale install can't query the
 * full backend history).
 *
 * Same-tab updates fire through a tiny EventTarget so the Shell badge
 * refreshes immediately on visit, instead of waiting for the 60s poll.
 */

const STORAGE_KEY = "patchwork.haltsLastSeenAt";
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const HALTS_SEEN_EVENT = "patchwork:halts-seen";

const target: EventTarget | null =
  typeof window === "undefined" ? null : new EventTarget();

function readStored(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeStored(ts: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(ts));
  } catch {
    /* private mode; in-memory subscribers still get the event */
  }
}

/**
 * Returns the lookback window (in milliseconds) the halt-summary endpoint
 * should query. Capped at 24h. If the user has never visited /activity,
 * defaults to the full 24h so they still get the historical-pressure
 * signal instead of a silent zero.
 */
export function getHaltsLookbackMs(): number {
  const lastSeenAt = readStored();
  if (lastSeenAt === null) return MAX_LOOKBACK_MS;
  const elapsed = Date.now() - lastSeenAt;
  if (elapsed <= 0) return 0;
  return Math.min(elapsed, MAX_LOOKBACK_MS);
}

/**
 * Mark the current moment as "user has acknowledged halts up to here."
 * Causes any subscribed `useHaltCount` to refetch immediately so the
 * badge clears without waiting for the next 60s tick.
 */
export function markHaltsSeen(): void {
  writeStored(Date.now());
  target?.dispatchEvent(new Event(HALTS_SEEN_EVENT));
}

/**
 * Subscribe to same-tab `markHaltsSeen` calls. Returns an unsubscribe.
 * The cross-tab `storage` event covers other tabs; this covers the tab
 * that did the marking (which `storage` doesn't fire for).
 */
export function subscribeHaltsSeen(cb: () => void): () => void {
  if (!target) return () => {};
  const handler = () => cb();
  target.addEventListener(HALTS_SEEN_EVENT, handler);
  return () => target.removeEventListener(HALTS_SEEN_EVENT, handler);
}
