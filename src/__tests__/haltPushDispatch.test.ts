/**
 * Behavioral tests for dispatchHaltPushNotification's actual implementation
 * (SSRF guard, DNS resolution, fetch, timeout, error handling).
 *
 * The sibling `wireHaltPushDispatch.test.ts` mocks this module out entirely
 * to test *when* dispatch is invoked — it never exercises this function's
 * real body, leaving it at 0% coverage despite being the only halt-alert
 * channel and an SSRF-guarded network boundary. This file covers the
 * function itself.
 */

import dns from "node:dns/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchHaltPushNotification } from "../haltPushDispatch.js";

const PAYLOAD = {
  recipeName: "nightly-review",
  runSeq: 42,
  status: "error" as const,
  haltReason: "step_timeout:build",
};

describe("dispatchHaltPushNotification", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects a non-HTTPS push service URL without attempting DNS or fetch", async () => {
    const lookupSpy = vi.spyOn(dns, "lookup");
    await dispatchHaltPushNotification(
      "http://relay.example.com",
      "tok",
      PAYLOAD,
    );
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Rejected non-HTTPS"),
    );
  });

  it("rejects a malformed push service URL", async () => {
    await dispatchHaltPushNotification("https://[not-valid", "tok", PAYLOAD);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Malformed push service URL"),
    );
  });

  it("blocks the literal 'localhost' hostname without a DNS lookup", async () => {
    const lookupSpy = vi.spyOn(dns, "lookup");
    await dispatchHaltPushNotification(
      "https://localhost:9999",
      "tok",
      PAYLOAD,
    );
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Blocked loopback push service hostname"),
    );
  });

  it("blocks a hostname that resolves to a private IP (SSRF guard)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "10.0.0.5",
      family: 4,
    } as never);
    await dispatchHaltPushNotification(
      "https://internal.example.com",
      "tok",
      PAYLOAD,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Blocked private/loopback IP"),
    );
  });

  it("blocks an IPv4-mapped IPv6 loopback address (the historical audit HIGH #5 gap)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "::ffff:127.0.0.1",
      family: 6,
    } as never);
    await dispatchHaltPushNotification(
      "https://sneaky.example.com",
      "tok",
      PAYLOAD,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Blocked private/loopback IP"),
    );
  });

  it("skips dispatch and warns when DNS resolution fails", async () => {
    vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ENOTFOUND"));
    await dispatchHaltPushNotification(
      "https://gone.example.com",
      "tok",
      PAYLOAD,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("DNS resolution failed"),
    );
  });

  it("POSTs to <url>/halt with a bearer token and the JSON payload on a public host", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "203.0.113.10",
      family: 4,
    } as never);
    fetchSpy.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });

    await dispatchHaltPushNotification(
      "https://relay.example.com",
      "tok-secret",
      PAYLOAD,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.example.com/halt");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-secret",
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual(PAYLOAD);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats a 404 from the relay as informational — no warning", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "203.0.113.10",
      family: 4,
    } as never);
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await dispatchHaltPushNotification(
      "https://relay.example.com",
      "tok",
      PAYLOAD,
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns on a non-404 non-2xx response from the relay", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "203.0.113.10",
      family: 4,
    } as never);
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    await dispatchHaltPushNotification(
      "https://relay.example.com",
      "tok",
      PAYLOAD,
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Non-2xx from push relay: 500"),
    );
  });

  it("never throws when fetch itself rejects (fire-and-forget contract)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "203.0.113.10",
      family: 4,
    } as never);
    fetchSpy.mockRejectedValue(new Error("network down"));

    await expect(
      dispatchHaltPushNotification("https://relay.example.com", "tok", PAYLOAD),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Dispatch failed: network down"),
    );
  });
});
