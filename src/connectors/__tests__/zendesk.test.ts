import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("zendesk token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-zendesk-${Date.now()}`);
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
    delete process.env.ZENDESK_API_TOKEN;
    delete process.env.ZENDESK_EMAIL;
    delete process.env.ZENDESK_SUBDOMAIN;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns env vars without reading storage", async () => {
    process.env.ZENDESK_API_TOKEN = "tok123";
    process.env.ZENDESK_EMAIL = "dev@acme.com";
    process.env.ZENDESK_SUBDOMAIN = "acme";
    const { loadTokens } = await import("../zendesk.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.apiToken).toBe("tok123");
    expect(tokens!.email).toBe("dev@acme.com");
    expect(tokens!.subdomain).toBe("acme");
  });

  it("loadTokens returns null when no env and no stored token", async () => {
    const { loadTokens } = await import("../zendesk.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../zendesk.js");
    const tokens = {
      apiToken: "mytoken",
      email: "user@acme.com",
      subdomain: "acme",
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({ apiToken: "mytoken", subdomain: "acme" });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../zendesk.js");
    expect(() => clearTokens()).not.toThrow();
  });
});

describe("ZendeskConnector.healthCheck", () => {
  it("returns ok:true when API responds 200", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: 1, name: "Admin" } }),
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { ZendeskConnector } = await import("../zendesk.js");
    const conn = new ZendeskConnector();
    const fakeTokens = {
      apiToken: "t",
      email: "dev@acme.com",
      subdomain: "acme",
      connected_at: new Date().toISOString(),
    };
    (conn as unknown as { tokens: object }).tokens = fakeTokens;
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "t", scopes: [] });

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
    const { ZendeskConnector } = await import("../zendesk.js");
    const conn = new ZendeskConnector();
    (conn as unknown as { tokens: object }).tokens = {
      apiToken: "bad",
      email: "dev@acme.com",
      subdomain: "acme",
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

describe("handleZendeskConnect", () => {
  it("returns 400 when apiToken missing", async () => {
    vi.resetModules();
    const { handleZendeskConnect } = await import("../zendesk.js");
    const result = await handleZendeskConnect(
      JSON.stringify({ email: "x@y.com", subdomain: "acme" }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 when email missing", async () => {
    vi.resetModules();
    const { handleZendeskConnect } = await import("../zendesk.js");
    const result = await handleZendeskConnect(
      JSON.stringify({ apiToken: "tok", subdomain: "acme" }),
    );
    expect(result.status).toBe(400);
  });

  it("returns 400 when subdomain missing", async () => {
    vi.resetModules();
    const { handleZendeskConnect } = await import("../zendesk.js");
    const result = await handleZendeskConnect(
      JSON.stringify({ apiToken: "tok", email: "dev@acme.com" }),
    );
    expect(result.status).toBe(400);
  });

  it("returns 400 on invalid JSON", async () => {
    vi.resetModules();
    const { handleZendeskConnect } = await import("../zendesk.js");
    const result = await handleZendeskConnect("not-json");
    expect(result.status).toBe(400);
  });

  it("strips .zendesk.com suffix from subdomain", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleZendeskConnect } = await import("../zendesk.js");
    await handleZendeskConnect(
      JSON.stringify({
        apiToken: "tok",
        email: "dev@acme.com",
        subdomain: "acme.zendesk.com",
      }),
    );
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(url).toContain("acme.zendesk.com/api/v2/users/me");
    expect(url).not.toContain("acme.zendesk.com.zendesk.com");
  });

  it("returns 401 when Zendesk rejects credentials", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleZendeskConnect } = await import("../zendesk.js");
    const result = await handleZendeskConnect(
      JSON.stringify({
        apiToken: "bad",
        email: "dev@acme.com",
        subdomain: "acme",
      }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 and stores tokens on success", async () => {
    const tmpDir2 = join(
      os.tmpdir(),
      `patchwork-zendesk-connect-${Date.now()}`,
    );
    const pHome = join(tmpDir2, ".patchwork");
    mkdirSync(join(pHome, "tokens"), { recursive: true });
    process.env.PATCHWORK_HOME = pHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ user: { name: "Dev User", email: "dev@acme.com" } }),
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleZendeskConnect, loadTokens } = await import("../zendesk.js");
    const result = await handleZendeskConnect(
      JSON.stringify({
        apiToken: "goodtoken",
        email: "dev@acme.com",
        subdomain: "acme",
      }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.subdomain).toBe("acme");
    expect(body.user).toBe("Dev User");

    const stored = loadTokens();
    expect(stored?.apiToken).toBe("goodtoken");

    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("handleZendeskTest", () => {
  it("returns 400 when not connected", async () => {
    vi.resetModules();
    const { handleZendeskTest } = await import("../zendesk.js");
    const result = await handleZendeskTest();
    expect(result.status).toBe(400);
  });
});

describe("handleZendeskDisconnect", () => {
  it("returns 200 always", async () => {
    vi.resetModules();
    const { handleZendeskDisconnect } = await import("../zendesk.js");
    const result = handleZendeskDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
