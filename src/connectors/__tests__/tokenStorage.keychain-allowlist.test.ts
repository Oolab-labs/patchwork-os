/**
 * Code-scanning alert #135 (js/command-line-injection, CWE-78/88).
 *
 * Keychain keys derive from connector/provider names (user-influenced) and
 * reach the macOS keychain through `security` and a `/bin/sh -c` wrapper. Even
 * though the key is only a positional `$1` (never interpolated into the command
 * string), it must be constrained to a strict allowlist before crossing any
 * spawn boundary. `isValidKeychainKey` is that gate.
 */

import { describe, expect, it } from "vitest";
import { isValidKeychainKey } from "../tokenStorage.js";

describe("isValidKeychainKey (code-scanning #135)", () => {
  it("accepts the normal patchwork-os.<provider> shape", () => {
    expect(isValidKeychainKey("patchwork-os.github")).toBe(true);
    expect(isValidKeychainKey("patchwork-os.google_calendar")).toBe(true);
    expect(isValidKeychainKey("patchwork-os.user@example.com")).toBe(true);
    expect(isValidKeychainKey("patchwork-os.conn:123")).toBe(true);
  });

  it("rejects shell metacharacters and injection payloads", () => {
    for (const bad of [
      "patchwork-os.foo; rm -rf .",
      "patchwork-os.$(whoami)",
      "patchwork-os.`id`",
      "patchwork-os.a b",
      'patchwork-os.a"b',
      "patchwork-os.a'b",
      "patchwork-os.a|b",
      "patchwork-os.a&b",
      "patchwork-os.a\nb",
      "patchwork-os.a$IFS",
      "patchwork-os.a/../b",
    ]) {
      expect(isValidKeychainKey(bad), bad).toBe(false);
    }
  });

  it("rejects empty and over-long keys", () => {
    expect(isValidKeychainKey("")).toBe(false);
    expect(isValidKeychainKey("a".repeat(257))).toBe(false);
  });
});
