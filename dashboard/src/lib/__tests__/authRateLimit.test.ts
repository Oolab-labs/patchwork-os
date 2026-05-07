/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let mod: typeof import("../authRateLimit");

beforeEach(async () => {
  // authRateLimit captures env-var thresholds at module load. The store is
  // module-singleton; reset between tests instead of re-importing.
  mod = await import("../authRateLimit");
  mod._resetForTests();
});

afterEach(() => {
  mod._resetForTests();
});

describe("authRateLimit", () => {
  it("returns not-locked for an unknown key", () => {
    expect(mod.checkLocked("1.2.3.4")).toEqual({ locked: false });
  });

  it("does not lock until MAX_FAILURES is reached", () => {
    const ip = "1.2.3.4";
    const now = 1_000_000;
    for (let i = 0; i < mod._config.MAX_FAILURES - 1; i++) {
      const r = mod.recordFailure(ip, now + i);
      expect(r.locked).toBe(false);
    }
    expect(mod.checkLocked(ip, now + 100)).toEqual({ locked: false });
  });

  it("locks on the MAX_FAILURES-th failure within the window", () => {
    const ip = "1.2.3.4";
    const now = 1_000_000;
    let result: ReturnType<typeof mod.recordFailure> = { locked: false };
    for (let i = 0; i < mod._config.MAX_FAILURES; i++) {
      result = mod.recordFailure(ip, now + i);
    }
    expect(result.locked).toBe(true);
    if (result.locked) {
      // ceil(LOCKOUT_MS / 1000) — for default 15min, 900s.
      expect(result.retryAfterSec).toBe(
        Math.ceil(mod._config.LOCKOUT_MS / 1000),
      );
    }

    const lock = mod.checkLocked(ip, now + 100);
    expect(lock.locked).toBe(true);
    if (lock.locked) {
      expect(lock.retryAfterSec).toBeGreaterThan(0);
      expect(lock.retryAfterSec).toBeLessThanOrEqual(
        Math.ceil(mod._config.LOCKOUT_MS / 1000),
      );
    }
  });

  it("checkLocked returns not-locked once the lockout has expired", () => {
    const ip = "1.2.3.4";
    const lockAt = 1_000_000;
    // Record all failures at the same instant so lockedUntil = lockAt + LOCKOUT_MS.
    for (let i = 0; i < mod._config.MAX_FAILURES; i++) {
      mod.recordFailure(ip, lockAt);
    }
    expect(
      mod.checkLocked(ip, lockAt + mod._config.LOCKOUT_MS - 1).locked,
    ).toBe(true);
    expect(
      mod.checkLocked(ip, lockAt + mod._config.LOCKOUT_MS + 1).locked,
    ).toBe(false);
  });

  it("starts a fresh window after a previous lockout expires", () => {
    const ip = "1.2.3.4";
    const t0 = 1_000_000;
    for (let i = 0; i < mod._config.MAX_FAILURES; i++) {
      mod.recordFailure(ip, t0 + i);
    }
    // Lockout expired; one fresh failure should NOT immediately re-lock.
    const after = t0 + mod._config.LOCKOUT_MS + 1;
    const r = mod.recordFailure(ip, after);
    expect(r.locked).toBe(false);
  });

  it("prunes failures older than the sliding window", () => {
    const ip = "1.2.3.4";
    const t0 = 1_000_000;
    // MAX_FAILURES - 1 failures, then wait past the window, then one more.
    for (let i = 0; i < mod._config.MAX_FAILURES - 1; i++) {
      mod.recordFailure(ip, t0 + i);
    }
    const lateBy1ms = t0 + mod._config.FAILURE_WINDOW_MS + 1;
    // One failure outside the original window. Old failures should drop off.
    const r = mod.recordFailure(ip, lateBy1ms);
    expect(r.locked).toBe(false);
  });

  it("recordSuccess clears the entry", () => {
    const ip = "1.2.3.4";
    const now = 1_000_000;
    mod.recordFailure(ip, now);
    mod.recordFailure(ip, now + 1);
    mod.recordSuccess(ip);
    // After clearing, the IP is back to a clean slate.
    expect(mod.checkLocked(ip, now + 2).locked).toBe(false);
    // And the failure counter has reset — would need MAX more to re-lock.
    let result: ReturnType<typeof mod.recordFailure> = { locked: false };
    for (let i = 0; i < mod._config.MAX_FAILURES - 1; i++) {
      result = mod.recordFailure(ip, now + 10 + i);
    }
    expect(result.locked).toBe(false);
  });

  it("tracks IPs independently — locking one does not lock another", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < mod._config.MAX_FAILURES; i++) {
      mod.recordFailure("attacker", t0 + i);
    }
    expect(mod.checkLocked("attacker", t0 + 1).locked).toBe(true);
    expect(mod.checkLocked("legit", t0 + 1).locked).toBe(false);
    // Legit user can still authenticate.
    const r = mod.recordFailure("legit", t0 + 100);
    expect(r.locked).toBe(false);
  });

  it("evicts the oldest entry when MAX_ENTRIES is exceeded", () => {
    const t0 = 1_000_000;
    // First IP gets some failures.
    mod.recordFailure("first", t0);
    // Fill up to capacity with distinct IPs.
    for (let i = 0; i < mod._config.MAX_ENTRIES; i++) {
      mod.recordFailure(`ip-${i}`, t0 + i + 1);
    }
    // "first" should be evicted now.
    expect(mod.checkLocked("first", t0 + 1).locked).toBe(false);
  });
});
