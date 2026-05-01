/**
 * A-PR2 — `src/ssrfGuard.ts` unit tests.
 *
 * Both `isPrivateHost` (lexical) and `validateSafeUrl` (lexical + DNS) are
 * shared between `tools/httpClient.ts` and the recipe install route. These
 * tests pin the intersection so a refactor can't loosen one site without
 * the other.
 */

import { describe, expect, it } from "vitest";
import { isPrivateHost, validateSafeUrl } from "../ssrfGuard.js";

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
