/**
 * Pure token-bucket math for per-session tool rate limiting.
 * No side effects, no Date.now() — caller injects `now`.
 */

export interface TokenBucketState {
  readonly tokens: number;
  readonly lastRefill: number;
}

/**
 * Refill the bucket based on elapsed time and return a new state.
 * Does NOT mutate the input state.
 *
 * @param state   Current bucket state.
 * @param now     Current timestamp (ms) — injected by caller.
 * @param limit   Max tokens (tokens/minute).
 * @param windowMs Refill window in ms (default 60_000 = 1 minute).
 */
export function refillBucket(
  state: TokenBucketState,
  now: number,
  limit: number,
  windowMs = 60_000,
): TokenBucketState {
  const elapsed = now - state.lastRefill;
  const refill = (elapsed / windowMs) * limit;
  return {
    tokens: Math.min(limit, state.tokens + refill),
    lastRefill: now,
  };
}

/**
 * Attempt to consume one token from the bucket.
 * Returns the allowed flag and the next state (mutated copy).
 * Does NOT mutate the input state.
 */
export function consumeToken(state: TokenBucketState): {
  allowed: boolean;
  nextState: TokenBucketState;
} {
  if (state.tokens < 1) {
    return { allowed: false, nextState: state };
  }
  return {
    allowed: true,
    nextState: { tokens: state.tokens - 1, lastRefill: state.lastRefill },
  };
}
