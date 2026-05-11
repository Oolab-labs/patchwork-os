/**
 * Tests for `isEnvLockedFor()` + `getEnvLockedValue()` — the helpers the
 * `/kill-switch` endpoint and dashboard toggle will use to detect when a
 * kill-switch flag has been frozen by `lockKillSwitchEnv()`.
 *
 * Context: issue #422 v2 review caught a UX bug in the naive predicate
 * (`envLocked && frozen !== undefined` would correctly detect both
 * locked-to-on and locked-to-off, but the tooltip needs to know WHICH
 * direction so it can render "env-locked to ON" vs "env-locked to OFF").
 *
 * Surfaces tested:
 *   - isEnvLockedFor(flag) returns true only after lockKillSwitchEnv()
 *     captured a non-undefined value for that kill-switch flag.
 *   - getEnvLockedValue(flag) surfaces the frozen direction (true/false/null).
 *   - Both helpers return safe defaults for unknown flags, non-kill-switch
 *     flags, and pre-lock state.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetEnvLockForTesting,
  getEnvLockedValue,
  isEnvLockedFor,
  KILL_SWITCH_WRITES,
  lockKillSwitchEnv,
} from "../featureFlags.js";

const KILL_SWITCH_ENV = "PATCHWORK_FLAG_KILL_SWITCH_WRITES";

beforeEach(() => {
  delete process.env[KILL_SWITCH_ENV];
  _resetEnvLockForTesting();
});

afterEach(() => {
  delete process.env[KILL_SWITCH_ENV];
  _resetEnvLockForTesting();
});

describe("isEnvLockedFor()", () => {
  it("returns false before lockKillSwitchEnv() is called", () => {
    process.env[KILL_SWITCH_ENV] = "1";
    expect(isEnvLockedFor(KILL_SWITCH_WRITES)).toBe(false);
  });

  it("returns false after lock when env was unset", () => {
    delete process.env[KILL_SWITCH_ENV];
    lockKillSwitchEnv();
    expect(isEnvLockedFor(KILL_SWITCH_WRITES)).toBe(false);
  });

  it("returns true after lock when env was set to 1 (locked to ON)", () => {
    process.env[KILL_SWITCH_ENV] = "1";
    lockKillSwitchEnv();
    expect(isEnvLockedFor(KILL_SWITCH_WRITES)).toBe(true);
  });

  it("returns true after lock when env was set to 0 (locked to OFF)", () => {
    // I2 from the #422 v2 review: BOTH directions are policy-locked.
    // The CLI/dashboard must surface the locked state in either case so
    // setFlag returns 409 Conflict instead of silently no-op'ing.
    process.env[KILL_SWITCH_ENV] = "0";
    lockKillSwitchEnv();
    expect(isEnvLockedFor(KILL_SWITCH_WRITES)).toBe(true);
  });

  it("returns true after lock when env was set to true (case-insensitive)", () => {
    process.env[KILL_SWITCH_ENV] = "TRUE";
    lockKillSwitchEnv();
    expect(isEnvLockedFor(KILL_SWITCH_WRITES)).toBe(true);
  });

  it("returns true after lock when env was set to false (case-insensitive)", () => {
    process.env[KILL_SWITCH_ENV] = "False";
    lockKillSwitchEnv();
    expect(isEnvLockedFor(KILL_SWITCH_WRITES)).toBe(true);
  });

  it("returns false for unknown flag ids", () => {
    process.env[KILL_SWITCH_ENV] = "1";
    lockKillSwitchEnv();
    expect(isEnvLockedFor("not-a-real-flag")).toBe(false);
  });

  it("post-mutation of process.env does not change the result", () => {
    process.env[KILL_SWITCH_ENV] = "1";
    lockKillSwitchEnv();
    expect(isEnvLockedFor(KILL_SWITCH_WRITES)).toBe(true);
    // Mutating env after lock — locked state is sticky.
    delete process.env[KILL_SWITCH_ENV];
    expect(isEnvLockedFor(KILL_SWITCH_WRITES)).toBe(true);
  });
});

describe("getEnvLockedValue()", () => {
  it("returns null before lockKillSwitchEnv() is called", () => {
    process.env[KILL_SWITCH_ENV] = "1";
    expect(getEnvLockedValue(KILL_SWITCH_WRITES)).toBeNull();
  });

  it("returns null after lock when env was unset", () => {
    delete process.env[KILL_SWITCH_ENV];
    lockKillSwitchEnv();
    expect(getEnvLockedValue(KILL_SWITCH_WRITES)).toBeNull();
  });

  it("returns true when env-locked to ON", () => {
    process.env[KILL_SWITCH_ENV] = "1";
    lockKillSwitchEnv();
    expect(getEnvLockedValue(KILL_SWITCH_WRITES)).toBe(true);
  });

  it("returns false when env-locked to OFF (any non-truthy value)", () => {
    // 0, false, "", anything-not-truthy → false per lockKillSwitchEnv's
    // existing semantics. The dashboard tooltip reads this to render
    // "env-locked to OFF" vs "env-locked to ON".
    process.env[KILL_SWITCH_ENV] = "0";
    lockKillSwitchEnv();
    expect(getEnvLockedValue(KILL_SWITCH_WRITES)).toBe(false);
  });

  it("returns null for unknown flag ids", () => {
    process.env[KILL_SWITCH_ENV] = "1";
    lockKillSwitchEnv();
    expect(getEnvLockedValue("not-a-real-flag")).toBeNull();
  });
});
