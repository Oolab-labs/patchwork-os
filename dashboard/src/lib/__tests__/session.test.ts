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

/**
 * ADR-0020 Phase A — the v2 attributed cookie.
 *
 * The rule these exist for: **a v1 cookie must never read as an attributed
 * v2.** A v1 cookie means nobody was identified. If verification supplied a
 * stand-in subject — the implicit owner, the first member, a literal
 * "unknown" — the absence of a subject would become a CLAIM of one, and every
 * record stamped from it would name a person on no evidence.
 */
describe("v2 attributed sessions", () => {
  it("carries the subject and verifies", async () => {
    const c = await signSession({ memberId: "m-alice" });
    expect(c.startsWith("v2.m-alice.")).toBe(true);
    const r = await verifySession(c);
    expect(r.valid).toBe(true);
    expect(r.memberId).toBe("m-alice");
  });

  it("a v1 cookie is valid but has NO memberId key at all", async () => {
    // Not `memberId: undefined` — absent. A key holding undefined is read as
    // present by an `in` check, and "we have a subject, it is undefined" is
    // exactly the confusion this must not create.
    const c = await signSession();
    expect(c.startsWith("v1.")).toBe(true);
    const r = await verifySession(c);
    expect(r.valid).toBe(true);
    expect(r.memberId).toBeUndefined();
    expect("memberId" in r).toBe(false);
  });

  it("still mints v1 when no member is known (control)", async () => {
    // The dashboard password authenticates a SECRET, not a person. Without
    // this, "always mint v2" would satisfy the assertions above by inventing
    // a placeholder subject.
    const c = await signSession();
    expect(c.split(".")[0]).toBe("v1");
  });

  it("a v1 cookie cannot be re-spelled as a v2 one", async () => {
    // The version is inside the SIGNED payload, so the HMAC over `v1.<exp>`
    // does not verify against `v2.<id>.<exp>`.
    const v1 = await signSession(Date.now() + 60_000);
    const [, exp, sig] = v1.split(".");
    const forged = `v2.m-attacker.${exp}.${sig}`;
    expect((await verifySession(forged)).valid).toBe(false);
  });

  it("one member's cookie cannot be replayed as another's", async () => {
    const a = await signSession({ memberId: "m-alice" });
    const swapped = a.replace("m-alice", "m-mallory");
    expect((await verifySession(swapped)).valid).toBe(false);
  });

  it("refuses to SIGN a member id containing a dot", async () => {
    // The payload is split on "." — an id with one makes `v2.a.b.123.<sig>`
    // ambiguous, so two members could produce cookies that parse as each
    // other. Refused at the only point that can create one.
    await expect(signSession({ memberId: "a.b" })).rejects.toThrow(/ambiguous/);
  });

  it("a dotted id presented in a cookie is rejected — by arity", async () => {
    // Worth being precise about WHY, because it is not the id check doing the
    // work: `v2.a.b.<exp>.<sig>` is five parts, and the arity check rejects
    // it first. Removing the verify-side id regex leaves every test here
    // green — probed. That regex is defence in depth for a future format
    // change, not a live guard, and the comment in session.ts says so.
    const r = await verifySession(`v2.a.b.${Date.now() + 60_000}.sig`);
    expect(r.valid).toBe(false);
  });

  it("rejects wrong-arity cookies for both versions", async () => {
    const exp = Date.now() + 60_000;
    for (const bad of [
      `v1.x.${exp}.sig`, // v1 with a subject slot
      `v2.${exp}.sig`, // v2 without one
      `v3.m.${exp}.sig`,
      "",
    ]) {
      expect((await verifySession(bad)).valid).toBe(false);
    }
  });

  it("an expired v2 cookie is invalid", async () => {
    const c = await signSession({ memberId: "m-alice", expiresAt: Date.now() - 1 });
    expect((await verifySession(c)).valid).toBe(false);
  });

  it("the numeric-argument form still works (back-compat)", async () => {
    const exp = Date.now() + 60_000;
    const c = await signSession(exp);
    const r = await verifySession(c);
    expect(r.valid).toBe(true);
    expect(r.expiresAt).toBe(exp);
    expect(r.memberId).toBeUndefined();
  });
});
