import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpRoot: string;

function makeFetchSpy(status = 204) {
  return vi.fn<typeof fetch>(async () => new Response(null, { status }));
}

async function importFresh(
  env: Record<string, string | undefined>,
  configFile?: { endpoint?: string; key?: string },
) {
  for (const k of ["PATCHWORK_ANALYTICS_ENDPOINT", "PATCHWORK_ANALYTICS_KEY"]) {
    delete process.env[k];
  }
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asend-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", tmpRoot);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else vi.stubEnv(k, v);
  }
  if (configFile) {
    const dir = path.join(tmpRoot, "ide");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "analytics-config.json"),
      JSON.stringify(configFile),
      { mode: 0o600 },
    );
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
    vi.unstubAllEnvs();
    if (tmpRoot) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
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

  it("reads endpoint and key from config file when env is unset", async () => {
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await importFresh(
      {},
      { endpoint: "https://collector.example.com/u", key: "from-file" },
    );
    await mod.sendAnalytics({} as never);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://collector.example.com/u");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(
      (init?.headers as Record<string, string> | undefined)?.[
        "X-Analytics-Key"
      ],
    ).toBe("from-file");
  });

  it("env overrides the config file (env > file > default)", async () => {
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await importFresh(
      {
        PATCHWORK_ANALYTICS_ENDPOINT: "https://env.example.com/u",
        PATCHWORK_ANALYTICS_KEY: "from-env",
      },
      { endpoint: "https://collector.example.com/u", key: "from-file" },
    );
    await mod.sendAnalytics({} as never);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://env.example.com/u");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(
      (init?.headers as Record<string, string> | undefined)?.[
        "X-Analytics-Key"
      ],
    ).toBe("from-env");
  });

  it("env endpoint + file key compose when each is set separately", async () => {
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await importFresh(
      { PATCHWORK_ANALYTICS_ENDPOINT: "https://env.example.com/u" },
      { key: "from-file" },
    );
    await mod.sendAnalytics({} as never);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://env.example.com/u");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(
      (init?.headers as Record<string, string> | undefined)?.[
        "X-Analytics-Key"
      ],
    ).toBe("from-file");
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
