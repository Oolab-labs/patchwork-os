import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("vercel token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-vercel-${Date.now()}`);
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
    delete process.env.VERCEL_ACCESS_TOKEN;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns VERCEL_ACCESS_TOKEN env var without reading storage", async () => {
    process.env.VERCEL_ACCESS_TOKEN = "vercel_tok_abc123";
    const { loadTokens } = await import("../vercel.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.accessToken).toBe("vercel_tok_abc123");
  });

  it("loadTokens returns null when no env and no stored token", async () => {
    const { loadTokens } = await import("../vercel.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../vercel.js");
    const tokens = {
      accessToken: "vercel_tok_roundtrip",
      teamId: "team_abc",
      username: "testuser",
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      accessToken: "vercel_tok_roundtrip",
      teamId: "team_abc",
      username: "testuser",
    });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../vercel.js");
    expect(() => clearTokens()).not.toThrow();
  });
});

function makeFakeTokens(teamId?: string) {
  return {
    accessToken: "tok_test",
    ...(teamId ? { teamId } : {}),
    connected_at: new Date().toISOString(),
  };
}

async function makeConnector(teamId?: string) {
  vi.resetModules();
  const { VercelConnector } = await import("../vercel.js");
  const conn = new VercelConnector();
  const fakeTokens = makeFakeTokens(teamId);
  (conn as unknown as { tokens: object }).tokens = fakeTokens;
  vi.spyOn(
    conn as unknown as {
      authenticate: () => Promise<{ token: string; scopes: string[] }>;
    },
    "authenticate",
  ).mockResolvedValue({ token: fakeTokens.accessToken, scopes: [] });
  return conn;
}

describe("VercelConnector.listProjects", () => {
  it("returns project array from API", async () => {
    const mockProjects = [
      {
        id: "prj_1",
        name: "my-app",
        framework: "nextjs",
        latestDeployments: [],
      },
    ];

    const conn = await makeConnector();
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ projects: mockProjects }),
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    const result = await conn.listProjects();
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("prj_1");
    expect(result[0]?.name).toBe("my-app");
  });

  it("appends teamId to query string when set", async () => {
    const conn = await makeConnector("team_xyz");

    let capturedUrl = "";
    global.fetch = vi.fn().mockImplementationOnce((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ projects: [] }),
        headers: { get: () => null },
      });
    }) as unknown as typeof fetch;

    await conn.listProjects();
    expect(capturedUrl).toContain("teamId=team_xyz");
  });

  it("throws when API returns 401", async () => {
    const conn = await makeConnector();
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    await expect(conn.listProjects()).rejects.toThrow();
  });
});

describe("VercelConnector.getDeployment", () => {
  it("returns deployment detail from API", async () => {
    const mockDeployment = {
      id: "dpl_abc",
      uid: "dpl_abc",
      name: "my-app",
      url: "my-app-abc.vercel.app",
      state: "READY",
      createdAt: 1700000000000,
      target: "production",
    };

    const conn = await makeConnector();
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockDeployment,
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    const result = await conn.getDeployment("dpl_abc");
    expect(result.id).toBe("dpl_abc");
    expect(result.state).toBe("READY");
    expect(result.url).toBe("my-app-abc.vercel.app");
  });

  it("throws on 404", async () => {
    const conn = await makeConnector();
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    await expect(conn.getDeployment("dpl_nonexistent")).rejects.toThrow();
  });
});

describe("VercelConnector.healthCheck", () => {
  it("returns ok:true when /v2/user responds 200", async () => {
    const conn = await makeConnector();
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ user: { username: "testuser" } }),
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    const result = await conn.healthCheck();
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with auth_expired when 401", async () => {
    const conn = await makeConnector();
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    const result = await conn.healthCheck();
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when not connected", async () => {
    vi.resetModules();
    const { VercelConnector } = await import("../vercel.js");
    const conn = new VercelConnector();
    // tokens stays null

    const result = await conn.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("auth_expired");
  });
});

describe("verifyVercelWebhook", () => {
  it("returns true for a valid signature", async () => {
    vi.resetModules();
    const { verifyVercelWebhook } = await import("../vercel.js");
    const secret = "my-client-secret";
    const body = '{"type":"deployment.created"}';
    const sig = createHmac("sha1", secret).update(body).digest("hex");
    expect(verifyVercelWebhook(body, sig, secret)).toBe(true);
  });

  it("returns false for an invalid signature", async () => {
    vi.resetModules();
    const { verifyVercelWebhook } = await import("../vercel.js");
    const secret = "my-client-secret";
    const body = '{"type":"deployment.created"}';
    expect(verifyVercelWebhook(body, "deadbeef00112233", secret)).toBe(false);
  });

  it("returns false when signature has wrong length", async () => {
    vi.resetModules();
    const { verifyVercelWebhook } = await import("../vercel.js");
    expect(verifyVercelWebhook("body", "aaff", "secret")).toBe(false);
  });

  it("works with Buffer rawBody", async () => {
    vi.resetModules();
    const { verifyVercelWebhook } = await import("../vercel.js");
    const secret = "buf-secret";
    const bodyStr = '{"event":"test"}';
    const bodyBuf = Buffer.from(bodyStr);
    const sig = createHmac("sha1", secret).update(bodyBuf).digest("hex");
    expect(verifyVercelWebhook(bodyBuf, sig, secret)).toBe(true);
  });
});

describe("handleVercelConnect", () => {
  it("returns 400 when accessToken missing", async () => {
    vi.resetModules();
    const { handleVercelConnect } = await import("../vercel.js");
    const result = await handleVercelConnect(JSON.stringify({}));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 on invalid JSON", async () => {
    vi.resetModules();
    const { handleVercelConnect } = await import("../vercel.js");
    const result = await handleVercelConnect("not-json");
    expect(result.status).toBe(400);
  });

  it("returns 401 when Vercel rejects credentials", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleVercelConnect } = await import("../vercel.js");
    const result = await handleVercelConnect(
      JSON.stringify({ accessToken: "bad_token" }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 and stores username on success", async () => {
    const tmpDir2 = join(os.tmpdir(), `patchwork-vercel-connect-${Date.now()}`);
    const pHome = join(tmpDir2, ".patchwork");
    mkdirSync(join(pHome, "tokens"), { recursive: true });
    process.env.PATCHWORK_HOME = pHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ user: { username: "johndoe", name: "John Doe" } }),
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleVercelConnect, loadTokens } = await import("../vercel.js");
    const result = await handleVercelConnect(
      JSON.stringify({ accessToken: "tok_good", teamId: "team_123" }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.username).toBe("johndoe");
    expect(body.teamId).toBe("team_123");

    const stored = loadTokens();
    expect(stored?.accessToken).toBe("tok_good");
    expect(stored?.teamId).toBe("team_123");

    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("handleVercelTest", () => {
  it("returns 400 when not connected", async () => {
    vi.resetModules();
    const { handleVercelTest } = await import("../vercel.js");
    const result = await handleVercelTest();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });
});

describe("handleVercelDisconnect", () => {
  it("returns 200 always", async () => {
    vi.resetModules();
    const { handleVercelDisconnect } = await import("../vercel.js");
    const result = handleVercelDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
