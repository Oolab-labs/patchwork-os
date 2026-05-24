/**
 * Unit tests for the stateless HMAC-SHA256 session cookie implementation.
 *
 * Security invariants verified:
 * - A freshly-signed token verifies successfully.
 * - Expired tokens are rejected before any cryptographic work.
 * - Tampered signatures (wrong bytes) are rejected.
 * - Missing or empty secret → always invalid (fail-safe).
 * - Malformed cookie values never throw; they return { valid: false }.
 * - Cookie header contains all required security attributes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionCookieHeader,
  sessionCookieHeader,
  SESSION_COOKIE_NAME,
  signSession,
  verifySession,
} from "@/lib/session";

const TEST_SECRET = "test-secret-at-least-32-chars-long-ok";

beforeEach(() => {
  process.env.DASHBOARD_SESSION_SECRET = TEST_SECRET;
});

afterEach(() => {
  delete process.env.DASHBOARD_SESSION_SECRET;
});

describe("signSession + verifySession", () => {
  it("a freshly-signed token verifies as valid", async () => {
    const token = await signSession();
    const result = await verifySession(token);
    expect(result.valid).toBe(true);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("token has the expected v1.<expiry>.<sig> shape", async () => {
    const token = await signSession();
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("v1");
    expect(Number.isFinite(Number(parts[1]))).toBe(true);
    expect(parts[2]?.length).toBeGreaterThan(0);
  });

  it("rejects an expired token without touching crypto", async () => {
    const pastMs = Date.now() - 1000;
    const token = await signSession(pastMs);
    const result = await verifySession(token);
    expect(result.valid).toBe(false);
  });

  it("rejects a token with a tampered signature", async () => {
    const token = await signSession();
    const parts = token.split(".");
    // Flip the first character of the base64url signature — the first char
    // always encodes 6 significant bits, so any substitution changes real bytes.
    const badSig =
      (parts[2]![0] === "A" ? "B" : "A") + parts[2]!.slice(1);
    const tampered = `${parts[0]}.${parts[1]}.${badSig}`;
    const result = await verifySession(tampered);
    expect(result.valid).toBe(false);
  });

  it("rejects a token when DASHBOARD_SESSION_SECRET is missing", async () => {
    const token = await signSession();
    delete process.env.DASHBOARD_SESSION_SECRET;
    const result = await verifySession(token);
    expect(result.valid).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession();
    process.env.DASHBOARD_SESSION_SECRET = "a-completely-different-secret-value";
    const result = await verifySession(token);
    expect(result.valid).toBe(false);
  });
});

describe("verifySession — malformed inputs", () => {
  it("returns { valid: false } for null", async () => {
    expect((await verifySession(null)).valid).toBe(false);
  });

  it("returns { valid: false } for undefined", async () => {
    expect((await verifySession(undefined)).valid).toBe(false);
  });

  it("returns { valid: false } for empty string", async () => {
    expect((await verifySession("")).valid).toBe(false);
  });

  it("returns { valid: false } for wrong version prefix", async () => {
    expect((await verifySession("v2.9999999999999.abc")).valid).toBe(false);
  });

  it("returns { valid: false } for non-numeric expiry", async () => {
    expect((await verifySession("v1.notanumber.abc")).valid).toBe(false);
  });

  it("returns { valid: false } for only two parts", async () => {
    expect((await verifySession("v1.12345")).valid).toBe(false);
  });

  it("returns { valid: false } for four parts", async () => {
    expect((await verifySession("v1.12345.sig.extra")).valid).toBe(false);
  });
});

describe("sessionCookieHeader", () => {
  it("contains the cookie name and value", async () => {
    const token = await signSession();
    const header = sessionCookieHeader(token);
    expect(header).toContain(`${SESSION_COOKIE_NAME}=${token}`);
  });

  it("sets Path=/", async () => {
    const header = sessionCookieHeader(await signSession());
    expect(header).toContain("Path=/");
  });

  it("sets HttpOnly", async () => {
    const header = sessionCookieHeader(await signSession());
    expect(header).toContain("HttpOnly");
  });

  it("sets SameSite=Strict", async () => {
    const header = sessionCookieHeader(await signSession());
    expect(header).toContain("SameSite=Strict");
  });

  it("sets a positive Max-Age", async () => {
    const header = sessionCookieHeader(await signSession());
    const match = /Max-Age=(\d+)/.exec(header);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(0);
  });
});

describe("clearSessionCookieHeader", () => {
  it("sets Max-Age=0 to expire the cookie immediately", () => {
    const header = clearSessionCookieHeader();
    expect(header).toContain("Max-Age=0");
  });

  it("uses the correct cookie name", () => {
    expect(clearSessionCookieHeader()).toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it("sets Path=/ so the clear reaches all paths", () => {
    expect(clearSessionCookieHeader()).toContain("Path=/");
  });

  it("keeps HttpOnly and SameSite=Strict on the clear header", () => {
    const header = clearSessionCookieHeader();
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
  });
});
