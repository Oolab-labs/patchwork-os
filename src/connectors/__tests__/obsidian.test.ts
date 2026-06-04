import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock undici so tests don't need a real Obsidian instance.
vi.mock("undici", () => {
  return {
    // biome-ignore lint/complexity/useArrowFunction: must be constructable with `new` — vitest 4 runs the mock impl as a constructor
    Agent: vi.fn().mockImplementation(function () {
      return {};
    }),
    fetch: vi.fn(),
  };
});

import { fetch as undiciFetch } from "undici";

const mockFetch = undiciFetch as ReturnType<typeof vi.fn>;

describe("obsidian token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-obsidian-${Date.now()}`);
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
    delete process.env.OBSIDIAN_API_KEY;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns env token without reading storage", async () => {
    process.env.OBSIDIAN_API_KEY = "test-api-key-123";
    const { loadTokens } = await import("../obsidian.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.apiKey).toBe("test-api-key-123");
    expect(tokens!.baseUrl).toBe("https://127.0.0.1:27124");
  });

  it("loadTokens returns null when no env and no stored token", async () => {
    const { loadTokens } = await import("../obsidian.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips through file storage", async () => {
    const { loadTokens, saveTokens } = await import("../obsidian.js");
    const tokens = {
      apiKey: "my-api-key",
      baseUrl: "https://127.0.0.1:27124",
      connected_at: "2026-05-31T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      apiKey: "my-api-key",
      baseUrl: "https://127.0.0.1:27124",
    });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../obsidian.js");
    expect(() => clearTokens()).not.toThrow();
  });
});

describe("ObsidianConnector.readNote", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    process.env.OBSIDIAN_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.OBSIDIAN_API_KEY;
    vi.restoreAllMocks();
  });

  it("returns note content on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => "# Hello\nThis is a note.",
    });

    const { ObsidianConnector } = await import("../obsidian.js");
    const conn = new ObsidianConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "test-key" });

    const content = await conn.readNote("Hello.md");
    expect(content).toBe("# Hello\nThis is a note.");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0]! as [string, unknown];
    expect(url).toContain("/vault/Hello.md");
  });

  it("throws on 404", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const { ObsidianConnector } = await import("../obsidian.js");
    const conn = new ObsidianConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "test-key" });

    await expect(conn.readNote("Missing.md")).rejects.toThrow();
  });
});

describe("ObsidianConnector.writeNote", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    process.env.OBSIDIAN_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.OBSIDIAN_API_KEY;
    vi.restoreAllMocks();
  });

  it("uses PUT for full replace", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { ObsidianConnector } = await import("../obsidian.js");
    const conn = new ObsidianConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "test-key" });

    await conn.writeNote("Notes/Test.md", "# New content");
    const [, opts] = mockFetch.mock.calls[0]! as [
      string,
      { method: string; body: string },
    ];
    expect(opts.method).toBe("PUT");
    expect(opts.body).toBe("# New content");
  });

  it("uses POST for append", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { ObsidianConnector } = await import("../obsidian.js");
    const conn = new ObsidianConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "test-key" });

    await conn.writeNote("Notes/Test.md", "\nAppended line", true);
    const [, opts] = mockFetch.mock.calls[0]! as [string, { method: string }];
    expect(opts.method).toBe("POST");
  });
});

describe("ObsidianConnector.searchVault", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    process.env.OBSIDIAN_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.OBSIDIAN_API_KEY;
    vi.restoreAllMocks();
  });

  it("returns search results", async () => {
    const mockResults = [
      { filename: "Notes/Meeting.md", score: 0.9, matches: ["meeting notes"] },
      {
        filename: "Notes/Project.md",
        score: 0.7,
        matches: ["project meeting"],
      },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResults,
    });

    const { ObsidianConnector } = await import("../obsidian.js");
    const conn = new ObsidianConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "test-key" });

    const results = await conn.searchVault("meeting");
    expect(results).toHaveLength(2);
    expect(results[0]!.filename).toBe("Notes/Meeting.md");
    expect(results[0]!.score).toBe(0.9);

    const [url, opts] = mockFetch.mock.calls[0]! as [
      string,
      { method: string },
    ];
    expect(url).toContain("/search/simple/");
    expect(url).toContain("meeting");
    expect(opts.method).toBe("POST");
  });
});

describe("handleObsidianConnect", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects missing apiKey", async () => {
    const { handleObsidianConnect } = await import("../obsidian.js");
    const result = await handleObsidianConnect(JSON.stringify({}));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("rejects invalid JSON", async () => {
    const { handleObsidianConnect } = await import("../obsidian.js");
    const result = await handleObsidianConnect("not json");
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 401 when plugin rejects the key", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const { handleObsidianConnect } = await import("../obsidian.js");
    const result = await handleObsidianConnect(
      JSON.stringify({ apiKey: "bad-key" }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("stores tokens and returns ok=true on success", async () => {
    const tmpDir2 = join(os.tmpdir(), `patchwork-obsidian-hc-${Date.now()}`);
    const homeDir2 = join(tmpDir2, "home");
    const patchworkHome2 = join(homeDir2, ".patchwork");
    mkdirSync(join(patchworkHome2, "tokens"), { recursive: true });
    process.env.HOME = homeDir2;
    process.env.PATCHWORK_HOME = patchworkHome2;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: ["Notes/Hello.md"] }),
    });

    const { handleObsidianConnect, loadTokens } = await import(
      "../obsidian.js"
    );
    const result = await handleObsidianConnect(
      JSON.stringify({ apiKey: "good-key" }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.baseUrl).toBe("https://127.0.0.1:27124");

    const stored = loadTokens();
    expect(stored?.apiKey).toBe("good-key");

    rmSync(tmpDir2, { recursive: true, force: true });
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  });
});

describe("handleObsidianTest", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    delete process.env.OBSIDIAN_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when not connected", async () => {
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    const tmpDir3 = join(os.tmpdir(), `patchwork-obsidian-t-${Date.now()}`);
    const homeDir3 = join(tmpDir3, "home");
    mkdirSync(join(homeDir3, ".patchwork", "tokens"), { recursive: true });
    process.env.HOME = homeDir3;
    process.env.PATCHWORK_HOME = join(homeDir3, ".patchwork");

    const { handleObsidianTest } = await import("../obsidian.js");
    const result = await handleObsidianTest();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);

    rmSync(tmpDir3, { recursive: true, force: true });
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  });

  it("returns 200 when health check passes", async () => {
    process.env.OBSIDIAN_API_KEY = "healthy-key";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [] }),
    });

    const { handleObsidianTest, resetObsidianConnector } = await import(
      "../obsidian.js"
    );
    resetObsidianConnector();
    const result = await handleObsidianTest();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});

describe("handleObsidianDisconnect", () => {
  it("returns ok:true", async () => {
    const { handleObsidianDisconnect } = await import("../obsidian.js");
    const result = handleObsidianDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
