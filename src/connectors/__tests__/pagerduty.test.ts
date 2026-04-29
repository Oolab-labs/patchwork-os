import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("pagerduty token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-pagerduty-${Date.now()}`);
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
    delete process.env.PAGERDUTY_TOKEN;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns env var without reading storage", async () => {
    process.env.PAGERDUTY_TOKEN = "pd-key-123";
    const { loadTokens } = await import("../pagerduty.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.token).toBe("pd-key-123");
  });

  it("loadTokens returns null when no env and no stored token", async () => {
    const { loadTokens } = await import("../pagerduty.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../pagerduty.js");
    const tokens = {
      token: "pd-secret-key",
      userEmail: "ops@example.com",
      userName: "Ops Bot",
      connected_at: "2026-04-29T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      token: "pd-secret-key",
      userEmail: "ops@example.com",
    });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../pagerduty.js");
    expect(() => clearTokens()).not.toThrow();
  });
});

describe("PagerDutyConnector.healthCheck", () => {
  it("returns ok:true when API responds 200", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ user: { name: "Ops", email: "ops@example.com" } }),
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { PagerDutyConnector } = await import("../pagerduty.js");
    const conn = new PagerDutyConnector();
    (conn as unknown as { tokens: object }).tokens = {
      token: "good",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "good", scopes: [] });

    const result = await conn.healthCheck();
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with auth_expired when API responds 401", async () => {
    const fakeResponse = {
      ok: false,
      status: 401,
      headers: { get: () => null },
    };
    // Make instanceof Response true via prototype manipulation
    Object.setPrototypeOf(fakeResponse, Response.prototype);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse) as unknown as typeof fetch;

    vi.resetModules();
    const { PagerDutyConnector } = await import("../pagerduty.js");
    const conn = new PagerDutyConnector();
    (conn as unknown as { tokens: object }).tokens = {
      token: "bad",
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
    expect(result.error?.code).toBe("auth_expired");
  });
});

describe("PagerDutyConnector.listIncidents", () => {
  it("includes status filter in query string", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ incidents: [] }),
      headers: { get: () => null },
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    vi.resetModules();
    const { PagerDutyConnector } = await import("../pagerduty.js");
    const conn = new PagerDutyConnector();
    (conn as unknown as { tokens: object }).tokens = {
      token: "k",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "k", scopes: [] });

    await conn.listIncidents({ statuses: ["triggered", "acknowledged"] });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("statuses%5B%5D=triggered");
    expect(url).toContain("statuses%5B%5D=acknowledged");
  });
});

describe("PagerDutyConnector.getIncident", () => {
  it("translates 404 → not_found error code", async () => {
    const fakeResponse = {
      ok: false,
      status: 404,
      headers: { get: () => null },
    };
    Object.setPrototypeOf(fakeResponse, Response.prototype);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse) as unknown as typeof fetch;

    vi.resetModules();
    const { PagerDutyConnector } = await import("../pagerduty.js");
    const conn = new PagerDutyConnector();
    (conn as unknown as { tokens: object }).tokens = {
      token: "k",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "k", scopes: [] });

    // not_found is non-retryable so the connector throws once apiCall returns
    // the error. The thrown message is `normalizeError(...).message`.
    await expect(conn.getIncident("PXXX")).rejects.toThrow(/not found/i);
  });
});

describe("handlePagerDutyConnect", () => {
  it("returns 400 when token missing", async () => {
    vi.resetModules();
    const { handlePagerDutyConnect } = await import("../pagerduty.js");
    const result = await handlePagerDutyConnect(JSON.stringify({}));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 on invalid JSON", async () => {
    vi.resetModules();
    const { handlePagerDutyConnect } = await import("../pagerduty.js");
    const result = await handlePagerDutyConnect("not-json");
    expect(result.status).toBe(400);
  });

  it("returns 401 when PagerDuty rejects credentials", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handlePagerDutyConnect } = await import("../pagerduty.js");
    const result = await handlePagerDutyConnect(
      JSON.stringify({ token: "bad" }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 and stores tokens on success", async () => {
    const tmpDir2 = join(
      os.tmpdir(),
      `patchwork-pagerduty-connect-${Date.now()}`,
    );
    const pHome = join(tmpDir2, ".patchwork");
    mkdirSync(join(pHome, "tokens"), { recursive: true });
    process.env.PATCHWORK_HOME = pHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        user: { name: "Ops", email: "ops@example.com" },
      }),
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handlePagerDutyConnect, loadTokens } = await import(
      "../pagerduty.js"
    );
    const result = await handlePagerDutyConnect(
      JSON.stringify({ token: "good-key" }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.userEmail).toBe("ops@example.com");

    const stored = loadTokens();
    expect(stored?.token).toBe("good-key");

    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("handlePagerDutyTest", () => {
  it("returns 400 when not connected", async () => {
    vi.resetModules();
    const { handlePagerDutyTest } = await import("../pagerduty.js");
    const result = await handlePagerDutyTest();
    expect(result.status).toBe(400);
  });
});

describe("handlePagerDutyDisconnect", () => {
  it("returns 200 always", async () => {
    vi.resetModules();
    const { handlePagerDutyDisconnect } = await import("../pagerduty.js");
    const result = handlePagerDutyDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
