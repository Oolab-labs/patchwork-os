/**
 * Audit 2026-06-08 (fp-5): the automation webhook SSRF guard was lexical-only
 * (isPrivateNonLoopbackHost on the hostname string). A public hostname that
 * resolves to a private/IMDS address via split-horizon DNS bypassed it. This
 * pins the DNS-verified behaviour: loopback stays allowed (local sidecar
 * fan-out), every other private range is blocked even after DNS resolution.
 */

import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VsCodeBackend } from "../interpreterContext.js";

function backend(allowPrivate = false): VsCodeBackend {
  // postWebhook never touches the orchestrator; pass a stub.
  return new VsCodeBackend(null as never, undefined, allowPrivate);
}

const opts = (url: string) => ({
  url,
  method: "POST" as const,
  body: { hello: "world" },
  headers: {},
  hookKey: "onCompaction:pre",
});

describe("VsCodeBackend.postWebhook — SSRF", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("blocks a public host that DNS-resolves to a private IP (split-horizon)", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(dns, "lookup").mockResolvedValueOnce({
      address: "192.168.1.50",
      family: 4,
    } as never);

    const res = await backend().postWebhook(
      opts("https://webhook.attacker.com/x"),
    );
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a public host that DNS-resolves to the cloud metadata IP", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(dns, "lookup").mockResolvedValueOnce({
      address: "169.254.169.254",
      family: 4,
    } as never);

    const res = await backend().postWebhook(
      opts("https://imds.attacker.com/latest/meta-data"),
    );
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a lexically-private host without needing DNS", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const dnsSpy = vi.spyOn(dns, "lookup");

    const res = await backend().postWebhook(opts("http://192.168.0.5/x"));
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dnsSpy).not.toHaveBeenCalled();
  });

  it("allows loopback fan-out without a DNS lookup", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const dnsSpy = vi.spyOn(dns, "lookup");

    const res = await backend().postWebhook(opts("http://127.0.0.1:9000/x"));
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(dnsSpy).not.toHaveBeenCalled();
  });

  it("allows a public host that resolves to a public IP", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(dns, "lookup").mockResolvedValueOnce({
      address: "93.184.216.34",
      family: 4,
    } as never);

    const res = await backend().postWebhook(opts("https://example.com/x"));
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("--automation-allow-private-webhooks bypasses the guard", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await backend(true).postWebhook(opts("http://192.168.0.5/x"));
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
