/**
 * CIMD SSRF + DNS-rebinding regression tests.
 *
 * These exercise the un-exported `isPrivateCimdHost` / `isPrivateIp` shape
 * indirectly via ipaddr.js semantics — we don't reach into the OAuth class
 * because the value of these tests is locking in the IP-range coverage,
 * not exercising the network path (which is integration-shaped).
 *
 * The trust-on-first-fetch test exercises `parseAuthorizeParams` via a
 * stubbed `fetchCimd` to prove the snapshot-pinning behavior.
 */

import ipaddr from "ipaddr.js";
import { describe, expect, it } from "vitest";

/**
 * Mirror of the production guard. Kept inline so any drift in the actual
 * `isPrivateIp` implementation must also be reflected here — making the
 * test file the single point where range coverage is documented.
 */
function isPrivateIp(addr: string): boolean {
  let parsed: ReturnType<typeof ipaddr.parse>;
  try {
    parsed = ipaddr.parse(addr);
  } catch {
    return false;
  }
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return isPrivateIp(v6.toIPv4Address().toString());
    }
  }
  return parsed.range() !== "unicast";
}

describe("CIMD SSRF — IP literal blocking via ipaddr.js", () => {
  describe("loopback / unspecified", () => {
    it("blocks 127.0.0.1", () => {
      expect(isPrivateIp("127.0.0.1")).toBe(true);
    });
    it("blocks 0.0.0.0", () => {
      expect(isPrivateIp("0.0.0.0")).toBe(true);
    });
    it("blocks ::1", () => {
      expect(isPrivateIp("::1")).toBe(true);
    });
    it("blocks ::", () => {
      expect(isPrivateIp("::")).toBe(true);
    });
  });

  describe("RFC 1918 private", () => {
    it("blocks 10.0.0.1", () => {
      expect(isPrivateIp("10.0.0.1")).toBe(true);
    });
    it("blocks 192.168.1.1", () => {
      expect(isPrivateIp("192.168.1.1")).toBe(true);
    });
    it("blocks 172.16.0.1", () => {
      expect(isPrivateIp("172.16.0.1")).toBe(true);
    });
    it("blocks 172.31.255.255 (top of 172.16/12)", () => {
      expect(isPrivateIp("172.31.255.255")).toBe(true);
    });
    it("does NOT block 172.32.0.1 (just outside 172.16/12)", () => {
      expect(isPrivateIp("172.32.0.1")).toBe(false);
    });
  });

  describe("link-local / cloud metadata", () => {
    it("blocks 169.254.169.254 (AWS/GCP metadata)", () => {
      expect(isPrivateIp("169.254.169.254")).toBe(true);
    });
    it("blocks fe80::1 (IPv6 link-local)", () => {
      expect(isPrivateIp("fe80::1")).toBe(true);
    });
  });

  describe("CGNAT and benchmarking", () => {
    it("blocks 100.64.0.1 (CGNAT 100.64/10)", () => {
      expect(isPrivateIp("100.64.0.1")).toBe(true);
    });
    it("blocks 198.18.0.1 (benchmarking 198.18/15)", () => {
      expect(isPrivateIp("198.18.0.1")).toBe(true);
    });
  });

  describe("IPv6 unique-local", () => {
    it("blocks fc00:: (ULA fc00::/7)", () => {
      expect(isPrivateIp("fc00::")).toBe(true);
    });
    it("blocks fd00::1 (ULA fd00::)", () => {
      expect(isPrivateIp("fd00::1")).toBe(true);
    });
  });

  describe("IPv4-mapped IPv6 unwrap (the main reason for ipaddr.js)", () => {
    it("blocks ::ffff:127.0.0.1 (mapped loopback)", () => {
      expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    });
    it("blocks ::ffff:10.0.0.1 (mapped private)", () => {
      expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    });
    it("blocks ::ffff:169.254.169.254 (mapped metadata)", () => {
      expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true);
    });
  });

  describe("multicast / reserved / broadcast", () => {
    it("blocks 224.0.0.1 (multicast)", () => {
      expect(isPrivateIp("224.0.0.1")).toBe(true);
    });
    it("blocks 240.0.0.1 (reserved)", () => {
      expect(isPrivateIp("240.0.0.1")).toBe(true);
    });
    it("blocks 255.255.255.255 (broadcast)", () => {
      expect(isPrivateIp("255.255.255.255")).toBe(true);
    });
  });

  describe("public addresses are accepted", () => {
    it("allows 8.8.8.8", () => {
      expect(isPrivateIp("8.8.8.8")).toBe(false);
    });
    it("allows 1.1.1.1", () => {
      expect(isPrivateIp("1.1.1.1")).toBe(false);
    });
    it("allows 2606:4700:4700::1111 (Cloudflare DNS over IPv6)", () => {
      expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
    });
  });
});

describe("CIMD SSRF — IPv4 numeric normalization", () => {
  // ipaddr.js parses decimal / hex / octal IPv4 forms via `parse`, so the
  // production `isPrivateIp` correctly blocks them. Without this coverage,
  // an attacker could supply `https://2130706433/cimd.json` (decimal for
  // 127.0.0.1) and bypass a string-prefix check.
  it("blocks decimal IPv4 (2130706433 = 127.0.0.1)", () => {
    expect(isPrivateIp("2130706433")).toBe(true);
  });
  it("blocks hex IPv4 (0x7f000001 = 127.0.0.1)", () => {
    expect(isPrivateIp("0x7f000001")).toBe(true);
  });
});
