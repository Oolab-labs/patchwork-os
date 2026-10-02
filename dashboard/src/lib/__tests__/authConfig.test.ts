/** @vitest-environment node */
/**
 * The dashboard accepted ANY non-empty DASHBOARD_SESSION_SECRET and
 * DASHBOARD_PASSWORD — including the placeholders `.env.example` ships. A
 * copied example file therefore produced a publicly known HMAC key, and
 * anyone could mint session cookies (security sweep 2026-10-01, L7).
 * `patchwork init` writes strong values; the risk is the manual path.
 *
 * Password: only the shipped placeholder is refused — a hand-set password
 * may legitimately be short, and refusing it would lock out a working
 * install. Secret: the placeholder AND anything shorter than 32 characters,
 * because it is a key, not something a person types.
 */
import { describe, expect, it } from "vitest";
import { MIN_SESSION_SECRET_LENGTH, weakAuthConfig } from "../authConfig";

const STRONG = "x".repeat(64);

describe("weakAuthConfig", () => {
  it("accepts a strong secret and an ordinary password", () => {
    expect(weakAuthConfig("correct horse", STRONG)).toBeNull();
    expect(weakAuthConfig("short", STRONG)).toBeNull();
  });

  it("refuses the .env.example password placeholder", () => {
    expect(weakAuthConfig("changeme", STRONG)).toMatch(/DASHBOARD_PASSWORD/);
  });

  it("refuses the .env.example secret placeholder (even though it is long enough)", () => {
    const r = weakAuthConfig("pw", "replace-with-32-byte-random-secret");
    expect(r).toMatch(/DASHBOARD_SESSION_SECRET/);
  });

  it(`refuses a secret shorter than ${MIN_SESSION_SECRET_LENGTH} characters, and accepts exactly the minimum`, () => {
    expect(
      weakAuthConfig("pw", "s".repeat(MIN_SESSION_SECRET_LENGTH - 1)),
    ).toMatch(/DASHBOARD_SESSION_SECRET/);
    expect(
      weakAuthConfig("pw", "s".repeat(MIN_SESSION_SECRET_LENGTH)),
    ).toBeNull();
  });

  it("never echoes the secret or password value in its message", () => {
    const secret = "short-secret-value";
    const r = weakAuthConfig("changeme", secret) ?? "";
    expect(r).not.toContain(secret);
    expect(r).not.toContain("changeme");
  });

  it("matches the placeholders actually shipped in dashboard/.env.example", async () => {
    // Guards against the example file changing and this list going stale.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const example = readFileSync(
      path.resolve(__dirname, "..", "..", "..", ".env.example"),
      "utf8",
    );
    const pw = /^DASHBOARD_PASSWORD=(.*)$/m.exec(example)?.[1] ?? "";
    const secret = /^DASHBOARD_SESSION_SECRET=(.*)$/m.exec(example)?.[1] ?? "";
    expect(pw).not.toBe("");
    expect(secret).not.toBe("");
    expect(weakAuthConfig(pw, STRONG)).not.toBeNull();
    expect(weakAuthConfig("pw", secret)).not.toBeNull();
  });
});
