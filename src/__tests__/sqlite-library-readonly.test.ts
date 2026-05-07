/**
 * Regression test for CodeQL #119 (js/redos) on the sqlite-library example
 * plugin's read-only verb gate.
 *
 * The original gate used a single regex with overlapping alternatives under a
 * `(?:...)*` quantifier, which backtracks polynomially on adversarial input
 * like `/*` repeated. The replacement is an indexOf-based scanner that is
 * O(n) regardless of input.
 *
 * Tests cover both the adversarial timing case and the legitimate-use cases
 * the gate is supposed to allow / reject.
 */

import { describe, expect, it } from "vitest";

// Dynamic import — plugin lives outside src/, but vitest can resolve it
// relative to repo root.
const { isReadOnlyVerb } = (await import(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "../../examples/plugins/sqlite-library/index.mjs" as any
)) as { isReadOnlyVerb: (s: string) => boolean };

describe("sqlite-library isReadOnlyVerb — adversarial input", () => {
  it("returns in well under 100 ms on the CodeQL ReDoS payload (no match)", () => {
    // The exact shape CodeQL #119 flagged: '/*' followed by many '*//*'
    // with no terminating '*/'. The old regex backtracks through every
    // partition of the run trying to match the trailing verb and hangs
    // (8 s+ on N=60 in CI, exponential past that). The scanner moves
    // strictly forward via indexOf, so the whole pass is O(n).
    const adversarial = "/*" + "*//*".repeat(200);
    const start = Date.now();
    const result = isReadOnlyVerb(adversarial);
    const elapsed = Date.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });

  it("returns in well under 100 ms on a 50_000-char benign comment chain", () => {
    // Same shape but balanced + followed by SELECT — exercises the
    // happy-path scanner cost on a long input.
    const balanced = "/*" + "*//*".repeat(25_000) + "*/ SELECT 1";
    const start = Date.now();
    const result = isReadOnlyVerb(balanced);
    const elapsed = Date.now() - start;
    expect(result).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });

  it("rejects unterminated block comment without scanning past the end", () => {
    const unterminated = "/*" + "x".repeat(10_000);
    expect(isReadOnlyVerb(unterminated)).toBe(false);
  });

  it("rejects unterminated line comment at EOF", () => {
    expect(isReadOnlyVerb("-- never closed")).toBe(false);
  });
});

describe("sqlite-library isReadOnlyVerb — happy path", () => {
  it("accepts plain SELECT", () => {
    expect(isReadOnlyVerb("SELECT 1")).toBe(true);
  });

  it("accepts PRAGMA and EXPLAIN", () => {
    expect(isReadOnlyVerb("PRAGMA table_info(books)")).toBe(true);
    expect(isReadOnlyVerb("EXPLAIN QUERY PLAN SELECT * FROM books")).toBe(true);
  });

  it("accepts case-insensitive verbs", () => {
    expect(isReadOnlyVerb("select 1")).toBe(true);
    expect(isReadOnlyVerb("SeLeCt 1")).toBe(true);
  });

  it("accepts leading whitespace and line comments", () => {
    expect(isReadOnlyVerb("   \n\t  SELECT 1")).toBe(true);
    expect(isReadOnlyVerb("-- catalog read\nSELECT title FROM books")).toBe(
      true,
    );
  });

  it("accepts leading block comments", () => {
    expect(isReadOnlyVerb("/* read-only */ SELECT 1")).toBe(true);
    expect(
      isReadOnlyVerb(
        "/* multi\n * line\n * comment */\n-- and a line comment\nSELECT 1",
      ),
    ).toBe(true);
  });
});

describe("sqlite-library isReadOnlyVerb — rejection", () => {
  it("rejects INSERT / UPDATE / DELETE / DROP", () => {
    expect(isReadOnlyVerb("INSERT INTO books VALUES (1)")).toBe(false);
    expect(isReadOnlyVerb("UPDATE books SET x=1")).toBe(false);
    expect(isReadOnlyVerb("DELETE FROM books")).toBe(false);
    expect(isReadOnlyVerb("DROP TABLE books")).toBe(false);
  });

  it("rejects empty / non-string input", () => {
    expect(isReadOnlyVerb("")).toBe(false);
    expect(isReadOnlyVerb("   \n\t  ")).toBe(false);
    // @ts-expect-error — guard checks typeof
    expect(isReadOnlyVerb(undefined)).toBe(false);
    // @ts-expect-error — guard checks typeof
    expect(isReadOnlyVerb(null)).toBe(false);
  });

  it("rejects verb-like prefix that isn't a word (no \\b)", () => {
    expect(isReadOnlyVerb("SELECTOR FROM books")).toBe(false);
  });
});
