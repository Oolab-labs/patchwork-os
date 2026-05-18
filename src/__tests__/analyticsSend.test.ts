import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function makeFetchSpy(status = 204) {
  return vi.fn<typeof fetch>(async () => new Response(null, { status }));
}

async function importFresh(env: Record<string, string | undefined>) {
  for (const k of ["PATCHWORK_ANALYTICS_ENDPOINT", "PATCHWORK_ANALYTICS_KEY"]) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  vi.doMock("../analyticsPrefs.js", () => ({ recordAnalyticsSent: vi.fn() }));
  return await import("../analyticsSend.js");
}

describe("sendAnalytics endpoint resolution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to the upstream endpoint when no override is set", async () => {
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await importFresh({});
    await mod.sendAnalytics({} as never);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://analytics.claude-ide-bridge.dev/v1/usage",
    );
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(
      (init?.headers as Record<string, string> | undefined)?.[
        "X-Analytics-Key"
      ],
    ).toBeUndefined();
  });

  it("honors PATCHWORK_ANALYTICS_ENDPOINT and sends X-Analytics-Key when set", async () => {
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await importFresh({
      PATCHWORK_ANALYTICS_ENDPOINT:
        "https://analytics.patchworkos.com/v1/usage",
      PATCHWORK_ANALYTICS_KEY: "sekret",
    });
    await mod.sendAnalytics({} as never);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://analytics.patchworkos.com/v1/usage",
    );
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(
      (init?.headers as Record<string, string> | undefined)?.[
        "X-Analytics-Key"
      ],
    ).toBe("sekret");
  });

  it("falls back to default when override is not a valid URL", async () => {
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await importFresh({
      PATCHWORK_ANALYTICS_ENDPOINT: "not a url",
    });
    await mod.sendAnalytics({} as never);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://analytics.claude-ide-bridge.dev/v1/usage",
    );
  });

  it("falls back to default when override uses a non-http(s) scheme", async () => {
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await importFresh({
      PATCHWORK_ANALYTICS_ENDPOINT: "file:///etc/passwd",
    });
    await mod.sendAnalytics({} as never);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://analytics.claude-ide-bridge.dev/v1/usage",
    );
  });

  it("swallows fetch errors silently", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const mod = await importFresh({});
    await expect(mod.sendAnalytics({} as never)).resolves.toBeUndefined();
  });
});
