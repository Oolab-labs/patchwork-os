/**
 * Tests for the user-request tag sanitizer used by /recipes/generate.
 *
 * Security review (2026-05-07) found the previous regex
 * `/<\/?user_request>/gi` only matched the literal closing `>` directly
 * after the tag name, so an attacker could bypass the strip by adding
 * attributes (`<user_request foo="bar">`), self-closing the tag
 * (`<user_request />`), or inserting whitespace before the close
 * (`<user_request\n>`). The hardened regex tolerates whitespace and
 * arbitrary attributes between the tag name and `>`.
 */

import { describe, expect, it } from "vitest";
import { sanitizeUserRequestTags } from "../recipeOrchestration.js";

describe("sanitizeUserRequestTags", () => {
  it("strips the bare opening and closing tags (regression)", () => {
    const out = sanitizeUserRequestTags("<user_request>hello</user_request>");
    expect(out).not.toMatch(/<\/?user_request/i);
    expect(out).toContain("hello");
  });

  it("strips tags with attributes (security audit, 2026-05-07)", () => {
    const out = sanitizeUserRequestTags(
      '<user_request foo="bar">attack</user_request foo>',
    );
    expect(out).not.toMatch(/<\s*\/?\s*user_request/i);
  });

  it("strips self-closing tags (security audit, 2026-05-07)", () => {
    const out = sanitizeUserRequestTags("before<user_request />after");
    expect(out).not.toMatch(/<\s*user_request/i);
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("strips tags with whitespace after `<` (security audit, 2026-05-07)", () => {
    const out = sanitizeUserRequestTags("< user_request>x</ user_request>");
    expect(out).not.toMatch(/<\s*\/?\s*user_request/i);
  });

  it("strips tags with newlines/tabs before `>`", () => {
    const out = sanitizeUserRequestTags(
      "<user_request\n  foo\n>x</user_request\t>",
    );
    expect(out).not.toMatch(/<\s*\/?\s*user_request/i);
  });

  it("is case-insensitive", () => {
    const out = sanitizeUserRequestTags("<USER_REQUEST>x</User_Request>");
    expect(out).not.toMatch(/<\s*\/?\s*user_request/i);
  });

  it("leaves benign user input unchanged", () => {
    const input = "Build me a recipe that emails my morning brief.";
    expect(sanitizeUserRequestTags(input)).toBe(input);
  });

  it("does not match unrelated tags that share a prefix", () => {
    // Word boundary should prevent <user_request_extra> from matching
    // user_request — leave it untouched (still suspicious, but not the
    // documented injection vector).
    const input = "<user_request_extra>x</user_request_extra>";
    expect(sanitizeUserRequestTags(input)).toBe(input);
  });
});
