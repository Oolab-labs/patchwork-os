/**
 * Telemetry transport rules (opt-in usage summaries only):
 * - default endpoint is the live collector, defined ONCE and exported;
 * - DO_NOT_TRACK (Console Do Not Track convention) stops every send;
 * - PATCHWORK_TELEMETRY_DEBUG prints the payload and sends nothing;
 * - an engaged write kill switch stops the send;
 * - sends go through safeFetch: the default must be public https, an
 *   operator-configured endpoint may be private (e.g. a collector on a
 *   private network) and is still never redirected.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ANALYTICS_ENDPOINT,
  sendAnalytics,
  telemetrySuppressed,
} from "../analyticsSend.js";

const SUMMARY = {
  bridgeVersion: "1.2.0-beta.3",
  sessionDurationMs: 10,
  toolStats: [],
};

function deps(over: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn(
    async (_url: unknown, _init?: unknown) =>
      new Response(null, { status: 204 }),
  );
  return {
    fetchImpl,
    resolveDns: async () => "93.184.216.34",
    killSwitchEngaged: () => false,
    writeDebug: vi.fn(),
    onSent: vi.fn(),
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("default endpoint", () => {
  it("is the live collector over https", () => {
    expect(DEFAULT_ANALYTICS_ENDPOINT).toBe(
      "https://analytics.patchworkos.com/v1/usage",
    );
  });

  it("sends the summary to it by default", async () => {
    vi.stubEnv("PATCHWORK_ANALYTICS_ENDPOINT", "");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/nonexistent-for-test");
    const d = deps();
    await sendAnalytics(SUMMARY, d);
    expect(d.fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = d.fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(String(url)).toBe(DEFAULT_ANALYTICS_ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual(SUMMARY);
    expect(d.onSent).toHaveBeenCalledOnce();
  });
});

describe("suppression", () => {
  for (const v of ["1", "true", "yes"]) {
    it(`DO_NOT_TRACK=${v} sends nothing`, async () => {
      vi.stubEnv("DO_NOT_TRACK", v);
      const d = deps();
      await sendAnalytics(SUMMARY, d);
      expect(d.fetchImpl).not.toHaveBeenCalled();
      expect(telemetrySuppressed()).toBe("do_not_track");
    });
  }

  it("DO_NOT_TRACK=0 does not suppress", () => {
    vi.stubEnv("DO_NOT_TRACK", "0");
    expect(telemetrySuppressed()).toBeNull();
  });

  it("PATCHWORK_TELEMETRY_DEBUG prints the payload and sends nothing", async () => {
    vi.stubEnv("PATCHWORK_TELEMETRY_DEBUG", "1");
    const d = deps();
    await sendAnalytics(SUMMARY, d);
    expect(d.fetchImpl).not.toHaveBeenCalled();
    expect(String(d.writeDebug.mock.calls[0]?.[0])).toContain(
      '"bridgeVersion":"1.2.0-beta.3"',
    );
  });

  it("an engaged kill switch sends nothing", async () => {
    const d = deps({ killSwitchEngaged: () => true });
    await sendAnalytics(SUMMARY, d);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("transport guard", () => {
  it("refuses a default-path send that resolves to a private address", async () => {
    vi.stubEnv("PATCHWORK_ANALYTICS_ENDPOINT", "");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/nonexistent-for-test");
    const d = deps({ resolveDns: async () => "10.0.0.5" });
    await expect(sendAnalytics(SUMMARY, d)).resolves.toBeUndefined();
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it("allows an operator-configured private http endpoint", async () => {
    vi.stubEnv(
      "PATCHWORK_ANALYTICS_ENDPOINT",
      "http://collector.internal.test:8787/v1/usage",
    );
    const d = deps({ resolveDns: async () => "172.30.0.9" });
    await sendAnalytics(SUMMARY, d);
    expect(d.fetchImpl).toHaveBeenCalledOnce();
    expect(String(d.fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://collector.internal.test:8787/v1/usage",
    );
  });

  it("does not follow a redirect", async () => {
    const d = deps({
      fetchImpl: vi.fn(
        async (_url: unknown, _init?: unknown) =>
          new Response(null, {
            status: 302,
            headers: { location: "https://elsewhere.example.test/" },
          }),
      ),
    });
    await sendAnalytics(SUMMARY, d);
    expect(d.fetchImpl).toHaveBeenCalledOnce();
    expect(d.onSent).not.toHaveBeenCalled();
  });
});
