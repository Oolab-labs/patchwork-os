import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("confluence token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-confluence-${Date.now()}`);
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
    vi.restoreAllMocks();
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.CONFLUENCE_API_TOKEN;
    delete process.env.CONFLUENCE_INSTANCE_URL;
    delete process.env.CONFLUENCE_EMAIL;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns env vars without reading storage", async () => {
    process.env.CONFLUENCE_API_TOKEN = "env_token";
    process.env.CONFLUENCE_INSTANCE_URL = "https://acme.atlassian.net/";
    process.env.CONFLUENCE_EMAIL = "dev@acme.com";
    const { loadTokens } = await import("../confluence.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.accessToken).toBe("env_token");
    expect(tokens!.email).toBe("dev@acme.com");
    expect(tokens!.instanceUrl).toBe("https://acme.atlassian.net"); // trailing slash stripped
  });

  it("loadTokens returns null when no env and no stored token", async () => {
    const { loadTokens } = await import("../confluence.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../confluence.js");
    const tokens = {
      accessToken: "mytoken",
      email: "user@acme.com",
      instanceUrl: "https://acme.atlassian.net",
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      accessToken: "mytoken",
      email: "user@acme.com",
    });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../confluence.js");
    expect(() => clearTokens()).not.toThrow();
  });
});

describe("ConfluenceConnector.healthCheck", () => {
  it("returns ok:true when API responds 200", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { ConfluenceConnector } = await import("../confluence.js");
    const conn = new ConfluenceConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "t", scopes: [] });
    // Inject tokens directly so buildHeaders works
    (conn as unknown as { tokens: object }).tokens = {
      accessToken: "t",
      email: "dev@acme.com",
      instanceUrl: "https://acme.atlassian.net",
      connected_at: new Date().toISOString(),
    };

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
    const { ConfluenceConnector } = await import("../confluence.js");
    const conn = new ConfluenceConnector();
    (conn as unknown as { tokens: object }).tokens = {
      accessToken: "bad",
      email: "dev@acme.com",
      instanceUrl: "https://acme.atlassian.net",
      connected_at: new Date().toISOString(),
    };

    const result = await conn.healthCheck();
    expect(result.ok).toBe(false);
  });
});

describe("handleConfluenceConnect", () => {
  it("returns 400 when token missing", async () => {
    vi.resetModules();
    const { handleConfluenceConnect } = await import("../confluence.js");
    const result = await handleConfluenceConnect(
      JSON.stringify({
        email: "x@y.com",
        instanceUrl: "https://acme.atlassian.net",
      }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 when email missing", async () => {
    vi.resetModules();
    const { handleConfluenceConnect } = await import("../confluence.js");
    const result = await handleConfluenceConnect(
      JSON.stringify({
        token: "tok",
        instanceUrl: "https://acme.atlassian.net",
      }),
    );
    expect(result.status).toBe(400);
  });

  it("returns 400 on invalid JSON", async () => {
    vi.resetModules();
    const { handleConfluenceConnect } = await import("../confluence.js");
    const result = await handleConfluenceConnect("not-json");
    expect(result.status).toBe(400);
  });

  describe("SSRF guard on instanceUrl (audit 2026-05-17)", () => {
    // Isolated PATCHWORK_HOME so the positive case ("accepts
    // atlassian.net") doesn't leak tokens onto the runner's real $HOME
    // and break `handleConfluenceTest("returns 400 when not
    // connected")`. CI repro: PR #577.
    const ssrfTmpDir = join(
      os.tmpdir(),
      `patchwork-confluence-ssrf-${Date.now()}`,
    );
    const ssrfHome = join(ssrfTmpDir, ".patchwork");

    beforeEach(() => {
      mkdirSync(join(ssrfHome, "tokens"), { recursive: true });
      process.env.PATCHWORK_HOME = ssrfHome;
      process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    });

    afterEach(() => {
      delete process.env.PATCHWORK_HOME;
      delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
      if (existsSync(ssrfTmpDir)) {
        rmSync(ssrfTmpDir, { recursive: true, force: true });
      }
    });

    it("rejects http://169.254.169.254 metadata service without hitting fetch", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      vi.resetModules();
      const { handleConfluenceConnect } = await import("../confluence.js");
      const result = await handleConfluenceConnect(
        JSON.stringify({
          token: "x",
          email: "u@e.com",
          instanceUrl: "http://169.254.169.254/admin",
        }),
      );
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body).error).toMatch(/atlassian\.net/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects http://127.0.0.1", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      vi.resetModules();
      const { handleConfluenceConnect } = await import("../confluence.js");
      const result = await handleConfluenceConnect(
        JSON.stringify({
          token: "x",
          email: "u@e.com",
          instanceUrl: "http://127.0.0.1/wiki",
        }),
      );
      expect(result.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects https on non-Atlassian host", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      vi.resetModules();
      const { handleConfluenceConnect } = await import("../confluence.js");
      const result = await handleConfluenceConnect(
        JSON.stringify({
          token: "x",
          email: "u@e.com",
          instanceUrl: "https://attacker.example.com",
        }),
      );
      expect(result.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects subdomain-confusion (attacker.atlassian.net.evil.com)", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      vi.resetModules();
      const { handleConfluenceConnect } = await import("../confluence.js");
      const result = await handleConfluenceConnect(
        JSON.stringify({
          token: "x",
          email: "u@e.com",
          instanceUrl: "https://atlassian.net.evil.com",
        }),
      );
      expect(result.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts https://<workspace>.atlassian.net", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
      }) as unknown as typeof fetch;
      vi.resetModules();
      const { handleConfluenceConnect } = await import("../confluence.js");
      const result = await handleConfluenceConnect(
        JSON.stringify({
          token: "x",
          email: "u@e.com",
          instanceUrl: "https://acme.atlassian.net",
        }),
      );
      // NOT 400 — would be 200 (success) or 500 (token storage mock failure)
      expect(result.status).not.toBe(400);
    });
  });

  it("returns 401 when Confluence rejects credentials", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleConfluenceConnect } = await import("../confluence.js");
    const result = await handleConfluenceConnect(
      JSON.stringify({
        token: "bad",
        email: "dev@acme.com",
        instanceUrl: "https://acme.atlassian.net",
      }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 and stores tokens on success", async () => {
    const tmpDir2 = join(
      os.tmpdir(),
      `patchwork-confluence-connect-${Date.now()}`,
    );
    const pHome = join(tmpDir2, ".patchwork");
    mkdirSync(join(pHome, "tokens"), { recursive: true });
    process.env.PATCHWORK_HOME = pHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleConfluenceConnect, loadTokens } = await import(
      "../confluence.js"
    );
    const result = await handleConfluenceConnect(
      JSON.stringify({
        token: "goodtoken",
        email: "dev@acme.com",
        instanceUrl: "https://acme.atlassian.net",
      }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.instanceUrl).toBe("https://acme.atlassian.net");

    const stored = loadTokens();
    expect(stored?.accessToken).toBe("goodtoken");

    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("handleConfluenceTest", () => {
  it("returns 400 when not connected", async () => {
    vi.resetModules();
    const { handleConfluenceTest } = await import("../confluence.js");
    const result = await handleConfluenceTest();
    expect(result.status).toBe(400);
  });
});

describe("handleConfluenceDisconnect", () => {
  it("returns 200 always", async () => {
    vi.resetModules();
    const { handleConfluenceDisconnect } = await import("../confluence.js");
    const result = handleConfluenceDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
