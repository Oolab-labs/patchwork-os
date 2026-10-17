/**
 * IPv6 forms the lexical private-range check missed (audit M21, 2026-10-15),
 * plus the rest of fe80::/10, which the check matched only as "fe80:".
 *
 * Every case runs twice: as the hostname `new URL()` produces (the request
 * path, where embedded IPv4 is rewritten into hex groups) and as a raw
 * literal (a DNS answer or a redirect Location handed straight to the check).
 */

import { describe, expect, it } from "vitest";
import { isLoopbackHost, isPrivateHost } from "../privateHost.js";

const viaUrl = (literal: string) => new URL(`http://[${literal}]/`).hostname;

const PRIVATE = [
  ["::", "unspecified address"],
  ["::127.0.0.1", "IPv4-compatible loopback (deprecated ::/96)"],
  ["::10.0.0.1", "IPv4-compatible RFC 1918"],
  ["64:ff9b::127.0.0.1", "NAT64 well-known prefix wrapping loopback"],
  ["64:ff9b::10.0.0.1", "NAT64 well-known prefix wrapping RFC 1918"],
  ["64:ff9b::169.254.169.254", "NAT64 wrapping the metadata address"],
  ["64:ff9b:1::1", "NAT64 local-use prefix (RFC 8215)"],
  ["fec0::1", "site-local fec0::/10"],
  ["feff::1", "top of fec0::/10"],
  ["fe90::1", "link-local fe80::/10 beyond the fe80: prefix"],
  ["febf::1", "top of fe80::/10"],
] as const;

const PUBLIC = [
  ["64:ff9b::8.8.8.8", "NAT64 wrapping a public IPv4"],
  ["2606:4700:4700::1111", "public unicast"],
  ["fe00::1", "below fe80::/10"],
  ["::ffff:8.8.8.8", "IPv4-mapped public (already handled; must stay public)"],
] as const;

describe("isPrivateHost — IPv6 gaps", () => {
  for (const [lit, why] of PRIVATE) {
    it(`refuses ${lit} (${why}) via new URL()`, () => {
      expect(isPrivateHost(viaUrl(lit))).toBe(true);
    });
    it(`refuses ${lit} (${why}) as a raw literal`, () => {
      expect(isPrivateHost(lit)).toBe(true);
    });
  }
  for (const [lit, why] of PUBLIC) {
    it(`allows ${lit} (${why}) via new URL()`, () => {
      expect(isPrivateHost(viaUrl(lit))).toBe(false);
    });
    it(`allows ${lit} (${why}) as a raw literal`, () => {
      expect(isPrivateHost(lit)).toBe(false);
    });
  }
});

describe("isLoopbackHost — IPv4-compatible and NAT64 loopback", () => {
  // Webhook fan-out allows loopback but blocks other private ranges, so a
  // loopback in another wrapper must be recognised as loopback, not as
  // "private non-loopback".
  it("treats ::127.0.0.1 as loopback", () => {
    expect(isLoopbackHost(viaUrl("::127.0.0.1"))).toBe(true);
  });
  it("treats ::10.0.0.1 as not loopback", () => {
    expect(isLoopbackHost(viaUrl("::10.0.0.1"))).toBe(false);
  });
});
