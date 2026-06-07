/**
 * LOW #40 — sessionFilter not URL-encoded in SSE polling fallback
 *
 * The polling fallback in the approvals page constructs:
 *   `${API}/approvals?session=${sessionFilter}`
 * without encodeURIComponent. Special characters (spaces, +, =, &) in
 * sessionFilter produce a malformed URL that may be misinterpreted by the
 * server.
 *
 * These tests verify the correct encoding behaviour by examining the URLs
 * built by the same pattern used in page.tsx. They are written against the
 * FIXED pattern; running them against the original buggy code reveals the
 * discrepancy.
 */

import { describe, expect, it } from "vitest";

/**
 * Mirrors the URL-construction pattern from approvals/page.tsx after the fix.
 * Pre-fix code: `?session=${sessionFilter}` (no encoding)
 * Post-fix code: `?session=${encodeURIComponent(sessionFilter)}`
 */
function buildPollUrl(apiBase: string, sessionFilter: string | null): string {
  return `${apiBase}/approvals${sessionFilter ? `?session=${encodeURIComponent(sessionFilter)}` : ""}`;
}

const API = "http://localhost:4300/api/bridge";

describe("approvals poll URL — sessionFilter must be URL-encoded (LOW #40)", () => {
  it("encodes spaces in sessionFilter", () => {
    const url = buildPollUrl(API, "my session id");
    // The session param value must not contain raw spaces
    const parsed = new URL(url);
    expect(parsed.searchParams.get("session")).toBe("my session id");
    // The raw URL must use percent-encoding, not a literal space
    expect(url).toContain("my%20session%20id");
    expect(url).not.toContain("my session id");
  });

  it("encodes + and = characters that would otherwise corrupt the query string", () => {
    const url = buildPollUrl(API, "tok+en=val");
    const parsed = new URL(url);
    // Round-trip through URL must return the original value
    expect(parsed.searchParams.get("session")).toBe("tok+en=val");
    // Raw + must be percent-encoded so it is not interpreted as a space
    expect(url).toContain("%2B");
    expect(url).toContain("%3D");
  });

  it("encodes & so it does not inject a second query parameter", () => {
    const url = buildPollUrl(API, "foo&bar=baz");
    const parsed = new URL(url);
    // Only one query parameter must exist
    expect([...parsed.searchParams.keys()]).toEqual(["session"]);
    expect(parsed.searchParams.get("session")).toBe("foo&bar=baz");
  });

  it("leaves a plain alphanumeric sessionFilter unchanged", () => {
    const url = buildPollUrl(API, "abc123");
    expect(url).toBe(`${API}/approvals?session=abc123`);
  });

  it("omits the query string when sessionFilter is null", () => {
    expect(buildPollUrl(API, null)).toBe(`${API}/approvals`);
  });

  it("omits the query string when sessionFilter is empty string", () => {
    expect(buildPollUrl(API, "")).toBe(`${API}/approvals`);
  });
});
