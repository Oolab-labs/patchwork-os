/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { clientKey } from "../clientIp";

function h(headers: Record<string, string>): Headers {
  return new Headers(headers);
}

describe("clientKey", () => {
  it("returns the leftmost entry from x-forwarded-for", () => {
    expect(clientKey(h({ "x-forwarded-for": "203.0.113.42" }))).toBe(
      "203.0.113.42",
    );
  });

  it("trims whitespace around x-forwarded-for entries", () => {
    expect(clientKey(h({ "x-forwarded-for": "  198.51.100.7  " }))).toBe(
      "198.51.100.7",
    );
  });

  it("picks the leftmost (originating client) entry from a comma chain", () => {
    expect(
      clientKey(
        h({ "x-forwarded-for": "203.0.113.1, 10.0.0.5, 10.0.0.6" }),
      ),
    ).toBe("203.0.113.1");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    expect(clientKey(h({ "x-real-ip": "203.0.113.99" }))).toBe("203.0.113.99");
  });

  it("prefers x-forwarded-for over x-real-ip when both are present", () => {
    expect(
      clientKey(
        h({
          "x-forwarded-for": "203.0.113.1",
          "x-real-ip": "10.0.0.5",
        }),
      ),
    ).toBe("203.0.113.1");
  });

  it("returns 'unknown' when neither header is set", () => {
    expect(clientKey(h({}))).toBe("unknown");
  });

  it("returns 'unknown' when x-forwarded-for is empty string", () => {
    expect(clientKey(h({ "x-forwarded-for": "" }))).toBe("unknown");
  });

  it("falls through to x-real-ip when x-forwarded-for is whitespace-only", () => {
    expect(
      clientKey(h({ "x-forwarded-for": "   ", "x-real-ip": "10.0.0.1" })),
    ).toBe("10.0.0.1");
  });

  it("returns 'unknown' if both headers are empty / whitespace-only", () => {
    expect(
      clientKey(h({ "x-forwarded-for": "", "x-real-ip": "   " })),
    ).toBe("unknown");
  });

  it("works against any HeadersLike object (not just Headers)", () => {
    const stub = {
      get: (name: string) =>
        name === "x-forwarded-for" ? "192.0.2.1" : null,
    };
    expect(clientKey(stub)).toBe("192.0.2.1");
  });
});
