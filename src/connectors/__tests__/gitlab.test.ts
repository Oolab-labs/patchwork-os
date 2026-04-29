import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeJsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  const r = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone() {
      return this;
    },
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null,
    },
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

// ── Token storage ────────────────────────────────────────────────────────────

describe("gitlab token storage", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-gitlab-${Date.now()}`);
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
    delete process.env.GITLAB_CLIENT_ID;
    delete process.env.GITLAB_CLIENT_SECRET;
    delete process.env.GITLAB_BASE_URL;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadTokens returns null when nothing stored", async () => {
    const { loadTokens } = await import("../gitlab.js");
    expect(loadTokens()).toBeNull();
  });

  it("save + load round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../gitlab.js");
    saveTokens({
      access_token: "gl-access",
      refresh_token: "gl-refresh",
      username: "alice",
      user_id: 42,
      connected_at: "2026-04-29T00:00:00.000Z",
    });
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      access_token: "gl-access",
      refresh_token: "gl-refresh",
      username: "alice",
    });
  });
});

// ── healthCheck ──────────────────────────────────────────────────────────────

describe("GitLabConnector.healthCheck", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns ok:true on 200", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse({ id: 1, username: "alice" }),
      ) as unknown as typeof fetch;

    const { GitLabConnector } = await import("../gitlab.js");
    const conn = new GitLabConnector();
    mockAuthenticate(conn);

    const result = await conn.healthCheck();
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with auth_expired on 401", async () => {
    const r = makeJsonResponse({}, 401);
    global.fetch = vi.fn().mockResolvedValue(r) as unknown as typeof fetch;

    const { GitLabConnector } = await import("../gitlab.js");
    const conn = new GitLabConnector();
    mockAuthenticate(conn);

    const result = await conn.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("auth_expired");
  });
});

// ── listProjects ─────────────────────────────────────────────────────────────

describe("GitLabConnector.listProjects", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("defaults to membership=true", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse([{ id: 1, name: "p", path_with_namespace: "g/p" }]),
      );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { GitLabConnector } = await import("../gitlab.js");
    const conn = new GitLabConnector();
    mockAuthenticate(conn);

    const projects = await conn.listProjects();
    expect(projects).toHaveLength(1);
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("membership=true");
    expect(url).toContain("/api/v4/projects");
  });
});

// ── listIssues ───────────────────────────────────────────────────────────────

describe("GitLabConnector.listIssues", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("with assignedToMe + no projectId hits /issues with scope=assigned_to_me", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse([
          { id: 5, iid: 1, project_id: 9, title: "x", state: "opened" },
        ]),
      );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { GitLabConnector } = await import("../gitlab.js");
    const conn = new GitLabConnector();
    mockAuthenticate(conn);

    const issues = await conn.listIssues({ assignedToMe: true });
    expect(issues).toHaveLength(1);
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toMatch(/\/api\/v4\/issues\?/);
    expect(url).toContain("scope=assigned_to_me");
  });

  it("rejects invalid state value", async () => {
    const { GitLabConnector } = await import("../gitlab.js");
    const conn = new GitLabConnector();
    await expect(
      conn.listIssues({ state: "bogus" as unknown as "opened" }),
    ).rejects.toThrow(/state/);
  });
});

// ── getIssue ─────────────────────────────────────────────────────────────────

describe("GitLabConnector.getIssue", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("normalizes 404 into not_found", async () => {
    const r = makeJsonResponse({}, 404);
    global.fetch = vi.fn().mockResolvedValue(r) as unknown as typeof fetch;

    const { GitLabConnector } = await import("../gitlab.js");
    const conn = new GitLabConnector();
    mockAuthenticate(conn);

    await expect(conn.getIssue("group/repo", 999)).rejects.toThrow(
      /not found/i,
    );
  });
});

// ── listMergeRequests ────────────────────────────────────────────────────────

describe("GitLabConnector.listMergeRequests", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("happy path with projectId hits project MR endpoint", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse([
          { id: 11, iid: 2, project_id: 7, title: "mr", state: "opened" },
        ]),
      );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { GitLabConnector } = await import("../gitlab.js");
    const conn = new GitLabConnector();
    mockAuthenticate(conn);

    const mrs = await conn.listMergeRequests({ projectId: 7, state: "opened" });
    expect(mrs).toHaveLength(1);
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("/api/v4/projects/7/merge_requests");
    expect(url).toContain("state=opened");
  });
});

// ── 429 rate-limited ─────────────────────────────────────────────────────────

describe("GitLabConnector 429 handling", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("normalizes 429 with Retry-After into rate_limited", async () => {
    const make429 = () => makeJsonResponse({}, 429, { "retry-after": "30" });
    global.fetch = vi
      .fn()
      .mockImplementation(async () => make429()) as unknown as typeof fetch;

    const { GitLabConnector } = await import("../gitlab.js");
    const conn = new GitLabConnector();
    mockAuthenticate(conn);

    const result = await conn.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("rate_limited");
    expect(result.error?.message).toContain("30");
  }, 30_000);
});

// ── GITLAB_BASE_URL override ─────────────────────────────────────────────────

describe("GitLabConnector self-hosted base URL", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.GITLAB_BASE_URL;
  });

  it("GITLAB_BASE_URL changes the request URL", async () => {
    process.env.GITLAB_BASE_URL = "https://gitlab.example.com";

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse({ id: 1, username: "alice" }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { GitLabConnector } = await import("../gitlab.js");
    const conn = new GitLabConnector();
    mockAuthenticate(conn);

    await conn.getCurrentUser();
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toBe("https://gitlab.example.com/api/v4/user");
  });
});

// ── Token refresh on 401 ─────────────────────────────────────────────────────

describe("GitLabConnector token refresh on 401", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-gitlab-refresh-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    process.env.GITLAB_CLIENT_ID = "cid";
    process.env.GITLAB_CLIENT_SECRET = "csecret";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.GITLAB_CLIENT_ID;
    delete process.env.GITLAB_CLIENT_SECRET;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("on 401, refreshes token and retries the API call once", async () => {
    const expired = makeJsonResponse({}, 401);

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce(
        makeJsonResponse({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 7200,
          scope: "read_user read_api read_repository",
          token_type: "Bearer",
        }),
      )
      .mockResolvedValueOnce(makeJsonResponse({ id: 1, username: "alice" }));

    global.fetch = fetchSpy as unknown as typeof fetch;

    const { GitLabConnector, saveTokens, loadTokens } = await import(
      "../gitlab.js"
    );
    saveTokens({
      access_token: "stale-access",
      refresh_token: "stale-refresh",
      expires_at: Date.now() + 60_000,
      scope: "read_user read_api read_repository",
      token_type: "Bearer",
      _client_id: "cid",
      _client_secret: "csecret",
      connected_at: new Date().toISOString(),
    });

    const conn = new GitLabConnector();
    const result = await conn.healthCheck();

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const url1 = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    const url2 = String(fetchSpy.mock.calls[1]?.[0] ?? "");
    const url3 = String(fetchSpy.mock.calls[2]?.[0] ?? "");
    expect(url1).toContain("/user");
    expect(url2).toContain("/oauth/token");
    expect(url3).toContain("/user");

    const stored = loadTokens();
    expect(stored?.access_token).toBe("new-access");
    expect(stored?.refresh_token).toBe("new-refresh");
  });
});

// ── HTTP handlers ────────────────────────────────────────────────────────────

describe("handleGitLabAuthorize", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.GITLAB_CLIENT_ID;
    delete process.env.GITLAB_CLIENT_SECRET;
    delete process.env.GITLAB_BASE_URL;
  });

  it("returns 503 when env vars not set", async () => {
    const { handleGitLabAuthorize } = await import("../gitlab.js");
    const result = handleGitLabAuthorize();
    expect(result.status).toBe(503);
    const body = JSON.parse(result.body);
    expect(body.error).toMatch(/GITLAB_CLIENT_ID/);
  });

  it("returns 302 redirect with state when configured", async () => {
    process.env.GITLAB_CLIENT_ID = "cid";
    process.env.GITLAB_CLIENT_SECRET = "csecret";
    const { handleGitLabAuthorize } = await import("../gitlab.js");
    const result = handleGitLabAuthorize();
    expect(result.status).toBe(302);
    expect(result.redirect).toMatch(
      /^https:\/\/gitlab\.com\/oauth\/authorize\?/,
    );
    const url = new URL(result.redirect ?? "");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(
      "read_user read_api read_repository",
    );
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("authorize URL respects GITLAB_BASE_URL", async () => {
    process.env.GITLAB_CLIENT_ID = "cid";
    process.env.GITLAB_CLIENT_SECRET = "csecret";
    process.env.GITLAB_BASE_URL = "https://gitlab.example.com";
    const { handleGitLabAuthorize } = await import("../gitlab.js");
    const result = handleGitLabAuthorize();
    expect(result.redirect).toMatch(
      /^https:\/\/gitlab\.example\.com\/oauth\/authorize\?/,
    );
  });
});
