/**
 * Regression test for `sinceToGmailQuery`.
 *
 * Caught in the post-merge tool audit (docs/dogfood/tool-audit.md): the
 * function silently coerced anything that wasn't `<N>d` or `<N>h` into
 * `"1d"`. Users specifying `since: '2026-01-01'` got the last 24 hours.
 * `since: '7days'` produced the malformed `"7aysd"` because the naive
 * `.replace("d", "")` stripped EVERY 'd' in the input.
 *
 * Fix uses a strict regex `/^(\d+)([dhmy])$/` and throws on
 * unparseable input so the recipe runner's error path triggers loudly.
 */

import { describe, expect, it } from "vitest";
import { sinceToGmailQuery } from "../gmail.js";

describe("sinceToGmailQuery — happy path", () => {
  it("passes through valid '<N>d' format", () => {
    expect(sinceToGmailQuery("7d")).toBe("7d");
    expect(sinceToGmailQuery("1d")).toBe("1d");
    expect(sinceToGmailQuery("365d")).toBe("365d");
  });

  it("passes through valid '<N>h' format", () => {
    expect(sinceToGmailQuery("24h")).toBe("24h");
    expect(sinceToGmailQuery("1h")).toBe("1h");
  });

  it("accepts months ('<N>m') and years ('<N>y') — Gmail supports both", () => {
    expect(sinceToGmailQuery("3m")).toBe("3m");
    expect(sinceToGmailQuery("1y")).toBe("1y");
  });

  it("trims whitespace", () => {
    expect(sinceToGmailQuery("  7d  ")).toBe("7d");
  });
});

describe("sinceToGmailQuery — throws on invalid input (regression)", () => {
  it("throws on ISO date (was silently → '1d')", () => {
    expect(() => sinceToGmailQuery("2026-01-01")).toThrow(/invalid since/);
  });

  it("throws on natural-language relative time (was silently → '1d')", () => {
    expect(() => sinceToGmailQuery("1 week ago")).toThrow(/invalid since/);
    expect(() => sinceToGmailQuery("yesterday")).toThrow(/invalid since/);
  });

  it("throws on '7days' (was producing malformed '7aysd')", () => {
    // The pre-fix code did `'7days'.replace('d', '') + 'd'` →
    // `'7ays' + 'd'` = `'7aysd'`. Sentinel: assert the strict
    // regex now rejects this rather than silently producing garbage.
    expect(() => sinceToGmailQuery("7days")).toThrow(/invalid since/);
  });

  it("throws on empty string (was → '1d')", () => {
    expect(() => sinceToGmailQuery("")).toThrow(/invalid since/);
  });

  it("throws on bare number without unit", () => {
    expect(() => sinceToGmailQuery("7")).toThrow(/invalid since/);
  });

  it("throws on multi-character or upper-case units", () => {
    expect(() => sinceToGmailQuery("7D")).toThrow(/invalid since/);
    expect(() => sinceToGmailQuery("1week")).toThrow(/invalid since/);
  });
});
