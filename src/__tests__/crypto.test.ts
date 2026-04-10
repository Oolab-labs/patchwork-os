import { describe, expect, it } from "vitest";
import { timingSafeStringEqual } from "../crypto.js";

describe("timingSafeStringEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeStringEqual("hello", "hello")).toBe(true);
  });

  it("returns false for strings with the same length but different content", () => {
    expect(timingSafeStringEqual("hello", "world")).toBe(false);
  });

  it("returns false for strings with different lengths", () => {
    expect(timingSafeStringEqual("short", "longer")).toBe(false);
    expect(timingSafeStringEqual("longer", "short")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(timingSafeStringEqual("", "")).toBe(true);
  });

  it("returns false when one string is empty and the other is not", () => {
    expect(timingSafeStringEqual("", "a")).toBe(false);
    expect(timingSafeStringEqual("a", "")).toBe(false);
  });

  it("returns true for strings with special characters", () => {
    const token = "abc!@#$%^&*()_+-=[]{}|;':\",./<>?";
    expect(timingSafeStringEqual(token, token)).toBe(true);
  });

  it("returns false for strings that differ only in special characters", () => {
    expect(timingSafeStringEqual("token!abc", "token@abc")).toBe(false);
  });

  it("returns true for multi-byte unicode strings", () => {
    expect(timingSafeStringEqual("héllo", "héllo")).toBe(true);
  });

  it("returns false for strings that differ only by a multi-byte character", () => {
    expect(timingSafeStringEqual("héllo", "hello")).toBe(false);
  });

  it("returns false for strings that are prefix/suffix of each other", () => {
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
    expect(timingSafeStringEqual("abcd", "abc")).toBe(false);
  });

  it("returns true for long token-like strings (typical auth token)", () => {
    const token = "a".repeat(64);
    expect(timingSafeStringEqual(token, token)).toBe(true);
  });

  it("returns false for long strings that differ in the last byte", () => {
    const base = "a".repeat(63);
    expect(timingSafeStringEqual(`${base}x`, `${base}y`)).toBe(false);
  });

  it("both length and byte checks always execute — prevents short-circuit timing leak", () => {
    // A correct constant-time implementation must return false both when bytes
    // differ and when lengths differ. This test verifies the semantics without
    // being able to directly observe timing, but it confirms the result is
    // consistent (no false positives) even for the tricky edge case where byte
    // buffers compare equal because the shorter string's padding matches.
    // e.g. "a\0" vs "a" — padded bytes are the same but lengths differ.
    expect(timingSafeStringEqual("a\0", "a")).toBe(false);
    expect(timingSafeStringEqual("a", "a\0")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(timingSafeStringEqual("Token", "token")).toBe(false);
    expect(timingSafeStringEqual("TOKEN", "token")).toBe(false);
  });

  it("handles null bytes in strings correctly", () => {
    expect(timingSafeStringEqual("\0", "\0")).toBe(true);
    expect(timingSafeStringEqual("\0\0", "\0")).toBe(false);
  });
});
