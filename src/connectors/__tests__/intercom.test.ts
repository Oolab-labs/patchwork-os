import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("intercom token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-intercom-${Date.now()}`);
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
    delete process.env.INTERCOM_ACCESS_TOKEN;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns env vars without reading storage", async () => {
    process.env.INTERCOM_ACCESS_TOKEN = "tok123";
    const { loadTokens } = await import("../intercom.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.accessToken).toBe("tok123");
  });

  it("loadTokens returns null when no env and no stored token", async () => {
    const { loadTokens } = await import("../intercom.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../intercom.js");
    const tokens = {
      accessToken: "mytoken",
      workspaceName: "Acme Support",
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      accessToken: "mytoken",
      workspaceName: "Acme Support",
    });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../intercom.js");
    expect(() => clearTokens()).not.toThrow();
  });
});

describe("IntercomConnector.healthCheck", () => {
  it("returns ok:true when API responds 200", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ type: "admin", id: "1", name: "Admin" }),
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { IntercomConnector } = await import("../intercom.js");
    const conn = new IntercomConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "tok", scopes: [] });

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
    const { IntercomConnector } = await import("../intercom.js");
    const conn = new IntercomConnector();
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

describe("handleIntercomConnect", () => {
  it("returns 400 when accessToken missing", async () => {
    vi.resetModules();
    const { handleIntercomConnect } = await import("../intercom.js");
    const result = await handleIntercomConnect(JSON.stringify({}));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 on invalid JSON", async () => {
    vi.resetModules();
    const { handleIntercomConnect } = await import("../intercom.js");
    const result = await handleIntercomConnect("not-json");
    expect(result.status).toBe(400);
  });

  it("returns 401 when Intercom rejects credentials", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleIntercomConnect } = await import("../intercom.js");
    const result = await handleIntercomConnect(
      JSON.stringify({ accessToken: "badtoken" }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 and stores token on success", async () => {
    const tmpDir2 = join(
      os.tmpdir(),
      `patchwork-intercom-connect-${Date.now()}`,
    );
    const pHome = join(tmpDir2, ".patchwork");
    mkdirSync(join(pHome, "tokens"), { recursive: true });
    process.env.PATCHWORK_HOME = pHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        type: "admin",
        id: "42",
        name: "Dev Admin",
        app: { name: "Acme Support" },
      }),
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleIntercomConnect, loadTokens } = await import(
      "../intercom.js"
    );
    const result = await handleIntercomConnect(
      JSON.stringify({ accessToken: "goodtoken" }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.workspaceName).toBe("Acme Support");

    const stored = loadTokens();
    expect(stored?.accessToken).toBe("goodtoken");

    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("handleIntercomTest", () => {
  it("returns 400 when not connected", async () => {
    vi.resetModules();
    const { handleIntercomTest } = await import("../intercom.js");
    const result = await handleIntercomTest();
    expect(result.status).toBe(400);
  });
});

describe("handleIntercomDisconnect", () => {
  it("returns 200 always", async () => {
    vi.resetModules();
    const { handleIntercomDisconnect } = await import("../intercom.js");
    const result = handleIntercomDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
