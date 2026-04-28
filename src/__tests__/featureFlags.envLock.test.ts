/**
 * Tests for the kill-switch env-lock fix (MED-2 from the 2026-04-28 audit).
 *
 * The kill switch was readable from `process.env` on every `isEnabled` call,
 * letting any code running in the bridge process — including a malicious
 * plugin or recipe step — flip
 *   process.env.PATCHWORK_FLAG_KILL_SWITCH_WRITES = "0"
 * to disable an active emergency stop.
 *
 * After the fix, the bridge calls `lockKillSwitchEnv()` at start. From that
 * point on, `process.env` mutations for kill-switch flags are ignored —
 * value is read from the snapshot taken at lock time.
 *
 * Tests use `_resetEnvLockForTesting()` to keep the existing dynamic-read
 * test ergonomics intact for non-locked code paths.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetEnvLockForTesting,
  isEnabled,
  KILL_SWITCH_WRITES,
  lockKillSwitchEnv,
  setFlag,
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

describe("MED-2: kill-switch env lock", () => {
  it("without lock, env mutation flips kill switch dynamically (legacy behaviour)", () => {
    expect(isEnabled(KILL_SWITCH_WRITES)).toBe(false);
    process.env[KILL_SWITCH_ENV] = "1";
    expect(isEnabled(KILL_SWITCH_WRITES)).toBe(true);
    process.env[KILL_SWITCH_ENV] = "0";
    expect(isEnabled(KILL_SWITCH_WRITES)).toBe(false);
  });

  it("after lock, the kill switch state is frozen at lock time", () => {
    process.env[KILL_SWITCH_ENV] = "1";
    lockKillSwitchEnv();

    expect(isEnabled(KILL_SWITCH_WRITES)).toBe(true);

    // attacker mutation attempt — ignored
    process.env[KILL_SWITCH_ENV] = "0";
    expect(isEnabled(KILL_SWITCH_WRITES)).toBe(true);

    delete process.env[KILL_SWITCH_ENV];
    expect(isEnabled(KILL_SWITCH_WRITES)).toBe(true);
  });

  it("after lock, env mutation cannot flip kill switch from off → on either", () => {
    lockKillSwitchEnv();
    expect(isEnabled(KILL_SWITCH_WRITES)).toBe(false);

    // Plugin mutation: kill switch should stay off (env-locked).
    process.env[KILL_SWITCH_ENV] = "1";
    expect(isEnabled(KILL_SWITCH_WRITES)).toBe(false);
  });

  it("non-kill-switch flags are still dynamic post-lock (test-friendly)", () => {
    lockKillSwitchEnv();
    process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = "true";
    expect(isEnabled("ui.schema-lint")).toBe(true);
    process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = "false";
    expect(isEnabled("ui.schema-lint")).toBe(false);
    delete process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
  });

  it("calling lockKillSwitchEnv twice is idempotent (second call doesn't re-snapshot)", () => {
    process.env[KILL_SWITCH_ENV] = "1";
    lockKillSwitchEnv();
    expect(isEnabled(KILL_SWITCH_WRITES)).toBe(true);
    process.env[KILL_SWITCH_ENV] = "0";
    lockKillSwitchEnv();
    expect(isEnabled(KILL_SWITCH_WRITES)).toBe(true);
  });

  it("setFlag still works post-lock (legitimate dashboard panic-button path)", () => {
    lockKillSwitchEnv();
    expect(isEnabled(KILL_SWITCH_WRITES)).toBe(false);

    // Programmatic toggle (e.g., dashboard panic button) — must still work
    // since it goes through the explicit setFlag API, not env mutation.
    setFlag(KILL_SWITCH_WRITES, true);
    expect(isEnabled(KILL_SWITCH_WRITES)).toBe(true);
  });
});
