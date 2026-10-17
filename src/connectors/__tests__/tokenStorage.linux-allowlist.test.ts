/**
 * Audit 2026-06-09 pr949-1 — the isValidKeychainKey allowlist guard
 * (code-scanning #135) was added to the macOS keychain sinks in PR #949 but the
 * three Linux secret-tool sinks were left unguarded, leaving the taint path
 * asymmetric across platforms. These tests assert the Linux sinks now reject an
 * invalid key BEFORE spawning `secret-tool`, deterministically on any OS.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Run as Windows on every OS. On win32 the module probes for pwsh with
// spawnSync at IMPORT time, through the mock below. Clearing the mock only
// after each test left that one call on the first test, so it failed on every
// Windows run and passed on retry, hidden by CI's retry: 2.
const realPlatform = vi.hoisted(() => {
  const p = process.platform;
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  return p;
});
afterAll(() => {
  Object.defineProperty(process, "platform", {
    value: realPlatform,
    configurable: true,
  });
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      pid: 1,
      output: [null, Buffer.from(""), Buffer.from("")],
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      status: 0,
      signal: null,
    })),
  };
});

import { spawnSync } from "node:child_process";
import {
  deleteLinuxSecretSync,
  getLinuxSecretSync,
  setLinuxSecretSync,
} from "../tokenStorage.js";

// Before, not after: the import-time pwsh probe must not count against the
// first test.
beforeEach(() => vi.mocked(spawnSync).mockClear());

const BAD_KEYS = [
  "patchwork-os.foo; rm -rf .",
  "patchwork-os.$(whoami)",
  "patchwork-os.a b",
  "patchwork-os.a|b",
  "patchwork-os.a\nb",
  "",
];

describe("Linux secret-tool sinks reject invalid keys before spawning (audit pr949-1)", () => {
  it("setLinuxSecretSync returns false and never spawns secret-tool", () => {
    for (const bad of BAD_KEYS) {
      expect(setLinuxSecretSync(bad, "value"), bad).toBe(false);
    }
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it("getLinuxSecretSync returns null and never spawns secret-tool", () => {
    for (const bad of BAD_KEYS) {
      expect(getLinuxSecretSync(bad), bad).toBeNull();
    }
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it("deleteLinuxSecretSync returns false and never spawns secret-tool", () => {
    for (const bad of BAD_KEYS) {
      expect(deleteLinuxSecretSync(bad), bad).toBe(false);
    }
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it("a valid key IS allowed through to secret-tool", () => {
    setLinuxSecretSync("patchwork-os.github", "value");
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnSync).mock.calls[0]?.[0]).toBe("secret-tool");
  });
});
