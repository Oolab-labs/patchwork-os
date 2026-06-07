/**
 * Tests for VsCodeBackend — specifically the SSRF guard on postWebhook.
 *
 * LOW #25: the webhook SSRF guard was lexical-only (hostname string check).
 * A public-looking hostname that resolves to a private IP bypassed the guard.
 * Fix: add DNS pre-resolution and re-check the resolved IP.
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
