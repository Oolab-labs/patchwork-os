import { describe, expect, it } from "vitest";
import {
  parseJsonSanitized,
  sanitizeParsedJson,
} from "../sanitizeParsedJson.js";

describe("sanitizeParsedJson", () => {
  it("returns primitives unchanged", () => {
    expect(sanitizeParsedJson("hello")).toBe("hello");
    expect(sanitizeParsedJson(42)).toBe(42);
    expect(sanitizeParsedJson(true)).toBe(true);
    expect(sanitizeParsedJson(null)).toBe(null);
    expect(sanitizeParsedJson(undefined)).toBe(undefined);
  });

  it("preserves benign object keys", () => {
    expect(sanitizeParsedJson({ a: 1, b: "two", c: null })).toEqual({
      a: 1,
      b: "two",
      c: null,
    });
  });

  it("strips top-level __proto__ key", () => {
    // JSON.parse stores __proto__ as an own property via defineProperty;
    // it does NOT pollute Object.prototype at parse time. The risk is
    // downstream Object.assign / spread re-introducing it.
    const raw = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
    const sanitized = sanitizeParsedJson(raw) as Record<string, unknown>;
    expect(sanitized).toEqual({ safe: 1 });
    expect(Object.hasOwn(sanitized, "__proto__")).toBe(false);
  });

  it("strips top-level constructor key", () => {
    const raw = JSON.parse('{"constructor":"evil","safe":1}');
    expect(sanitizeParsedJson(raw)).toEqual({ safe: 1 });
  });

  it("strips top-level prototype key", () => {
    const raw = JSON.parse('{"prototype":"evil","safe":1}');
    expect(sanitizeParsedJson(raw)).toEqual({ safe: 1 });
  });

  it("strips dangerous keys at every depth (object children)", () => {
    const raw = JSON.parse('{"nested":{"__proto__":{"x":1},"a":2},"a":3}');
    expect(sanitizeParsedJson(raw)).toEqual({
      nested: { a: 2 },
      a: 3,
    });
  });

  it("strips dangerous keys at every depth (array children)", () => {
    const raw = JSON.parse(
      '[{"__proto__":{"x":1},"a":2},{"constructor":"y","b":3}]',
    );
    expect(sanitizeParsedJson(raw)).toEqual([{ a: 2 }, { b: 3 }]);
  });

  it("does not mutate the input", () => {
    const raw = JSON.parse('{"__proto__":{"x":1},"a":2}');
    sanitizeParsedJson(raw);
    // Input still has the dangerous own property — sanitize is a clone.
    expect(Object.hasOwn(raw as object, "__proto__")).toBe(true);
  });

  it("preserves arrays of primitives", () => {
    expect(sanitizeParsedJson([1, "two", null, true])).toEqual([
      1,
      "two",
      null,
      true,
    ]);
  });

  it("preserves nested objects with no dangerous keys", () => {
    expect(sanitizeParsedJson({ a: { b: { c: [{ d: 1 }] } } })).toEqual({
      a: { b: { c: [{ d: 1 }] } },
    });
  });
});

describe("parseJsonSanitized", () => {
  it("parses + sanitizes in one call", () => {
    expect(parseJsonSanitized('{"__proto__":{"x":1},"a":2}')).toEqual({
      a: 2,
    });
  });

  it("throws on invalid JSON (same as JSON.parse)", () => {
    expect(() => parseJsonSanitized("not-json")).toThrow(SyntaxError);
  });
});
