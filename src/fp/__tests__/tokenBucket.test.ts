import { describe, expect, it } from "vitest";
import type { TokenBucketState } from "../tokenBucket.js";
import { consumeToken, refillBucket } from "../tokenBucket.js";

describe("refillBucket", () => {
  it("does not exceed limit", () => {
    const state: TokenBucketState = { tokens: 60, lastRefill: 0 };
    const next = refillBucket(state, 120_000, 60);
    expect(next.tokens).toBe(60);
  });

  it("adds tokens proportional to elapsed time", () => {
    const state: TokenBucketState = { tokens: 0, lastRefill: 0 };
    // 30s elapsed at 60/min = +30 tokens
    const next = refillBucket(state, 30_000, 60);
    expect(next.tokens).toBeCloseTo(30);
  });

  it("does not mutate input state", () => {
    const state: TokenBucketState = { tokens: 10, lastRefill: 0 };
    refillBucket(state, 60_000, 60);
    expect(state.tokens).toBe(10);
    expect(state.lastRefill).toBe(0);
  });

  it("updates lastRefill to now", () => {
    const state: TokenBucketState = { tokens: 0, lastRefill: 0 };
    const next = refillBucket(state, 5000, 60);
    expect(next.lastRefill).toBe(5000);
  });

  it("respects custom windowMs", () => {
    const state: TokenBucketState = { tokens: 0, lastRefill: 0 };
    // 10s elapsed at 60 tokens per 10s window = +60 tokens
    const next = refillBucket(state, 10_000, 60, 10_000);
    expect(next.tokens).toBeCloseTo(60);
  });

  it("no elapsed time → no new tokens", () => {
    const state: TokenBucketState = { tokens: 5, lastRefill: 1000 };
    const next = refillBucket(state, 1000, 60);
    expect(next.tokens).toBeCloseTo(5);
  });
});

describe("consumeToken", () => {
  it("allows when tokens >= 1 and decrements", () => {
    const state: TokenBucketState = { tokens: 5, lastRefill: 0 };
    const { allowed, nextState } = consumeToken(state);
    expect(allowed).toBe(true);
    expect(nextState.tokens).toBeCloseTo(4);
  });

  it("denies when tokens < 1", () => {
    const state: TokenBucketState = { tokens: 0.5, lastRefill: 0 };
    const { allowed, nextState } = consumeToken(state);
    expect(allowed).toBe(false);
    expect(nextState).toBe(state); // same reference — not consumed
  });

  it("does not mutate input state", () => {
    const state: TokenBucketState = { tokens: 10, lastRefill: 0 };
    consumeToken(state);
    expect(state.tokens).toBe(10);
  });

  it("preserves lastRefill", () => {
    const state: TokenBucketState = { tokens: 5, lastRefill: 12345 };
    const { nextState } = consumeToken(state);
    expect(nextState.lastRefill).toBe(12345);
  });

  it("bucket empties after N consecutive consumes", () => {
    let state: TokenBucketState = { tokens: 3, lastRefill: 0 };
    for (let i = 0; i < 3; i++) {
      const res = consumeToken(state);
      expect(res.allowed).toBe(true);
      state = res.nextState;
    }
    const last = consumeToken(state);
    expect(last.allowed).toBe(false);
  });
});
