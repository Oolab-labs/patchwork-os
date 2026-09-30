/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientKey } from "../clientIp";

function h(headers: Record<string, string>): Headers {
  return new Headers(headers);
}

describe("clientKey — BRIDGE_TRUST_PROXY=true (behind trusted proxy)", () => {
  beforeEach(() => {
    process.env.BRIDGE_TRUST_PROXY = "true";
  });
  afterEach(() => {
    delete process.env.BRIDGE_TRUST_PROXY;
  });

  it("returns the sole entry from x-forwarded-for", () => {
    expect(clientKey(h({ "x-forwarded-for": "203.0.113.42" }))).toBe(
      "203.0.113.42",
    );
  });

  it("trims whitespace around x-forwarded-for entries", () => {
    expect(clientKey(h({ "x-forwarded-for": "  198.51.100.7  " }))).toBe(
      "198.51.100.7",
    );
  });

  // Every shipped nginx config uses `$proxy_add_x_forwarded_for`, which
  // APPENDS the peer nginx actually saw to whatever the client sent. The
  // leftmost hop is therefore attacker-controlled; the rightmost is the one
  // the trusted proxy wrote. Keying the lockout on the leftmost let a client
  // rotate `X-Forwarded-For: <random>` per attempt and never trip it.
  it("picks the RIGHTMOST entry from a comma chain (the hop the trusted proxy appended)", () => {
    expect(
      clientKey(
        h({ "x-forwarded-for": "6.6.6.6, 10.0.0.5, 203.0.113.1" }),
      ),
    ).toBe("203.0.113.1");
  });

  it("a client-supplied leading hop cannot change the key", () => {
    const real = "203.0.113.1";
    const a = clientKey(h({ "x-forwarded-for": `1.1.1.1, ${real}` }));
    const b = clientKey(h({ "x-forwarded-for": `2.2.2.2, ${real}` }));
    expect(a).toBe(real);
    expect(b).toBe(real);
  });

  it("uses x-real-ip when x-forwarded-for is absent", () => {
    expect(clientKey(h({ "x-real-ip": "203.0.113.99" }))).toBe("203.0.113.99");
  });

  // nginx sets X-Real-IP from `$remote_addr`, never from client input, so it
  // is the one header a proxy-fronted deployment can trust outright.
  it("prefers x-real-ip over x-forwarded-for when both are present", () => {
    expect(
      clientKey(
        h({
          "x-forwarded-for": "6.6.6.6, 203.0.113.1",
          "x-real-ip": "203.0.113.1",
        }),
      ),
    ).toBe("203.0.113.1");
    expect(
      clientKey(
        h({
          "x-forwarded-for": "6.6.6.6",
          "x-real-ip": "10.0.0.5",
        }),
      ),
    ).toBe("10.0.0.5");
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

describe("clientKey — BRIDGE_TRUST_PROXY unset (direct / local deploy)", () => {
  beforeEach(() => {
    delete process.env.BRIDGE_TRUST_PROXY;
  });

  it("returns 'unknown' regardless of x-forwarded-for — prevents lockout bypass via header spoofing", () => {
    expect(clientKey(h({ "x-forwarded-for": "203.0.113.1" }))).toBe("unknown");
  });

  it("returns 'unknown' regardless of x-real-ip", () => {
    expect(clientKey(h({ "x-real-ip": "203.0.113.1" }))).toBe("unknown");
  });

  it("returns 'unknown' when no headers set", () => {
    expect(clientKey(h({}))).toBe("unknown");
  });
});
