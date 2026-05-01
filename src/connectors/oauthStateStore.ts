/**
 * Shared OAuth `state` parameter store for connector authorize→callback flows.
 *
 * Each connector previously kept its own module-scope `Set<string>` keyed by
 * a `setTimeout` cleanup. That works correctness-wise but is unbounded — a
 * loop of `/authorize` calls (10k requests in 10 min) would accumulate 10k
 * states + 10k pending timers, ~640 KB of heap that disappears 10 min later.
 * On a busy multi-tenant relay this becomes a memory amplification vector
 * any unauthenticated caller can drive.
 *
 * Defenses:
 *   - Hard cap (default 1000 entries) — when full, new `add()` calls return
 *     false and the caller surfaces an HTTP 429 / generic error.
 *   - TTL eviction at access time (consume() or add()) — no per-state timer,
 *     so 10k states cost 10k Map slots + 10k longs, nothing more.
 *   - `consume()` is single-use; second call with the same state returns false.
 */

export interface OAuthStateStore {
  /** Returns false if the cap is hit. */
  add(state: string): boolean;
  /** Consume on callback. Returns true if the state was valid and unconsumed. */
  consume(state: string): boolean;
  /** For tests. */
  size(): number;
}

interface Options {
  ttlMs?: number;
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 1000;

export function createOAuthStateStore(opts: Options = {}): OAuthStateStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const states = new Map<string, number>(); // state → expiresAt ms

  function pruneExpired(now: number): void {
    for (const [s, expiry] of states) {
      if (expiry < now) states.delete(s);
    }
  }

  return {
    add(state: string): boolean {
      const now = Date.now();
      pruneExpired(now);
      if (states.size >= maxEntries) return false;
      states.set(state, now + ttlMs);
      return true;
    },
    consume(state: string): boolean {
      const now = Date.now();
      const expiry = states.get(state);
      if (expiry === undefined) return false;
      states.delete(state);
      return expiry >= now;
    },
    size(): number {
      return states.size;
    },
  };
}
