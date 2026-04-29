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

// ── writes ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal mocked-fetch Response stub the connector can read.
 * Supports `clone()` (used by attachErrorDetail) and a synthetic header bag.
 */
function makeJsonResponse(body: unknown, status = 200) {
  const r = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone() {
      return this;
    },
    headers: { get: () => null },
  };
  Object.setPrototypeOf(r, Response.prototype);
  return r;
}

function mockAuthenticate(conn: { authenticate?: unknown }) {
  vi.spyOn(
    conn as unknown as {
      authenticate: () => Promise<{ token: string; scopes: string[] }>;
    },
    "authenticate",
  ).mockResolvedValue({ token: "k", scopes: [] });
}

describe("AsanaConnector writes", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // ── createTask ─────────────────────────────────────────────────────────────

  it("createTask happy path: POSTs `{data:{...}}` and unwraps response", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      makeJsonResponse({
        data: {
          gid: "t100",
          name: "New task",
          resource_type: "task",
          completed: false,
        },
      }),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    mockAuthenticate(conn);

    const task = await conn.createTask({
      workspaceGid: "w1",
      name: "New task",
    });

    expect(task.gid).toBe("t100");
    expect(task.name).toBe("New task");

    const call = fetchSpy.mock.calls[0];
    expect(String(call?.[0])).toContain("/tasks");
    const init = call?.[1] as { method?: string; body?: string };
    expect(init?.method).toBe("POST");
    const sent = JSON.parse(init?.body ?? "{}");
    expect(sent).toEqual({
      data: { workspace: "w1", name: "New task" },
    });
  });

  it("createTask rejects when name is missing", async () => {
    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    await expect(
      conn.createTask({ workspaceGid: "w1", name: "" }),
    ).rejects.toThrow(/name/);
  });

  it("createTask rejects when workspaceGid is missing", async () => {
    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    await expect(
      conn.createTask({ workspaceGid: "", name: "x" }),
    ).rejects.toThrow(/workspaceGid/);
  });

  it("createTask only includes optional fields when provided", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse({ data: { gid: "t101", name: "Full" } }),
      );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    mockAuthenticate(conn);

    await conn.createTask({
      workspaceGid: "w1",
      name: "Full",
      projectGid: "p1",
      notes: "details",
      assigneeGid: "u1",
      dueOn: "2026-05-01",
      parentTaskGid: "t99",
    });

    const init = fetchSpy.mock.calls[0]?.[1] as { body?: string };
    const sent = JSON.parse(init?.body ?? "{}");
    expect(sent.data).toEqual({
      workspace: "w1",
      name: "Full",
      projects: ["p1"],
      notes: "details",
      assignee: "u1",
      due_on: "2026-05-01",
      parent: "t99",
    });
  });

  // ── updateTask ─────────────────────────────────────────────────────────────

  it("updateTask happy path: PUT with only provided fields, unwraps data", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      makeJsonResponse({
        data: { gid: "t1", name: "Renamed", completed: false },
      }),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    mockAuthenticate(conn);

    const task = await conn.updateTask("t1", { name: "Renamed" });

    expect(task.gid).toBe("t1");
    expect(task.name).toBe("Renamed");

    const call = fetchSpy.mock.calls[0];
    expect(String(call?.[0])).toContain("/tasks/t1");
    const init = call?.[1] as { method?: string; body?: string };
    expect(init?.method).toBe("PUT");

    const sent = JSON.parse(init?.body ?? "{}");
    // Only `name` should be present — no `undefined` keys leaked.
    expect(sent).toEqual({ data: { name: "Renamed" } });
    expect(Object.keys(sent.data)).toEqual(["name"]);
  });

  it("updateTask rejects when no update fields provided", async () => {
    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    await expect(conn.updateTask("t1", {})).rejects.toThrow(
      /at least one field/i,
    );
  });

  it("updateTask normalizes 404 into not_found error", async () => {
    const r404 = {
      ok: false,
      status: 404,
      headers: { get: () => null },
      clone() {
        return this;
      },
      json: async () => ({ errors: [{ message: "Not found" }] }),
    };
    Object.setPrototypeOf(r404, Response.prototype);
    // apiCall does not retry on 404 (retryable=false), so a single mock is enough.
    global.fetch = vi.fn().mockResolvedValue(r404) as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    mockAuthenticate(conn);

    await expect(conn.updateTask("missing", { name: "x" })).rejects.toThrow(
      /not found/i,
    );
  });

  // ── completeTask ───────────────────────────────────────────────────────────

  it("completeTask sends `completed: true` via updateTask", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      makeJsonResponse({
        data: { gid: "t1", name: "Task", completed: true },
      }),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    mockAuthenticate(conn);

    const task = await conn.completeTask("t1");

    expect(task.completed).toBe(true);

    const init = fetchSpy.mock.calls[0]?.[1] as {
      method?: string;
      body?: string;
    };
    expect(init?.method).toBe("PUT");
    const sent = JSON.parse(init?.body ?? "{}");
    expect(sent).toEqual({ data: { completed: true } });
  });

  // ── addTaskComment ─────────────────────────────────────────────────────────

  it("addTaskComment posts `{data:{text, type:'comment'}}` and unwraps", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      makeJsonResponse({
        data: {
          gid: "s1",
          type: "comment",
          text: "hi",
          created_at: "2026-04-29T00:00:00.000Z",
        },
      }),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    mockAuthenticate(conn);

    const story = await conn.addTaskComment("t1", { text: "hi" });

    expect(story.gid).toBe("s1");
    expect(story.text).toBe("hi");

    const call = fetchSpy.mock.calls[0];
    expect(String(call?.[0])).toContain("/tasks/t1/stories");
    const init = call?.[1] as { method?: string; body?: string };
    expect(init?.method).toBe("POST");

    const sent = JSON.parse(init?.body ?? "{}");
    expect(sent).toEqual({ data: { text: "hi", type: "comment" } });
  });

  it("addTaskComment rejects when text is empty", async () => {
    const { AsanaConnector } = await import("../asana.js");
    const conn = new AsanaConnector();
    await expect(conn.addTaskComment("t1", { text: "" })).rejects.toThrow(
      /text/,
    );
  });
});
