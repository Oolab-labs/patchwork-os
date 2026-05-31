import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("posthog token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-posthog-${Date.now()}`);
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
    delete process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_HOST;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadPostHogTokens returns env vars without reading storage", async () => {
    process.env.POSTHOG_API_KEY = "phx_test-key-123";
    process.env.POSTHOG_HOST = "https://eu.posthog.com";
    const { loadPostHogTokens } = await import("../posthog.js");
    const tokens = loadPostHogTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.apiKey).toBe("phx_test-key-123");
    expect(tokens!.host).toBe("https://eu.posthog.com");
  });

  it("loadPostHogTokens returns null when no env and no stored token", async () => {
    const { loadPostHogTokens } = await import("../posthog.js");
    expect(loadPostHogTokens()).toBeNull();
  });

  it("savePostHogTokens + loadPostHogTokens round-trips", async () => {
    const { loadPostHogTokens, savePostHogTokens } = await import(
      "../posthog.js"
    );
    const tokens = {
      apiKey: "phx_mykey",
      host: "https://us.posthog.com",
      connected_at: "2026-05-01T00:00:00.000Z",
    };
    savePostHogTokens(tokens);
    const loaded = loadPostHogTokens();
    expect(loaded).toMatchObject({
      apiKey: "phx_mykey",
      host: "https://us.posthog.com",
    });
  });

  it("clearPostHogTokens does not throw even when no file exists", async () => {
    const { clearPostHogTokens } = await import("../posthog.js");
    expect(() => clearPostHogTokens()).not.toThrow();
  });

  it("loadPostHogTokens defaults host to us.posthog.com from env", async () => {
    process.env.POSTHOG_API_KEY = "phx_abc";
    const { loadPostHogTokens } = await import("../posthog.js");
    const tokens = loadPostHogTokens();
    expect(tokens!.host).toBe("https://us.posthog.com");
  });
});

describe("PostHogConnector.getProjects", () => {
  it("returns array from paginated results shape", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            id: 1,
            name: "My Project",
            api_token: "phc_tok",
            created_at: "2026-01-01T00:00:00Z",
            timezone: "UTC",
          },
        ],
      }),
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { PostHogConnector } = await import("../posthog.js");
    const conn = new PostHogConnector();
    (conn as unknown as { tokens: object }).tokens = {
      apiKey: "phx_key",
      host: "https://us.posthog.com",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "phx_key", scopes: [] });

    const projects = await conn.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("My Project");
  });

  it("returns array from flat array shape", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 2,
          name: "Other Project",
          api_token: "phc_tok2",
          created_at: "2026-02-01T00:00:00Z",
          timezone: "America/New_York",
        },
      ],
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { PostHogConnector } = await import("../posthog.js");
    const conn = new PostHogConnector();
    (conn as unknown as { tokens: object }).tokens = {
      apiKey: "phx_key",
      host: "https://us.posthog.com",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "phx_key", scopes: [] });

    const projects = await conn.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe(2);
  });
});

describe("PostHogConnector.captureEvent", () => {
  it("posts to /capture/ with project api_key and returns status", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 1 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    vi.resetModules();
    const { PostHogConnector } = await import("../posthog.js");
    const conn = new PostHogConnector();
    (conn as unknown as { tokens: object }).tokens = {
      apiKey: "phx_mgmt",
      projectApiKey: "phc_proj123",
      host: "https://us.posthog.com",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "phx_mgmt", scopes: [] });

    const result = await conn.captureEvent("user_123", "page_view", {
      url: "/home",
    });
    expect(result).toEqual({ status: 1 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://us.posthog.com/capture/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.api_key).toBe("phc_proj123");
    expect(body.distinct_id).toBe("user_123");
    expect(body.event).toBe("page_view");
    expect(body.properties).toEqual({ url: "/home" });
  });

  it("throws when projectApiKey is missing", async () => {
    vi.resetModules();
    const { PostHogConnector } = await import("../posthog.js");
    const conn = new PostHogConnector();
    (conn as unknown as { tokens: object }).tokens = {
      apiKey: "phx_mgmt",
      // no projectApiKey
      host: "https://us.posthog.com",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "phx_mgmt", scopes: [] });

    await expect(conn.captureEvent("user_x", "test_event")).rejects.toThrow(
      "projectApiKey is required",
    );
  });
});

describe("PostHogConnector.getFeatureFlags", () => {
  it("returns feature flags list", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            id: 10,
            key: "new-dashboard",
            name: "New Dashboard",
            active: true,
            filters: {},
            created_at: "2026-01-01T00:00:00Z",
            rollout_percentage: 50,
          },
        ],
      }),
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { PostHogConnector } = await import("../posthog.js");
    const conn = new PostHogConnector();
    (conn as unknown as { tokens: object }).tokens = {
      apiKey: "phx_key",
      host: "https://us.posthog.com",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "phx_key", scopes: [] });

    const flags = await conn.getFeatureFlags(1);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.key).toBe("new-dashboard");
    expect(flags[0]!.active).toBe(true);
    expect(flags[0]!.rollout_percentage).toBe(50);
  });
});

describe("PostHogConnector error normalization", () => {
  it("normalizes 401 to auth_expired", async () => {
    vi.resetModules();
    const { PostHogConnector } = await import("../posthog.js");
    const conn = new PostHogConnector();
    const err = conn.normalizeError(new Response(null, { status: 401 }));
    expect(err.code).toBe("auth_expired");
    expect(err.retryable).toBe(false);
  });

  it("normalizes 403 to permission_denied", async () => {
    vi.resetModules();
    const { PostHogConnector } = await import("../posthog.js");
    const conn = new PostHogConnector();
    const err = conn.normalizeError(new Response(null, { status: 403 }));
    expect(err.code).toBe("permission_denied");
  });

  it("normalizes 429 to rate_limited", async () => {
    vi.resetModules();
    const { PostHogConnector } = await import("../posthog.js");
    const conn = new PostHogConnector();
    const err = conn.normalizeError(new Response(null, { status: 429 }));
    expect(err.code).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });

  it("normalizes 404 to not_found", async () => {
    vi.resetModules();
    const { PostHogConnector } = await import("../posthog.js");
    const conn = new PostHogConnector();
    const err = conn.normalizeError(new Response(null, { status: 404 }));
    expect(err.code).toBe("not_found");
  });

  it("normalizes network error to network_error", async () => {
    vi.resetModules();
    const { PostHogConnector } = await import("../posthog.js");
    const conn = new PostHogConnector();
    const err = conn.normalizeError(new Error("ENOTFOUND us.posthog.com"));
    expect(err.code).toBe("network_error");
    expect(err.retryable).toBe(true);
  });
});

describe("handlePostHogConnect", () => {
  it("returns 400 when apiKey missing", async () => {
    vi.resetModules();
    const { handlePostHogConnect } = await import("../posthog.js");
    const result = await handlePostHogConnect(JSON.stringify({}));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 on invalid JSON", async () => {
    vi.resetModules();
    const { handlePostHogConnect } = await import("../posthog.js");
    const result = await handlePostHogConnect("not-json");
    expect(result.status).toBe(400);
  });

  it("returns 400 when host is not https", async () => {
    vi.resetModules();
    const { handlePostHogConnect } = await import("../posthog.js");
    const result = await handlePostHogConnect(
      JSON.stringify({ apiKey: "phx_abc", host: "http://evil.example.com" }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/https/);
  });

  it("returns 401 when PostHog rejects credentials", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handlePostHogConnect } = await import("../posthog.js");
    const result = await handlePostHogConnect(
      JSON.stringify({ apiKey: "phx_bad" }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 and stores tokens on success", async () => {
    const tmpDir2 = join(
      os.tmpdir(),
      `patchwork-posthog-connect-${Date.now()}`,
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
    const { handlePostHogConnect, loadPostHogTokens } = await import(
      "../posthog.js"
    );
    const result = await handlePostHogConnect(
      JSON.stringify({
        apiKey: "phx_good-key",
        projectApiKey: "phc_proj",
        projectId: 42,
      }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.host).toBe("https://us.posthog.com");

    const stored = loadPostHogTokens();
    expect(stored?.apiKey).toBe("phx_good-key");
    expect(stored?.projectApiKey).toBe("phc_proj");
    expect(stored?.projectId).toBe(42);

    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("handlePostHogTest", () => {
  it("returns 400 when not connected", async () => {
    vi.resetModules();
    const { handlePostHogTest } = await import("../posthog.js");
    const result = await handlePostHogTest();
    expect(result.status).toBe(400);
  });
});

describe("handlePostHogDisconnect", () => {
  it("returns 200 always", async () => {
    vi.resetModules();
    const { handlePostHogDisconnect } = await import("../posthog.js");
    const result = handlePostHogDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
