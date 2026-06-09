/**
 * A-PR2 — `src/ssrfGuard.ts` unit tests.
 *
 * Both `isPrivateHost` (lexical) and `validateSafeUrl` (lexical + DNS) are
 * shared between `tools/httpClient.ts` and the recipe install route. These
 * tests pin the intersection so a refactor can't loosen one site without
 * the other.
 */

import dns from "node:dns/promises";
import { describe, expect, it, vi } from "vitest";
import {
  isLoopbackHost,
  isPrivateHost,
  isPrivateNonLoopbackHost,
  validateSafeUrl,
} from "../ssrfGuard.js";

describe("isPrivateHost", () => {
  it("blocks loopback IPv4", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("127.255.255.255")).toBe(true);
  });

  it("blocks RFC 1918 private ranges", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
  });

  it("blocks AWS metadata + link-local", () => {
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("169.254.0.1")).toBe(true);
  });

  it("blocks CGNAT", () => {
    expect(isPrivateHost("100.64.0.1")).toBe(true);
    expect(isPrivateHost("100.127.255.255")).toBe(true);
  });

  it("blocks IPv6 loopback + link-local + ULA", () => {
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("[::1]")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
    expect(isPrivateHost("fd00::1")).toBe(true);
    expect(isPrivateHost("fc00::1")).toBe(true);
  });

  it("blocks IPv6-mapped IPv4 loopback", () => {
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateHost("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateHost("::ffff:192.168.1.1")).toBe(true);
  });

  it("blocks 6to4 addresses (RFC 3056) — embeds private IPv4", () => {
    // 2002:c0a8:0101:: embeds 192.168.1.1 — must block entire 2002::/16
    expect(isPrivateHost("2002:c0a8:0101::1")).toBe(true);
    expect(isPrivateHost("2002:7f00:0001::1")).toBe(true);
    expect(isPrivateHost("2002:0a00:0001::1")).toBe(true);
    // Even 6to4 that embeds a public IP is blocked — we block the /16 wholesale
    expect(isPrivateHost("2002:0808:0808::1")).toBe(true);
  });

  it("blocks ::ffff:0: mapped addresses", () => {
    expect(isPrivateHost("::ffff:0:127.0.0.1")).toBe(true);
    expect(isPrivateHost("::ffff:0:10.0.0.1")).toBe(true);
  });

  it("LOW: blocks hex-compressed IPv4-mapped/translated addresses (new URL() form)", () => {
    // new URL("http://[::ffff:7f00:0001]/").hostname → "::ffff:7f00:1" in some environments
    // new URL("http://[::ffff:0:7f00:0001]/").hostname → "::ffff:0:7f00:1"
    // The stripped remainder "7f00:1" is 127.0.0.1 in hex — must be blocked.
    expect(isPrivateHost("::ffff:7f00:1")).toBe(true); // 127.0.0.1 mapped
    expect(isPrivateHost("::ffff:0:7f00:1")).toBe(true); // 127.0.0.1 translated
    expect(isPrivateHost("::ffff:c0a8:101")).toBe(true); // 192.168.1.1 mapped
    expect(isPrivateHost("::ffff:0a00:1")).toBe(true); // 10.0.0.1 mapped
  });

  it("blocks 0.0.0.0", () => {
    expect(isPrivateHost("0.0.0.0")).toBe(true);
  });

  it("blocks hex/octal IPv4 obfuscation", () => {
    expect(isPrivateHost("0x7f000001")).toBe(true);
    expect(isPrivateHost("0177000001")).toBe(true);
  });

  it("blocks localhost", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("foo.localhost")).toBe(true);
  });

  it("permits canonical public hostnames", () => {
    expect(isPrivateHost("github.com")).toBe(false);
    expect(isPrivateHost("raw.githubusercontent.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
  });
});

describe("validateSafeUrl", () => {
  it("rejects malformed URLs", async () => {
    const result = await validateSafeUrl("not a url");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_url");
  });

  it("rejects non-http(s) protocols", async () => {
    const result = await validateSafeUrl("ftp://example.org/foo");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unsupported_protocol");
  });

  it("rejects lexically-private hosts", async () => {
    const result = await validateSafeUrl("https://169.254.169.254/foo");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("private_host");
  });

  it("rejects loopback hosts", async () => {
    const result = await validateSafeUrl("https://127.0.0.1:8080/x");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("private_host");
  });

  it("accepts canonical public URL", async () => {
    const result = await validateSafeUrl("https://github.com/foo");
    // The lexical check passes; DNS may or may not resolve in the test env.
    // If DNS resolves to a public IP, ok === true; if it fails, ok still
    // true (we let fetch surface the error). The only failure mode here is
    // if DNS resolves to a private IP — which it won't for github.com.
    expect(result.ok).toBe(true);
  });
});

describe("validateSafeUrl — DNS rebinding", () => {
  it("blocks host that DNS-resolves to a private IP (private_host_after_dns)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValueOnce({
      address: "192.168.1.1",
      family: 4,
    });
    const result = await validateSafeUrl("https://evil.example.com/secret");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("private_host_after_dns");
    expect(result.detail).toContain("192.168.1.1");
    vi.restoreAllMocks();
  });

  it("blocks host that DNS-resolves to loopback (private_host_after_dns)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValueOnce({
      address: "127.0.0.1",
      family: 4,
    });
    const result = await validateSafeUrl("https://legit-looking.example.com/");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("private_host_after_dns");
    vi.restoreAllMocks();
  });

  it("blocks host that DNS-resolves to IPv6 loopback (private_host_after_dns)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValueOnce({
      address: "::1",
      family: 6,
    });
    const result = await validateSafeUrl("https://v6evil.example.com/");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("private_host_after_dns");
    vi.restoreAllMocks();
  });

  it("allows host that DNS-resolves to a public IP", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValueOnce({
      address: "140.82.112.4",
      family: 4,
    });
    const result = await validateSafeUrl("https://github.com/foo");
    expect(result.ok).toBe(true);
    expect(result.resolvedIp).toBe("140.82.112.4");
    vi.restoreAllMocks();
  });

  it("allows (ok: true) when DNS lookup fails — caller fetch surfaces the error", async () => {
    vi.spyOn(dns, "lookup").mockRejectedValueOnce(
      Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }),
    );
    const result = await validateSafeUrl(
      "https://nonexistent.example.invalid/",
    );
    expect(result.ok).toBe(true);
    expect(result.resolvedIp).toBeUndefined();
    vi.restoreAllMocks();
  });
});

describe("isLoopbackHost", () => {
  it("matches IPv4 loopback, IPv6 ::1, localhost", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.255.255.255")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("foo.localhost")).toBe(true);
  });

  it("matches IPv6-mapped/translated loopback", () => {
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::ffff:0:127.0.0.1")).toBe(true);
  });

  it("LOW: matches hex-compressed IPv6-mapped loopback (same fix as isPrivateHost)", () => {
    expect(isLoopbackHost("::ffff:7f00:1")).toBe(true); // 127.0.0.1 mapped
    expect(isLoopbackHost("::ffff:0:7f00:1")).toBe(true); // 127.0.0.1 translated
    expect(isLoopbackHost("::ffff:c0a8:101")).toBe(false); // 192.168.1.1 — not loopback
  });

  it("does not match private non-loopback", () => {
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(isLoopbackHost("169.254.169.254")).toBe(false);
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
    expect(isLoopbackHost("github.com")).toBe(false);
  });
});

describe("isPrivateNonLoopbackHost — webhook fan-out gate", () => {
  it("ALLOWS loopback (the documented exception for local sidecars)", () => {
    expect(isPrivateNonLoopbackHost("127.0.0.1")).toBe(false);
    expect(isPrivateNonLoopbackHost("::1")).toBe(false);
    expect(isPrivateNonLoopbackHost("localhost")).toBe(false);
  });

  it("blocks RFC 1918 private ranges", () => {
    expect(isPrivateNonLoopbackHost("10.0.0.1")).toBe(true);
    expect(isPrivateNonLoopbackHost("172.16.0.1")).toBe(true);
    expect(isPrivateNonLoopbackHost("192.168.1.1")).toBe(true);
  });

  it("blocks IMDS (AWS / link-local)", () => {
    expect(isPrivateNonLoopbackHost("169.254.169.254")).toBe(true);
  });

  it("blocks 6to4-wrapped IMDS — drift-class regression guard", () => {
    // 2002:a9fe:a9fe:: embeds 169.254.169.254 (AWS IMDS).
    // Pre-fix httpClient/interpreterContext copies missed `2002:` entirely.
    expect(isPrivateNonLoopbackHost("2002:a9fe:a9fe::")).toBe(true);
  });

  it("blocks ::ffff:0: mapped private — drift-class regression guard", () => {
    // ::ffff:0:c0a8:0101 wraps 192.168.1.1. Pre-fix copies tested the SHORT
    // ::ffff: prefix BEFORE the longer ::ffff:0: → the longer branch was
    // dead code and the address fell through to "not private" (BYPASS).
    expect(isPrivateNonLoopbackHost("::ffff:0:192.168.1.1")).toBe(true);
    expect(isPrivateNonLoopbackHost("::ffff:0:10.0.0.1")).toBe(true);
  });

  it("blocks ULA + link-local IPv6", () => {
    expect(isPrivateNonLoopbackHost("fe80::1")).toBe(true);
    expect(isPrivateNonLoopbackHost("fc00::1")).toBe(true);
    expect(isPrivateNonLoopbackHost("fd00::1")).toBe(true);
  });

  it("permits public hosts", () => {
    expect(isPrivateNonLoopbackHost("github.com")).toBe(false);
    expect(isPrivateNonLoopbackHost("8.8.8.8")).toBe(false);
  });
});
