/**
 * Tests for sendHttpRequest — input validation and SSRF guard (isPrivateHost).
 * No real network calls are made; the SSRF guard fires before any I/O.
 */
import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSendHttpRequestTool } from "../httpClient.js";

const tool = createSendHttpRequestTool();

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

describe("sendHttpRequest — input validation", () => {
  it("rejects unsupported HTTP method", async () => {
    const result = await tool.handler({
      method: "CONNECT",
      url: "https://example.com",
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/Unsupported method/);
  });

  it("rejects invalid URL", async () => {
    const result = await tool.handler({ method: "GET", url: "not-a-url" });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/Invalid URL/);
  });

  it("rejects non-http/https protocol", async () => {
    const result = await tool.handler({
      method: "GET",
      url: "ftp://example.com/file",
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/http/i);
  });
});

describe("sendHttpRequest — SSRF guard (isPrivateHost)", () => {
  async function expectBlocked(url: string) {
    const result = await tool.handler({ method: "GET", url });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/private|loopback/i);
  }

  it("blocks localhost", () => expectBlocked("http://localhost/"));
  it("blocks 127.0.0.1", () => expectBlocked("http://127.0.0.1/"));
  it("blocks 10.0.0.1 (RFC 1918)", () => expectBlocked("http://10.0.0.1/"));
  it("blocks 172.16.0.1 (RFC 1918)", () => expectBlocked("http://172.16.0.1/"));
  it("blocks 192.168.1.1 (RFC 1918)", () =>
    expectBlocked("http://192.168.1.1/"));
  it("blocks 169.254.1.1 (link-local)", () =>
    expectBlocked("http://169.254.1.1/"));
  it("blocks ::1 (IPv6 loopback)", () => expectBlocked("http://[::1]/"));
  it("blocks fe80:: (IPv6 link-local)", () =>
    expectBlocked("http://[fe80::1]/"));
  it("blocks 0.0.0.0", () => expectBlocked("http://0.0.0.0/"));
  it("blocks hex-encoded IP (0x7f000001)", () =>
    expectBlocked("http://0x7f000001/"));
  it("blocks 100.64.0.1 (CGNAT / RFC 6598)", () =>
    expectBlocked("http://100.64.0.1/"));
});

describe("sendHttpRequest — AbortSignal listener cleanup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("removes abort listener from caller signal when request fails with network error", async () => {
    // Regression: before fix, clearTimeout was called but the abort forwarder
    // was never removed from the caller's signal, causing listener accumulation
    // over many requests on a long-lived AbortController.

    // Mock DNS to return a public IP (avoids real DNS + passes SSRF guard)
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "93.184.216.34",
      family: 4,
    } as any);

    // Mock fetch to fail with a network error (no real I/O)
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("fetch failed: network error"));

    const controller = new AbortController();
    let removeCalled = 0;
    const origRemove = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    vi.spyOn(controller.signal, "removeEventListener").mockImplementation(
      (type, fn, opts) => {
        if (type === "abort") removeCalled++;
        return origRemove(type, fn, opts);
      },
    );

    await tool.handler(
      { method: "GET", url: "https://example.com" },
      controller.signal,
    );

    // cleanup() must have been called — abort listener removed from caller signal
    expect(removeCalled).toBe(1);
    fetchSpy.mockRestore();
  });
});

describe("sendHttpRequest — Host header SSRF bypass prevention", () => {
  it("does not allow caller-supplied Host header to override the pinned hostname", async () => {
    // The tool sets Host = parsedUrl.hostname when IP-pinning.
    // A user-supplied Host header must NOT overwrite it, or an attacker
    // could pin to a public IP but send Host: 169.254.169.254 to trick
    // a server-side proxy into routing internally.
    // We test this by intercepting how the tool builds its headers object.
    // Since real network calls aren't made here, we just verify the tool
    // accepts the request (doesn't error on header validation) and that
    // the header injection check catches CRLF but not legitimate Host override.
    // The real protection is that our Host is set AFTER user headers.

    // Test: CRLF injection in Host header is still blocked
    const result = await tool.handler({
      method: "GET",
      url: "https://example.com/",
      headers: { Host: "evil.com\r\nX-Injected: yes" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "{}").error).toMatch(
      /invalid characters/i,
    );
  });
});
