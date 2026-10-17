/**
 * Tests for VsCodeBackend — specifically the SSRF guard on postWebhook.
 *
 * LOW #25: the webhook SSRF guard was lexical-only (hostname string check).
 * A public-looking hostname that resolves to a private IP bypassed the guard.
 * Fix: add DNS pre-resolution and re-check the resolved IP.
 *
 * M15: After the DNS check passes, fetch() was called with the original hostname,
 * creating a TOCTOU window (DNS rebinding attack). Fix: pin the resolved IP in
 * the fetch URL and set the Host header to the original hostname.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VsCodeBackend } from "../interpreterContext.js";

// Mock dns/promises so we can control what addresses hostnames resolve to.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn() };
});

// Mock global fetch so we don't make real HTTP requests.
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import * as dns from "node:dns/promises";

function makeBackend(allowPrivate = false) {
  // VsCodeBackend requires an orchestrator — supply a minimal stub.
  const orchestratorStub = {
    enqueue: vi.fn().mockReturnValue("task-1"),
  };
  return new VsCodeBackend(
    orchestratorStub as unknown as ConstructorParameters<
      typeof VsCodeBackend
    >[0],
    undefined,
    allowPrivate,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(dns.lookup).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VsCodeBackend.postWebhook — SSRF DNS pre-resolution (LOW #25)", () => {
  it("blocks a public-looking hostname that resolves to a private RFC-1918 IP", async () => {
    // evil.example.com looks public but resolves to 192.168.1.1.
    vi.mocked(dns.lookup).mockResolvedValue({
      address: "192.168.1.1",
      family: 4,
    });

    const backend = makeBackend(false);
    const result = await backend.postWebhook({
      url: "http://evil.example.com/hook",
      method: "POST",
      headers: {},
      body: {},
      hookKey: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/private|blocked/i);
    // fetch should NOT have been called.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a public-looking hostname that resolves to 10.x.x.x", async () => {
    vi.mocked(dns.lookup).mockResolvedValue({
      address: "10.0.0.1",
      family: 4,
    });

    const backend = makeBackend(false);
    const result = await backend.postWebhook({
      url: "http://internal.corp.example.com/hook",
      method: "POST",
      headers: {},
      body: {},
      hookKey: "test",
    });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a public hostname that resolves to a public IP", async () => {
    vi.mocked(dns.lookup).mockResolvedValue({
      address: "93.184.216.34", // example.com
      family: 4,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const backend = makeBackend(false);
    const result = await backend.postWebhook({
      url: "http://example.com/hook",
      method: "POST",
      headers: {},
      body: {},
      hookKey: "test",
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("still allows loopback even when DNS resolves to a loopback address", async () => {
    // Loopback is intentionally allowed for webhook fan-out (bridge listens
    // on 127.0.0.1). The lexical guard already permits it, and DNS should
    // confirm: if DNS resolves to 127.0.0.1, it is still loopback.
    vi.mocked(dns.lookup).mockResolvedValue({
      address: "127.0.0.1",
      family: 4,
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const backend = makeBackend(false);
    const result = await backend.postWebhook({
      url: "http://127.0.0.1:9000/hook",
      method: "POST",
      headers: {},
      body: {},
      hookKey: "test",
    });

    expect(result.ok).toBe(true);
  });

  // Audit M19 (2026-10-15). Pinning used to rewrite the URL's hostname to the
  // resolved IP and send the real name in a Host header — the shape #1661
  // found broken for HTTPS: TLS then validates the certificate against an IP
  // with no SNI, so every webhook to a public HTTPS endpoint failed. The pin
  // now lives in the connection (safeFetch's dispatcher); the URL keeps its
  // real hostname for TLS and Host.
  for (const url of [
    "https://example.com/hook",
    "https://MyHooks.Example.com/hook",
  ]) {
    it(`keeps the real hostname in the request and pins in the connection (${url})`, async () => {
      vi.mocked(dns.lookup).mockResolvedValue({
        address: "93.184.216.34",
        family: 4,
      });
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

      const backend = makeBackend(false);
      const result = await backend.postWebhook({
        url,
        method: "POST",
        headers: {},
        body: { x: 1 },
        hookKey: "test",
      });

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [calledUrl, calledOpts] = fetchMock.mock.calls[0] as [
        string | URL,
        RequestInit & { dispatcher?: unknown },
      ];
      expect(new URL(String(calledUrl)).hostname).toBe(new URL(url).hostname);
      expect(String(calledUrl)).not.toContain("93.184.216.34");
      const headers = new Headers(calledOpts.headers);
      expect(headers.get("host")).toBeNull();
      expect(calledOpts.dispatcher).toBeDefined();
    });
  }

  it("re-checks a redirect: a hop to a private address is refused, not followed", async () => {
    vi.mocked(dns.lookup).mockImplementation((async (host: string) =>
      host === "example.com"
        ? { address: "93.184.216.34", family: 4 }
        : { address: "10.0.0.5", family: 4 }) as never);
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "http://internal.example.com/admin" },
      }),
    );

    const backend = makeBackend(false);
    const result = await backend.postWebhook({
      url: "https://example.com/hook",
      method: "POST",
      headers: {},
      body: { x: 1 },
      hookKey: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/private/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses when DNS fails rather than sending unpinned", async () => {
    vi.mocked(dns.lookup).mockRejectedValue(new Error("ENOTFOUND"));
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const backend = makeBackend(false);
    const result = await backend.postWebhook({
      url: "https://example.com/hook",
      method: "POST",
      headers: {},
      body: { x: 1 },
      hookKey: "test",
    });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows private IPs when allowPrivateWebhooks=true", async () => {
    // With the allow-private flag, private hosts are permitted regardless.
    vi.mocked(dns.lookup).mockResolvedValue({
      address: "192.168.1.1",
      family: 4,
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const backend = makeBackend(true);
    const result = await backend.postWebhook({
      url: "http://192.168.1.1/hook",
      method: "POST",
      headers: {},
      body: {},
      hookKey: "test",
    });

    expect(result.ok).toBe(true);
  });
});
