/**
 * In-memory failure tracker for dashboard Basic auth.
 *
 * Scope: single-instance, self-hosted Next.js. State is per-process; multi-
 * instance deployments would need a shared store (Redis, etc.). For
 * Patchwork's typical deployment (one Next.js process per workstation /
 * server) this is sufficient.
 *
 * Algorithm: sliding window over recent failure timestamps. After
 * MAX_FAILURES within FAILURE_WINDOW_MS, lock the IP for LOCKOUT_MS. A
 * successful auth clears the entry for that IP.
 */

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_FAILURES = parsePositiveInt(
  process.env.DASHBOARD_AUTH_MAX_FAILURES,
  5,
);
const FAILURE_WINDOW_MS = parsePositiveInt(
  process.env.DASHBOARD_AUTH_FAILURE_WINDOW_MS,
  15 * 60 * 1000,
);
const LOCKOUT_MS = parsePositiveInt(
  process.env.DASHBOARD_AUTH_LOCKOUT_MS,
  15 * 60 * 1000,
);

// Bound memory under attack. When exceeded, evict the oldest entry by
// insertion order. This is best-effort: a determined attacker rotating IPs
// can churn the cache, but they don't gain auth bypass — they only push
// other entries out, and tracked failures are an additive defense, not the
// primary one.
const MAX_ENTRIES = 10_000;

interface Entry {
  failures: number[]; // timestamps in ms
  lockedUntil: number; // 0 when not locked
}

const store = new Map<string, Entry>();

function getOrInit(key: string): Entry {
  let entry = store.get(key);
  if (!entry) {
    if (store.size >= MAX_ENTRIES) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    entry = { failures: [], lockedUntil: 0 };
    store.set(key, entry);
  }
  return entry;
}

export type LockResult =
  | { locked: false }
  | { locked: true; retryAfterSec: number };

export function checkLocked(key: string, now: number = Date.now()): LockResult {
  const entry = store.get(key);
  if (!entry) return { locked: false };
  if (entry.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000),
    };
  }
  return { locked: false };
}

export function recordFailure(
  key: string,
  now: number = Date.now(),
): LockResult {
  const entry = getOrInit(key);
  // If a previous lockout has expired, allow a fresh window.
  if (entry.lockedUntil !== 0 && entry.lockedUntil <= now) {
    entry.lockedUntil = 0;
    entry.failures = [];
  }
  const cutoff = now - FAILURE_WINDOW_MS;
  entry.failures = entry.failures.filter((t) => t > cutoff);
  entry.failures.push(now);
  if (entry.failures.length >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
    entry.failures = [];
    return { locked: true, retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) };
  }
  return { locked: false };
}

export function recordSuccess(key: string): void {
  store.delete(key);
}

export function _resetForTests(): void {
  store.clear();
}

export const _config = {
  MAX_FAILURES,
  FAILURE_WINDOW_MS,
  LOCKOUT_MS,
  MAX_ENTRIES,
};
