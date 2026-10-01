/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { isSafeRedirect } from "../safeRedirect";

describe("isSafeRedirect — post-login `next` target", () => {
  it("accepts a plain same-origin path", () => {
    expect(isSafeRedirect("/dashboard/approvals?x=1")).toBe(true);
  });

  it.each([
    ["absolute URL", "https://example.test/"],
    ["protocol-relative", "//example.test/"],
    ["backslash protocol-relative", "/\\example.test/"],
    ["empty", ""],
    ["not a string", 42],
    ["relative without leading slash", "dashboard"],
  ])("rejects %s", (_label, next) => {
    expect(isSafeRedirect(next)).toBe(false);
  });

  // The WHATWG URL parser strips ASCII tab and newline BEFORE parsing, so
  // `/\t/example.test` resolves to `https://example.test/` in every browser
  // (verified with Node's URL, which implements the same spec). A guard that
  // only looks at the first two characters lets these through.
  it.each([
    ["tab", "/\t/example.test"],
    ["newline", "/\n/example.test"],
    ["carriage return", "/\r/example.test"],
    ["tab after slash-backslash", "/\t\\example.test"],
    ["NUL", "/\0/example.test"],
    ["DEL", "/\x7f/example.test"],
  ])("rejects a control character (%s) anywhere in the value", (_label, next) => {
    expect(isSafeRedirect(next)).toBe(false);
  });

  // Not merely a blocklist: the value must resolve to the SAME origin when
  // the browser parses it, which is what actually decides where the user
  // lands. This is the property, the character checks are the fast path.
  it("resolves to the same origin under the WHATWG parser for every accepted value", () => {
    const origin = "https://dash.example";
    for (const next of ["/x", "/dashboard/a?b=c#d", "/dashboard/%2F%2Fevil"]) {
      expect(isSafeRedirect(next)).toBe(true);
      expect(new URL(next, origin).origin).toBe(origin);
    }
  });
});
