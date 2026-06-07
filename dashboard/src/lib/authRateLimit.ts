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

/* ------------------------------------------------------------------------- *
 * Global fallback rate limiter — audit 2026-06-03 MEDIUM #18.
 *
 * When no trusted reverse proxy is configured, clientKey() returns "unknown"
 * for every request. A per-IP lockout would deny all users after just
 * MAX_FAILURES bad passwords. The global bucket uses a much higher threshold
 * (DASHBOARD_AUTH_GLOBAL_MAX_FAILURES, default 50) so automated attacks are
 * still bounded while a user making a few typos never gets locked out.
 * The same `store` Map is used; "unknown" IPs are keyed on GLOBAL_KEY.
 * ------------------------------------------------------------------------- */
const GLOBAL_MAX_FAILURES = parsePositiveInt(
  process.env.DASHBOARD_AUTH_GLOBAL_MAX_FAILURES,
  50,
);

const GLOBAL_KEY = "__global_ratelimit__";

export function checkGlobalLocked(now: number = Date.now()): LockResult {
  return checkLocked(GLOBAL_KEY, now);
}

export function recordGlobalFailure(now: number = Date.now()): LockResult {
  const entry = getOrInit(GLOBAL_KEY);
  if (entry.lockedUntil !== 0 && entry.lockedUntil <= now) {
    entry.lockedUntil = 0;
    entry.failures = [];
  }
  const cutoff = now - FAILURE_WINDOW_MS;
  entry.failures = entry.failures.filter((t) => t > cutoff);
  entry.failures.push(now);
  if (entry.failures.length >= GLOBAL_MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
    entry.failures = [];
    return { locked: true, retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) };
  }
  return { locked: false };
}

export const _globalConfig = {
  GLOBAL_MAX_FAILURES,
};

/* ------------------------------------------------------------------------- *
 * Generic call-count rate limiter (NOT the failure tracker above).
 *
 * The failure tracker only records auth *failures* — a successful login
 * clears the entry, so it cannot bound the rate of *successful* expensive
 * calls. The recipe-install proxy needs the opposite: every call is
 * expensive (a GitHub fetch + filesystem write on the bridge), so a stolen
 * cookie or insider can hammer it at full speed and exhaust disk or GitHub's
 * unauthenticated 60 req/hr limit for everyone. This is a separate sliding-
 * window counter that counts ALL calls within a window, keyed by an opaque
 * caller identity (a hash of the session cookie, or a coarse IP fallback).
 *
 * Same single-process scope caveat as the failure tracker.
 * ------------------------------------------------------------------------- */

const MAX_CALLS = parsePositiveInt(
  process.env.DASHBOARD_INSTALL_RATE_MAX,
  30,
);
const RATE_WINDOW_MS = parsePositiveInt(
  process.env.DASHBOARD_INSTALL_RATE_WINDOW_MS,
  60 * 1000,
);
const RATE_MAX_ENTRIES = 10_000;

// Sliding window of call timestamps (ms) per key.
const callStore = new Map<string, number[]>();

export type RateLimitResult =
  | { limited: false }
  | { limited: true; retryAfterSec: number };

/**
 * Record a call against `key` and report whether it should be rejected.
 *
 * Returns `{ limited: false }` when the call is within budget (the call IS
 * counted), or `{ limited: true, retryAfterSec }` when the window is already
 * saturated (the call is NOT counted — a rejected call must not extend the
 * lockout, or a caller hammering a saturated bucket would never recover).
 *
 * `now` is injectable for deterministic tests.
 */
export function checkRateLimit(
  key: string,
  now: number = Date.now(),
): RateLimitResult {
  const cutoff = now - RATE_WINDOW_MS;
  let calls = callStore.get(key);
  if (calls) {
    calls = calls.filter((t) => t > cutoff);
  } else {
    if (callStore.size >= RATE_MAX_ENTRIES) {
      const oldest = callStore.keys().next().value;
      if (oldest !== undefined) callStore.delete(oldest);
    }
    calls = [];
  }

  if (calls.length >= MAX_CALLS) {
    // Saturated. Persist the pruned list so the entry doesn't grow, but do
    // NOT add this call. retryAfterSec = time until the oldest in-window
    // call ages out, freeing one slot.
    callStore.set(key, calls);
    const oldest = calls[0] ?? now;
    const freesAt = oldest + RATE_WINDOW_MS;
    const retryAfterSec = Math.max(1, Math.ceil((freesAt - now) / 1000));
    return { limited: true, retryAfterSec };
  }

  calls.push(now);
  callStore.set(key, calls);
  return { limited: false };
}

export function _resetRateLimitForTests(): void {
  callStore.clear();
}

export const _rateLimitConfig = {
  MAX_CALLS,
  WINDOW_MS: RATE_WINDOW_MS,
  MAX_ENTRIES: RATE_MAX_ENTRIES,
};
