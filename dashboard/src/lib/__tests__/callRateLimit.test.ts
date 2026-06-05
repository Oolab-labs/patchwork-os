/** @vitest-environment node */
/**
 * Unit tests for the generic call-count rate limiter in authRateLimit.ts.
 *
 * Distinct from the login failure-tracker in the same module: this limiter
 * counts ALL calls (not just failures) in a sliding window and is used to
 * cap expensive operations (e.g. the recipe-install proxy, which triggers a
 * GitHub fetch + filesystem write per call). See B3-C security item in
 * docs/marketplace-investigation-2026-06-04.md.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let mod: typeof import("../authRateLimit");

beforeEach(async () => {
  mod = await import("../authRateLimit");
  mod._resetRateLimitForTests();
});

afterEach(() => {
  mod._resetRateLimitForTests();
});

describe("callRateLimit (generic call-count limiter)", () => {
  it("allows calls up to the limit within the window", () => {
    const key = "session-a";
    const now = 1_000_000;
    for (let i = 0; i < mod._rateLimitConfig.MAX_CALLS; i++) {
      const r = mod.checkRateLimit(key, now + i);
      expect(r.limited).toBe(false);
    }
  });

  it("blocks the call that exceeds the limit and reports Retry-After", () => {
    const key = "session-a";
    const now = 1_000_000;
    let last: ReturnType<typeof mod.checkRateLimit> = { limited: false };
    // First MAX_CALLS calls pass; the next one is blocked.
    for (let i = 0; i <= mod._rateLimitConfig.MAX_CALLS; i++) {
      last = mod.checkRateLimit(key, now + i);
    }
    expect(last.limited).toBe(true);
    if (last.limited) {
      expect(last.retryAfterSec).toBeGreaterThan(0);
      expect(last.retryAfterSec).toBeLessThanOrEqual(
        Math.ceil(mod._rateLimitConfig.WINDOW_MS / 1000),
      );
    }
  });

  it("counts each call (not just failures) — repeated successes still trip", () => {
    const key = "session-a";
    const now = 1_000_000;
    let blocked = false;
    for (let i = 0; i < mod._rateLimitConfig.MAX_CALLS + 5; i++) {
      const r = mod.checkRateLimit(key, now + i);
      if (r.limited) blocked = true;
    }
    expect(blocked).toBe(true);
  });

  it("frees up capacity after the sliding window passes", () => {
    const key = "session-a";
    const t0 = 1_000_000;
    // Saturate the window.
    for (let i = 0; i < mod._rateLimitConfig.MAX_CALLS; i++) {
      mod.checkRateLimit(key, t0 + i);
    }
    // One more inside the window is blocked.
    expect(mod.checkRateLimit(key, t0 + mod._rateLimitConfig.MAX_CALLS).limited).toBe(
      true,
    );
    // After the window fully elapses, a fresh call is allowed again.
    const after = t0 + mod._rateLimitConfig.WINDOW_MS + 1;
    expect(mod.checkRateLimit(key, after).limited).toBe(false);
  });

  it("tracks keys independently — one saturated key does not block another", () => {
    const t0 = 1_000_000;
    for (let i = 0; i <= mod._rateLimitConfig.MAX_CALLS; i++) {
      mod.checkRateLimit("noisy", t0 + i);
    }
    expect(mod.checkRateLimit("noisy", t0 + 1).limited).toBe(true);
    // A different key has a clean window.
    expect(mod.checkRateLimit("quiet", t0 + 1).limited).toBe(false);
  });

  it("_resetRateLimitForTests clears all state", () => {
    const key = "session-a";
    const t0 = 1_000_000;
    for (let i = 0; i <= mod._rateLimitConfig.MAX_CALLS; i++) {
      mod.checkRateLimit(key, t0 + i);
    }
    expect(mod.checkRateLimit(key, t0 + 1).limited).toBe(true);
    mod._resetRateLimitForTests();
    expect(mod.checkRateLimit(key, t0 + 1).limited).toBe(false);
  });

  it("evicts the oldest entry when MAX_ENTRIES is exceeded (memory bound)", () => {
    const t0 = 1_000_000;
    mod.checkRateLimit("first", t0);
    for (let i = 0; i < mod._rateLimitConfig.MAX_ENTRIES; i++) {
      mod.checkRateLimit(`k-${i}`, t0 + i + 1);
    }
    // "first" was evicted, so it gets a fresh window (not pre-populated).
    expect(mod.checkRateLimit("first", t0 + 1).limited).toBe(false);
  });
});
