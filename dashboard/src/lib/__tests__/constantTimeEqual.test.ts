import { describe, expect, it } from "vitest";
import { constantTimeEqual, verifyBearerToken } from "@/lib/constantTimeEqual";

describe("constantTimeEqual", () => {
  it("true for identical short strings", () => {
    expect(constantTimeEqual("hunter2", "hunter2")).toBe(true);
  });

  it("false for different strings", () => {
    expect(constantTimeEqual("hunter2", "hunter3")).toBe(false);
  });

  it("false for different-length strings (no prefix match)", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("abcd", "abc")).toBe(false);
  });

  it("false when expected is empty (fail-closed)", () => {
    expect(constantTimeEqual("", "")).toBe(false);
    expect(constantTimeEqual("anything", "")).toBe(false);
  });

  // audit 2026-06-08 dash-api-1 — the regression this helper exists for.
  it("false for two distinct >256-byte tokens of equal length (no all-zeros collision)", () => {
    expect(constantTimeEqual("A".repeat(300), "B".repeat(300))).toBe(false);
  });

  it("true for identical >256-byte tokens (over-pad inputs still compare up to CAP)", () => {
    const t = `tok-${"x".repeat(300)}`;
    expect(constantTimeEqual(t, t)).toBe(true);
  });

  it("rejects inputs longer than CAP even if they share the first CAP bytes", () => {
    const cap = 8;
    // both share first 8 bytes but exceed cap → length guard rejects
    expect(constantTimeEqual("AAAAAAAA9", "AAAAAAAA9", cap)).toBe(false);
  });

  it("differs only past CAP → still false (compare is bounded, length guard catches it)", () => {
    const cap = 8;
    expect(constantTimeEqual("AAAAAAAA1", "AAAAAAAA2", cap)).toBe(false);
  });
});

describe("verifyBearerToken", () => {
  const mkReq = (auth?: string): Request =>
    new Request("http://x/relay", {
      headers: auth ? { authorization: auth } : {},
    });

  it("true for matching Bearer token", () => {
    expect(verifyBearerToken(mkReq("Bearer secret-123"), "secret-123")).toBe(
      true,
    );
  });

  it("false for wrong token", () => {
    expect(verifyBearerToken(mkReq("Bearer nope"), "secret-123")).toBe(false);
  });

  it("false when expected secret is empty (fail-closed)", () => {
    expect(verifyBearerToken(mkReq("Bearer anything"), "")).toBe(false);
  });

  it("false when header missing", () => {
    expect(verifyBearerToken(mkReq(), "secret-123")).toBe(false);
  });

  it("false when scheme is not Bearer", () => {
    expect(verifyBearerToken(mkReq("Basic secret-123"), "secret-123")).toBe(
      false,
    );
  });

  it("false for wrong >256-byte token of equal length (bypass regression)", () => {
    expect(
      verifyBearerToken(mkReq(`Bearer ${"B".repeat(300)}`), "A".repeat(300)),
    ).toBe(false);
  });
});
