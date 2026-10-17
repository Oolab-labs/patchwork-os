/**
 * Obsidian: certificate checks are off ONLY for a loopback base URL
 * (audit M20, 2026-10-15).
 *
 * The Local REST API plugin serves https://127.0.0.1:27124 with a self-signed
 * certificate, so the connector disabled certificate verification. It did so
 * for EVERY base URL, including a remote one an operator typed in — where an
 * unverified TLS connection is just plaintext with extra steps.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tlsVerificationSkippedFor } from "../obsidian.js";

describe("tlsVerificationSkippedFor", () => {
  it.each([
    "https://127.0.0.1:27124",
    "https://localhost:27124",
    "https://[::1]:27124",
  ])("skips verification for the loopback plugin at %s", (url) => {
    expect(tlsVerificationSkippedFor(url)).toBe(true);
  });

  it.each([
    "https://192.168.1.20:27124",
    "https://notes.example.test",
    "https://10.0.0.5:27124",
    "not a url",
  ])("verifies certificates for %s", (url) => {
    expect(tlsVerificationSkippedFor(url)).toBe(false);
  });
});

describe("every Obsidian request picks its agent by base URL", () => {
  it("no request uses the unconditional insecure agent", () => {
    const src = readFileSync(join(__dirname, "..", "obsidian.ts"), "utf8");
    const dispatchers = [...src.matchAll(/dispatcher:\s*([^,\n]+)/g)].map((m) =>
      (m[1] as string).trim(),
    );
    expect(dispatchers.length).toBeGreaterThanOrEqual(11);
    for (const d of dispatchers) expect(d).toMatch(/^agentFor\(/);
  });
});
