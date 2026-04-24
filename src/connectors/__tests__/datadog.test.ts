import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("datadog token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-datadog-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.DATADOG_API_KEY;
    delete process.env.DATADOG_APP_KEY;
    delete process.env.DATADOG_SITE;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns env vars without reading storage", async () => {
    process.env.DATADOG_API_KEY = "api-key-123";
    process.env.DATADOG_APP_KEY = "app-key-456";
    process.env.DATADOG_SITE = "datadoghq.eu";
    const { loadTokens } = await import("../datadog.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.apiKey).toBe("api-key-123");
    expect(tokens!.appKey).toBe("app-key-456");
    expect(tokens!.site).toBe("datadoghq.eu");
  });

  it("loadTokens returns null when no env and no stored token", async () => {
    const { loadTokens } = await import("../datadog.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../datadog.js");
    const tokens = {
      apiKey: "myapikey",
      appKey: "myappkey",
      site: "datadoghq.com",
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({ apiKey: "myapikey", appKey: "myappkey" });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../datadog.js");
    expect(() => clearTokens()).not.toThrow();
  });
});

describe("DatadogConnector.healthCheck", () => {
  it("returns ok:true when API responds 200", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ valid: true }),
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { DatadogConnector } = await import("../datadog.js");
    const conn = new DatadogConnector();
    const fakeTokens = {
      apiKey: "ak",
      appKey: "apk",
      site: "datadoghq.com",
      connected_at: new Date().toISOString(),
    };
    (conn as unknown as { tokens: object }).tokens = fakeTokens;
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "ak", scopes: [] });

    const result = await conn.healthCheck();
    expect(result.ok).toBe(true);
  });

  it("returns ok:false when API responds 401", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { DatadogConnector } = await import("../datadog.js");
    const conn = new DatadogConnector();
    (conn as unknown as { tokens: object }).tokens = {
      apiKey: "bad",
      appKey: "bad",
      site: "datadoghq.com",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "bad", scopes: [] });

    const result = await conn.healthCheck();
    expect(result.ok).toBe(false);
  });
});

describe("handleDatadogConnect", () => {
  it("returns 400 when apiKey missing", async () => {
    vi.resetModules();
    const { handleDatadogConnect } = await import("../datadog.js");
    const result = await handleDatadogConnect(
      JSON.stringify({ appKey: "appkey" }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 when appKey missing", async () => {
    vi.resetModules();
    const { handleDatadogConnect } = await import("../datadog.js");
    const result = await handleDatadogConnect(
      JSON.stringify({ apiKey: "apikey" }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 on invalid JSON", async () => {
    vi.resetModules();
    const { handleDatadogConnect } = await import("../datadog.js");
    const result = await handleDatadogConnect("not-json");
    expect(result.status).toBe(400);
  });

  it("returns 401 when Datadog rejects credentials", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleDatadogConnect } = await import("../datadog.js");
    const result = await handleDatadogConnect(
      JSON.stringify({ apiKey: "bad", appKey: "bad" }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 and stores tokens on success", async () => {
    const tmpDir2 = join(
      os.tmpdir(),
      `patchwork-datadog-connect-${Date.now()}`,
    );
    const pHome = join(tmpDir2, ".patchwork");
    mkdirSync(join(pHome, "tokens"), { recursive: true });
    process.env.PATCHWORK_HOME = pHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ valid: true }),
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleDatadogConnect, loadTokens } = await import("../datadog.js");
    const result = await handleDatadogConnect(
      JSON.stringify({ apiKey: "good-api-key", appKey: "good-app-key" }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.site).toBe("datadoghq.com");

    const stored = loadTokens();
    expect(stored?.apiKey).toBe("good-api-key");
    expect(stored?.appKey).toBe("good-app-key");

    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("handleDatadogTest", () => {
  it("returns 400 when not connected", async () => {
    vi.resetModules();
    const { handleDatadogTest } = await import("../datadog.js");
    const result = await handleDatadogTest();
    expect(result.status).toBe(400);
  });
});

describe("handleDatadogDisconnect", () => {
  it("returns 200 always", async () => {
    vi.resetModules();
    const { handleDatadogDisconnect } = await import("../datadog.js");
    const result = handleDatadogDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
