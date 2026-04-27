import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("notion token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-notion-${Date.now()}`);
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
    delete process.env.NOTION_TOKEN;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns env token without reading storage", async () => {
    process.env.NOTION_TOKEN = "secret_envtoken";
    const { loadTokens } = await import("../notion.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.accessToken).toBe("secret_envtoken");
  });

  it("loadTokens returns null when no env and no stored token", async () => {
    const { loadTokens } = await import("../notion.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips through file storage", async () => {
    const { loadTokens, saveTokens } = await import("../notion.js");
    const tokens = {
      accessToken: "secret_abc123",
      workspaceName: "Acme",
      workspaceId: "ws-1",
      botId: "bot-1",
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      accessToken: "secret_abc123",
      workspaceName: "Acme",
    });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../notion.js");
    // Should not throw when token file is absent
    expect(() => clearTokens()).not.toThrow();
  });
});

describe("normalizeId (via queryDatabase)", () => {
  it("accepts hyphenated UUID without error (mocked fetch)", async () => {
    const mockResults = {
      object: "list",
      results: [],
      next_cursor: null,
      has_more: false,
    };
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResults,
    }) as unknown as typeof fetch;

    const { NotionConnector } = await import("../notion.js");
    const conn = new NotionConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "secret_t" });

    const result = await conn.queryDatabase(
      "12345678-1234-1234-1234-123456789012",
    );
    expect(result.results).toEqual([]);

    const url = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(url).toContain("12345678-1234-1234-1234-123456789012");
  });
});

describe("handleNotionConnect", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("rejects token not starting with secret_", async () => {
    const { handleNotionConnect } = await import("../notion.js");
    const result = await handleNotionConnect(
      JSON.stringify({ token: "bad_token" }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("rejects invalid JSON body", async () => {
    const { handleNotionConnect } = await import("../notion.js");
    const result = await handleNotionConnect("not json");
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 401 when Notion API rejects the token", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    const { handleNotionConnect } = await import("../notion.js");
    const result = await handleNotionConnect(
      JSON.stringify({ token: "secret_invalid" }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("stores tokens and returns ok=true on success", async () => {
    const tmpDir2 = join(os.tmpdir(), `patchwork-notion-hc-${Date.now()}`);
    const homeDir2 = join(tmpDir2, "home");
    const patchworkHome2 = join(homeDir2, ".patchwork");
    mkdirSync(join(patchworkHome2, "tokens"), { recursive: true });
    process.env.HOME = homeDir2;
    process.env.PATCHWORK_HOME = patchworkHome2;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        bot: { workspace_name: "TestWS", owner: { workspace_id: "ws-42" } },
      }),
    }) as unknown as typeof fetch;

    const { handleNotionConnect, loadTokens } = await import("../notion.js");
    const result = await handleNotionConnect(
      JSON.stringify({ token: "secret_good" }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.workspace).toBe("TestWS");

    const stored = loadTokens();
    expect(stored?.accessToken).toBe("secret_good");

    rmSync(tmpDir2, { recursive: true, force: true });
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  });
});

describe("handleNotionTest", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.NOTION_TOKEN;
  });

  it("returns 400 when not connected", async () => {
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    const tmpDir3 = join(os.tmpdir(), `patchwork-notion-t-${Date.now()}`);
    const homeDir3 = join(tmpDir3, "home");
    mkdirSync(join(homeDir3, ".patchwork", "tokens"), { recursive: true });
    process.env.HOME = homeDir3;
    process.env.PATCHWORK_HOME = join(homeDir3, ".patchwork");

    const { handleNotionTest } = await import("../notion.js");
    const result = await handleNotionTest();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);

    rmSync(tmpDir3, { recursive: true, force: true });
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  });

  it("returns 200 when health check passes", async () => {
    process.env.NOTION_TOKEN = "secret_healthy";
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ object: "user", id: "user-1", type: "bot" }),
    }) as unknown as typeof fetch;

    const { handleNotionTest, resetNotionConnector } = await import(
      "../notion.js"
    );
    resetNotionConnector();
    const result = await handleNotionTest();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});

describe("handleNotionDisconnect", () => {
  it("returns ok:true", async () => {
    const { handleNotionDisconnect } = await import("../notion.js");
    const result = handleNotionDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
