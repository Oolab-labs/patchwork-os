import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("jira token storage", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-jira-${Date.now()}`);
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
    delete process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_INSTANCE_URL;
    delete process.env.JIRA_EMAIL;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns env-var tokens without reading secure storage", async () => {
    process.env.JIRA_API_TOKEN = "jira-token";
    process.env.JIRA_INSTANCE_URL = "https://acme.atlassian.net/";
    process.env.JIRA_EMAIL = "dev@acme.test";

    const { loadTokens } = await import("../jira.js");

    expect(loadTokens()).toEqual(
      expect.objectContaining({
        accessToken: "jira-token",
        instanceUrl: "https://acme.atlassian.net",
        isCloud: true,
        email: "dev@acme.test",
      }),
    );
  });

  it("migrates a legacy jira token file into secure storage on read", async () => {
    const legacyTokens = {
      accessToken: "legacy-token",
      email: "ops@acme.test",
      instanceUrl: "https://jira.acme.test",
      isCloud: false,
      connected_at: "2026-04-23T00:00:00.000Z",
    };

    writeFileSync(
      join(tokensDir, "jira.json"),
      JSON.stringify(legacyTokens, null, 2),
    );

    const { loadTokens } = await import("../jira.js");

    expect(loadTokens()).toEqual(legacyTokens);
    expect(existsSync(join(tokensDir, "jira.json"))).toBe(false);
    expect(existsSync(join(tokensDir, "patchwork-os.jira.enc"))).toBe(true);
  });

  it("saves jira tokens through the shared secure storage helper", async () => {
    const tokens = {
      accessToken: "secure-token",
      email: "eng@acme.test",
      instanceUrl: "https://acme.atlassian.net",
      isCloud: true,
      connected_at: "2026-04-23T00:00:00.000Z",
    };

    const { loadTokens, saveTokens } = await import("../jira.js");

    saveTokens(tokens);

    expect(loadTokens()).toEqual(tokens);
    expect(existsSync(join(tokensDir, "patchwork-os.jira.enc"))).toBe(true);
  });
});

describe("handleJiraConnect", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-jira-h-${Date.now()}`);
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
    delete process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_INSTANCE_URL;
    delete process.env.JIRA_EMAIL;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("is exported (route wiring sanity check — would 404 if missing)", async () => {
    const mod = await import("../jira.js");
    expect(typeof mod.handleJiraConnect).toBe("function");
    expect(typeof mod.handleJiraTest).toBe("function");
    expect(typeof mod.handleJiraDisconnect).toBe("function");
  });

  it("returns 400 when apiToken missing", async () => {
    const { handleJiraConnect } = await import("../jira.js");
    const result = await handleJiraConnect(
      JSON.stringify({
        email: "d@a.com",
        instanceUrl: "https://a.atlassian.net",
      }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/apiToken/);
  });

  it("rejects non-atlassian.net hostnames (SSRF guard)", async () => {
    const { handleJiraConnect } = await import("../jira.js");
    const result = await handleJiraConnect(
      JSON.stringify({
        apiToken: "t",
        email: "d@a.com",
        instanceUrl: "http://169.254.169.254/",
      }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/atlassian\.net/);
  });

  it("returns 200 and stores tokens on success", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ accountId: "abc" }),
    }) as unknown as typeof fetch;

    const { handleJiraConnect, loadTokens } = await import("../jira.js");
    const result = await handleJiraConnect(
      JSON.stringify({
        apiToken: "my-token",
        email: "dev@acme.com",
        instanceUrl: "https://acme.atlassian.net/",
      }),
    );
    expect(result.status).toBe(200);
    const stored = loadTokens();
    expect(stored?.accessToken).toBe("my-token");
    expect(stored?.instanceUrl).toBe("https://acme.atlassian.net");
    expect(stored?.isCloud).toBe(true);
  });

  it("returns 401 when Jira rejects credentials", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const { handleJiraConnect } = await import("../jira.js");
    const result = await handleJiraConnect(
      JSON.stringify({
        apiToken: "bad",
        email: "dev@acme.com",
        instanceUrl: "https://acme.atlassian.net",
      }),
    );
    expect(result.status).toBe(401);
  });
});

describe("buildHeaders auth scheme (cloud + email API token)", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-jira-bh-${Date.now()}`);
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
    delete process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_INSTANCE_URL;
    delete process.env.JIRA_EMAIL;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function captureAuthHeader(): { current: string | undefined } {
    const captured: { current: string | undefined } = { current: undefined };
    global.fetch = vi.fn().mockImplementation((_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      captured.current = headers.Authorization;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ id: "1", key: "ABC-1", fields: {} }),
      });
    }) as unknown as typeof fetch;
    return captured;
  }

  it("uses Basic base64(email:token) for cloud + email API token (NOT Bearer)", async () => {
    const { saveTokens, getJiraConnector } = await import("../jira.js");
    saveTokens({
      accessToken: "api-token-123",
      email: "dev@acme.com",
      instanceUrl: "https://acme.atlassian.net",
      isCloud: true,
      connected_at: "2026-06-02T00:00:00.000Z",
    });

    const captured = captureAuthHeader();
    await getJiraConnector().fetchIssue("ABC-1");

    const expectedBasic = Buffer.from("dev@acme.com:api-token-123").toString(
      "base64",
    );
    expect(captured.current).toBe(`Basic ${expectedBasic}`);
    expect(captured.current).not.toMatch(/^Bearer /);
  });

  it("uses Bearer for cloud token WITHOUT email (real OAuth access token)", async () => {
    const { saveTokens, getJiraConnector } = await import("../jira.js");
    saveTokens({
      accessToken: "oauth-access-token",
      instanceUrl: "https://acme.atlassian.net",
      isCloud: true,
      connected_at: "2026-06-02T00:00:00.000Z",
    });

    const captured = captureAuthHeader();
    await getJiraConnector().fetchIssue("ABC-1");

    expect(captured.current).toBe("Bearer oauth-access-token");
  });
});

describe("listProjects request bound (connectors-vendors-4)", () => {
  it("appends a maxResults page cap so a large org can't return all projects unbounded", async () => {
    const { saveTokens, getJiraConnector } = await import("../jira.js");
    saveTokens({
      accessToken: "oauth-access-token",
      instanceUrl: "https://acme.atlassian.net",
      isCloud: true,
      connected_at: "2026-06-10T00:00:00.000Z",
    });

    let capturedUrl = "";
    global.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [],
      });
    }) as unknown as typeof fetch;

    await getJiraConnector().listProjects();

    expect(capturedUrl).toContain("/project?maxResults=100");
    expect(capturedUrl).toContain("startAt=0");
  });

  it("clamps an oversized caller-supplied maxResults to 100", async () => {
    const { saveTokens, getJiraConnector } = await import("../jira.js");
    saveTokens({
      accessToken: "oauth-access-token",
      instanceUrl: "https://acme.atlassian.net",
      isCloud: true,
      connected_at: "2026-06-10T00:00:00.000Z",
    });

    let capturedUrl = "";
    global.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [],
      });
    }) as unknown as typeof fetch;

    await getJiraConnector().listProjects(99999);
    expect(capturedUrl).toContain("maxResults=100");
  });
});

describe("jira getStatus() token expiry (dashboard gap #2, PAT-style connector)", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-jira-status-${Date.now()}`);
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
    delete process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_INSTANCE_URL;
    delete process.env.JIRA_EMAIL;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("never fabricates tokenExpiresAt for a PAT-style connector, even when connected", async () => {
    process.env.JIRA_API_TOKEN = "jira-token";
    process.env.JIRA_INSTANCE_URL = "https://acme.atlassian.net/";
    process.env.JIRA_EMAIL = "dev@acme.test";

    const { JiraConnector } = await import("../jira.js");
    const conn = new JiraConnector();
    const status = conn.getStatus();

    expect(status.status).toBe("connected");
    expect(status.tokenExpiresAt).toBeUndefined();
  });

  it("surfaces lastSuccessAt only after a recorded successful call, never guessed", async () => {
    process.env.JIRA_API_TOKEN = "jira-token";
    process.env.JIRA_INSTANCE_URL = "https://acme.atlassian.net/";
    process.env.JIRA_EMAIL = "dev@acme.test";

    const { JiraConnector } = await import("../jira.js");
    const { recordConnectorSuccess, __resetConnectorActivityForTest } =
      await import("../connectorActivity.js");
    __resetConnectorActivityForTest();

    const conn = new JiraConnector();
    expect(conn.getStatus().lastSuccessAt).toBeUndefined();

    recordConnectorSuccess("jira");
    const after = conn.getStatus();
    expect(after.lastSuccessAt).toBeDefined();
    expect(new Date(after.lastSuccessAt as string).toString()).not.toBe(
      "Invalid Date",
    );
  });
});

describe("connectorRoutes /connections/jira/connect wiring", () => {
  it("connectorRoutes.ts references handleJiraConnect (regression: was 404)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../connectorRoutes.ts", import.meta.url),
      "utf-8",
    );
    expect(src).toMatch(/\/connections\/jira\/connect/);
    expect(src).toMatch(/handleJiraConnect/);
  });
});
