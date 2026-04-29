import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Token storage ────────────────────────────────────────────────────────────

describe("asana token storage", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-asana-${Date.now()}`);
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
    delete process.env.ASANA_CLIENT_ID;
    delete process.env.ASANA_CLIENT_SECRET;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns null when no token stored", async () => {
    const { loadTokens } = await import("../asana.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../asana.js");
    const tokens = {
      access_token: "asana-access-123",
      refresh_token: "asana-refresh-123",
      expires_at: Date.now() + 3600 * 1000,
      scope: "default",
      username: "Patchwork Bot",
      user_gid: "1234567890",
      email: "bot@example.com",
      connected_at: "2026-04-29T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      access_token: "asana-access-123",
      refresh_token: "asana-refresh-123",
      username: "Patchwork Bot",
      email: "bot@example.com",
    });
  });

  it("clearTokens does not throw when no file exists", async () => {
    const { clearTokens } = await import("../asana.js");
    expect(() => clearTokens()).not.toThrow();
  });

  it("isConnected reflects stored token presence", async () => {
    const { isConnected, saveTokens, clearTokens } = await import(
      "../asana.js"
    );
    expect(isConnected()).toBe(false);
    saveTokens({
      access_token: "x",
      connected_at: new Date().toISOString(),
    });
    expect(isConnected()).toBe(true);
    clearTokens();
    expect(isConnected()).toBe(false);
  });
});

// ── healthCheck ──────────────────────────────────────────────────────────────

describe("AsanaConnector.healthCheck", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns ok:true when API responds 200", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: { gid: "u1", name: "Patchwork" } }),
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
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
    Object.setPrototypeOf(fakeResponse, Response.prototype);
    global.fetch = vi
      .fn()
      .mockResolvedValue(fakeResponse) as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
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

// ── listWorkspaces ───────────────────────────────────────────────────────────

describe("AsanaConnector.listWorkspaces", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("unwraps `data` and returns the workspace array", async () => {
    const workspaces = [
      { gid: "w1", name: "Patchwork", resource_type: "workspace" },
      { gid: "w2", name: "Other", resource_type: "workspace" },
    ];
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: workspaces }),
      clone() {
        return this;
      },
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "k", scopes: [] });

    const result = await conn.listWorkspaces();
    expect(result).toEqual(workspaces);
  });

  it("clamps limit to 100", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
      clone() {
        return this;
      },
      headers: { get: () => null },
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "k", scopes: [] });

    await conn.listWorkspaces({ limit: 999 });
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("limit=100");
  });
});

// ── listProjects ─────────────────────────────────────────────────────────────

describe("AsanaConnector.listProjects", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("rejects when workspaceGid is missing", async () => {
    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    await expect(conn.listProjects({ workspaceGid: "" })).rejects.toThrow(
      /workspaceGid/,
    );
  });

  it("passes workspace into the URL", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ gid: "p1", name: "Sprint Q2", resource_type: "project" }],
      }),
      clone() {
        return this;
      },
      headers: { get: () => null },
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "k", scopes: [] });

    const projects = await conn.listProjects({ workspaceGid: "w1" });
    expect(projects).toHaveLength(1);
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("workspace=w1");
  });
});

// ── listTasks ────────────────────────────────────────────────────────────────

describe("AsanaConnector.listTasks", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("rejects when neither projectGid nor assignee+workspace is provided", async () => {
    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    await expect(conn.listTasks({})).rejects.toThrow(/projectGid|assignee/);
    // assignee alone (without workspace) should also reject
    await expect(conn.listTasks({ assignee: "me" })).rejects.toThrow(
      /projectGid|assignee/,
    );
    // workspace alone (without assignee or project) should also reject
    await expect(conn.listTasks({ workspaceGid: "w1" })).rejects.toThrow(
      /projectGid|assignee/,
    );
  });

  it("happy path with project filter unwraps data and passes project to URL", async () => {
    const tasks = [
      { gid: "t1", name: "Fix login bug", completed: false },
      { gid: "t2", name: "Write tests", completed: true },
    ];
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: tasks }),
      clone() {
        return this;
      },
      headers: { get: () => null },
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "k", scopes: [] });

    const result = await conn.listTasks({ projectGid: "p1", limit: 10 });
    expect(result).toEqual(tasks);
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("project=p1");
    expect(url).toContain("limit=10");
  });

  it("accepts assignee + workspaceGid pair", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
      clone() {
        return this;
      },
      headers: { get: () => null },
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "k", scopes: [] });

    await conn.listTasks({ assignee: "me", workspaceGid: "w1" });
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("assignee=me");
    expect(url).toContain("workspace=w1");
  });
});

// ── 429 rate-limited with Retry-After ────────────────────────────────────────

describe("AsanaConnector 429 handling", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("normalizes 429 with Retry-After header into rate_limited", async () => {
    // Build a 429 Response stub. apiCall retries up to 2x on retryable
    // errors, so return 429 for every call to exhaust retries quickly.
    const make429 = () => {
      const r = {
        ok: false,
        status: 429,
        headers: {
          get: (k: string) => (k.toLowerCase() === "retry-after" ? "30" : null),
        },
        clone() {
          return this;
        },
        json: async () => ({}),
      };
      Object.setPrototypeOf(r, Response.prototype);
      return r;
    };
    global.fetch = vi
      .fn()
      .mockImplementation(async () => make429()) as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "k", scopes: [] });

    const result = await conn.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("rate_limited");
    expect(result.error?.message).toContain("30");
    expect(
      (result.error?.providerDetail as { retryAfter?: string })?.retryAfter,
    ).toBe("30");
  }, 30_000);
});

// ── Token refresh on 401 ─────────────────────────────────────────────────────

describe("AsanaConnector token refresh on 401", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-asana-refresh-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    process.env.ASANA_CLIENT_ID = "cid";
    process.env.ASANA_CLIENT_SECRET = "csecret";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.ASANA_CLIENT_ID;
    delete process.env.ASANA_CLIENT_SECRET;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("on 401, refreshes token and retries the API call once", async () => {
    // Three fetch calls in sequence:
    //   1) /users/me → 401 (auth_expired, retryable per Asana normalizeError)
    //   2) /-/oauth_token (refresh) → 200 with new access_token
    //   3) /users/me retry → 200
    const expired = {
      ok: false,
      status: 401,
      headers: { get: () => null },
    };
    Object.setPrototypeOf(expired, Response.prototype);

    const fetchSpy = vi
      .fn()
      // initial call: 401
      .mockResolvedValueOnce(expired)
      // refresh call: 200 with new tokens
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "default",
          token_type: "Bearer",
        }),
        headers: { get: () => null },
      })
      // retry: 200
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { gid: "u1", name: "Patchwork" } }),
        headers: { get: () => null },
      });

    global.fetch = fetchSpy as unknown as typeof fetch;

    const { AsanaConnector, saveTokens, loadTokens } = await import(
      "../asana.js"
    );
    // Pre-seed stored tokens with a refresh_token so the connector has something
    // to refresh with.
    saveTokens({
      access_token: "stale-access",
      refresh_token: "stale-refresh",
      expires_at: Date.now() + 60_000, // not yet expired by clock
      scope: "default",
      token_type: "Bearer",
      _client_id: "cid",
      _client_secret: "csecret",
      connected_at: new Date().toISOString(),
    });

    const conn = new AsanaConnector();
    const result = await conn.healthCheck();

    expect(result.ok).toBe(true);
    // Verify the three fetch calls happened in order.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const url1 = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    const url2 = String(fetchSpy.mock.calls[1]?.[0] ?? "");
    const url3 = String(fetchSpy.mock.calls[2]?.[0] ?? "");
    expect(url1).toContain("/users/me");
    expect(url2).toContain("/-/oauth_token");
    expect(url3).toContain("/users/me");

    // Stored tokens should now reflect the refreshed access_token.
    const stored = loadTokens();
    expect(stored?.access_token).toBe("new-access");
    expect(stored?.refresh_token).toBe("new-refresh");
  });
});

// ── HTTP handlers ────────────────────────────────────────────────────────────

describe("handleAsanaAuthorize", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.ASANA_CLIENT_ID;
    delete process.env.ASANA_CLIENT_SECRET;
  });

  it("returns 503 when ASANA_CLIENT_ID/SECRET are not set", async () => {
    const { handleAsanaAuthorize } = await import("../asana.js");
    const result = handleAsanaAuthorize();
    expect(result.status).toBe(503);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/ASANA_CLIENT_ID/);
  });

  it("returns 302 redirect with state when configured", async () => {
    process.env.ASANA_CLIENT_ID = "cid";
    process.env.ASANA_CLIENT_SECRET = "csecret";
    const { handleAsanaAuthorize } = await import("../asana.js");
    const result = handleAsanaAuthorize();
    expect(result.status).toBe(302);
    expect(result.redirect).toMatch(
      /^https:\/\/app\.asana\.com\/-\/oauth_authorize\?/,
    );
    const url = new URL(result.redirect ?? "");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("default");
    expect(url.searchParams.get("state")).toBeTruthy();
  });
});

describe("handleAsanaTest", () => {
  it("returns 400 when not connected", async () => {
    const tmpDir = join(os.tmpdir(), `patchwork-asana-test-${Date.now()}`);
    process.env.HOME = join(tmpDir, "home");
    process.env.PATCHWORK_HOME = join(tmpDir, "home", ".patchwork");
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(join(process.env.PATCHWORK_HOME, "tokens"), { recursive: true });
    vi.resetModules();
    const { handleAsanaTest } = await import("../asana.js");
    const result = await handleAsanaTest();
    expect(result.status).toBe(400);
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("handleAsanaDisconnect", () => {
  it("returns 200 always", async () => {
    const tmpDir = join(
      os.tmpdir(),
      `patchwork-asana-disconnect-${Date.now()}`,
    );
    process.env.HOME = join(tmpDir, "home");
    process.env.PATCHWORK_HOME = join(tmpDir, "home", ".patchwork");
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(join(process.env.PATCHWORK_HOME, "tokens"), { recursive: true });
    vi.resetModules();
    const { handleAsanaDisconnect } = await import("../asana.js");
    const result = await handleAsanaDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
