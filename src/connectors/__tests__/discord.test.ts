import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Token storage ────────────────────────────────────────────────────────────

describe("discord token storage", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-discord-${Date.now()}`);
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
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns null when no token stored", async () => {
    const { loadTokens } = await import("../discord.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../discord.js");
    const tokens = {
      access_token: "discord-access-123",
      refresh_token: "discord-refresh-123",
      expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000,
      scope: "identify guilds messages.read",
      username: "patchwork-bot",
      user_id: "1234567890",
      connected_at: "2026-04-29T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      access_token: "discord-access-123",
      refresh_token: "discord-refresh-123",
      username: "patchwork-bot",
    });
  });

  it("clearTokens does not throw when no file exists", async () => {
    const { clearTokens } = await import("../discord.js");
    expect(() => clearTokens()).not.toThrow();
  });

  it("isConnected reflects stored token presence", async () => {
    const { isConnected, saveTokens, clearTokens } = await import(
      "../discord.js"
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

describe("DiscordConnector.healthCheck", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns ok:true when API responds 200", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "u1", username: "patchwork" }),
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    const { DiscordConnector } = await import("../discord.js");
    const conn = new DiscordConnector();
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

    const { DiscordConnector } = await import("../discord.js");
    const conn = new DiscordConnector();
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

// ── listGuilds ───────────────────────────────────────────────────────────────

describe("DiscordConnector.listGuilds", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns the guild array verbatim", async () => {
    const guilds = [
      { id: "g1", name: "Patchwork", icon: null, owner: true },
      { id: "g2", name: "Other", icon: null, owner: false },
    ];
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => guilds,
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    const { DiscordConnector } = await import("../discord.js");
    const conn = new DiscordConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "k", scopes: [] });

    const result = await conn.listGuilds();
    expect(result).toEqual(guilds);
  });

  it("clamps limit to 200", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
      headers: { get: () => null },
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { DiscordConnector } = await import("../discord.js");
    const conn = new DiscordConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "k", scopes: [] });

    await conn.listGuilds({ limit: 999 });
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("limit=200");
  });
});

// ── listChannels ─────────────────────────────────────────────────────────────

describe("DiscordConnector.listChannels", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("filters out non-text channels (type !== 0)", async () => {
    const apiResponse = [
      { id: "c1", name: "general", type: 0, guild_id: "g1" }, // text — keep
      { id: "c2", name: "Voice Lobby", type: 2, guild_id: "g1" }, // voice — drop
      { id: "c3", name: "category", type: 4, guild_id: "g1" }, // category — drop
      { id: "c4", name: "thread", type: 11, guild_id: "g1" }, // thread — drop
      { id: "c5", name: "random", type: 0, guild_id: "g1" }, // text — keep
    ];
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => apiResponse,
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    const { DiscordConnector } = await import("../discord.js");
    const conn = new DiscordConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "k", scopes: [] });

    const channels = await conn.listChannels("g1");
    expect(channels.map((c) => c.id)).toEqual(["c1", "c5"]);
    expect(channels.every((c) => c.type === 0)).toBe(true);
  });
});

// ── listMessages ─────────────────────────────────────────────────────────────

describe("DiscordConnector.listMessages", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("passes limit through to the URL and clamps to 100", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: "m1",
          channel_id: "c1",
          content: "hi",
          timestamp: "2026-04-29T00:00:00Z",
          author: { id: "u1", username: "alice" },
        },
      ],
      headers: { get: () => null },
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { DiscordConnector } = await import("../discord.js");
    const conn = new DiscordConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "k", scopes: [] });

    const messages = await conn.listMessages("c1", { limit: 250 });
    expect(messages).toHaveLength(1);
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("/channels/c1/messages");
    expect(url).toContain("limit=100"); // clamped
  });
});

// ── Token refresh on 401 ─────────────────────────────────────────────────────

describe("DiscordConnector token refresh on 401", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-discord-refresh-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    process.env.DISCORD_CLIENT_ID = "cid";
    process.env.DISCORD_CLIENT_SECRET = "csecret";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("on 401, refreshes token and retries the API call once", async () => {
    // Three fetch calls in sequence:
    //   1) /users/@me → 401 (auth_expired, retryable per Discord normalizeError)
    //   2) /oauth2/token (refresh) → 200 with new access_token
    //   3) /users/@me retry → 200
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
          expires_in: 604800,
          scope: "identify guilds messages.read",
          token_type: "Bearer",
        }),
        headers: { get: () => null },
      })
      // retry: 200
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "u1", username: "patchwork" }),
        headers: { get: () => null },
      });

    global.fetch = fetchSpy as unknown as typeof fetch;

    const { DiscordConnector, saveTokens, loadTokens } = await import(
      "../discord.js"
    );
    // Pre-seed stored tokens with a refresh_token so the connector has something
    // to refresh with.
    saveTokens({
      access_token: "stale-access",
      refresh_token: "stale-refresh",
      expires_at: Date.now() + 60_000, // not yet expired by clock
      scope: "identify guilds messages.read",
      token_type: "Bearer",
      _client_id: "cid",
      _client_secret: "csecret",
      connected_at: new Date().toISOString(),
    });

    const conn = new DiscordConnector();
    // authenticate() will be called by apiCall on the first run since this.auth
    // starts null; it reads from loadTokens() which we pre-seeded above.
    const result = await conn.healthCheck();

    expect(result.ok).toBe(true);
    // Verify the three fetch calls happened in order.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const url1 = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    const url2 = String(fetchSpy.mock.calls[1]?.[0] ?? "");
    const url3 = String(fetchSpy.mock.calls[2]?.[0] ?? "");
    expect(url1).toContain("/users/@me");
    expect(url2).toContain("/oauth2/token");
    expect(url3).toContain("/users/@me");

    // Stored tokens should now reflect the refreshed access_token.
    const stored = loadTokens();
    expect(stored?.access_token).toBe("new-access");
    expect(stored?.refresh_token).toBe("new-refresh");
  });
});

// ── HTTP handlers ────────────────────────────────────────────────────────────

describe("handleDiscordAuthorize", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
  });

  it("returns 503 when DISCORD_CLIENT_ID/SECRET are not set", async () => {
    const { handleDiscordAuthorize } = await import("../discord.js");
    const result = handleDiscordAuthorize();
    expect(result.status).toBe(503);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/DISCORD_CLIENT_ID/);
  });

  it("returns 302 redirect with state when configured", async () => {
    process.env.DISCORD_CLIENT_ID = "cid";
    process.env.DISCORD_CLIENT_SECRET = "csecret";
    const { handleDiscordAuthorize } = await import("../discord.js");
    const result = handleDiscordAuthorize();
    expect(result.status).toBe(302);
    expect(result.redirect).toMatch(
      /^https:\/\/discord\.com\/api\/oauth2\/authorize\?/,
    );
    const url = new URL(result.redirect ?? "");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("identify guilds messages.read");
    expect(url.searchParams.get("state")).toBeTruthy();
  });
});

describe("handleDiscordTest", () => {
  it("returns 400 when not connected", async () => {
    const tmpDir = join(os.tmpdir(), `patchwork-discord-test-${Date.now()}`);
    process.env.HOME = join(tmpDir, "home");
    process.env.PATCHWORK_HOME = join(tmpDir, "home", ".patchwork");
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(join(process.env.PATCHWORK_HOME, "tokens"), { recursive: true });
    vi.resetModules();
    const { handleDiscordTest } = await import("../discord.js");
    const result = await handleDiscordTest();
    expect(result.status).toBe(400);
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("handleDiscordDisconnect", () => {
  it("returns 200 always", async () => {
    const tmpDir = join(
      os.tmpdir(),
      `patchwork-discord-disconnect-${Date.now()}`,
    );
    process.env.HOME = join(tmpDir, "home");
    process.env.PATCHWORK_HOME = join(tmpDir, "home", ".patchwork");
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(join(process.env.PATCHWORK_HOME, "tokens"), { recursive: true });
    vi.resetModules();
    const { handleDiscordDisconnect } = await import("../discord.js");
    const result = await handleDiscordDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── writes (sendMessage) ─────────────────────────────────────────────────────

describe("DiscordConnector.sendMessage (writes)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function mockOk(json: unknown) {
    return {
      ok: true,
      status: 200,
      json: async () => json,
      headers: { get: () => null },
    };
  }

  function mockResponseStatus(status: number) {
    const r = {
      ok: false,
      status,
      headers: { get: () => null },
    };
    Object.setPrototypeOf(r, Response.prototype);
    return r;
  }

  async function makeConnector() {
    const { DiscordConnector } = await import("../discord.js");
    const conn = new DiscordConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "k", scopes: [] });
    return conn;
  }

  it("happy path: POSTs to /channels/{id}/messages with {content, tts:false}", async () => {
    const sent = {
      id: "m99",
      channel_id: "c1",
      content: "hello",
      timestamp: "2026-04-29T12:00:00Z",
      author: { id: "u1", username: "alice" },
    };
    const fetchSpy = vi.fn().mockResolvedValueOnce(mockOk(sent));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const conn = await makeConnector();
    const result = await conn.sendMessage("c1", { content: "hello" });
    expect(result).toEqual(sent);

    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("/channels/c1/messages");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      content: "hello",
      tts: false,
    });
  });

  it("rejects empty channelId", async () => {
    const conn = await makeConnector();
    await expect(conn.sendMessage("", { content: "x" })).rejects.toThrow(
      /channelId/,
    );
  });

  it("rejects empty content", async () => {
    const conn = await makeConnector();
    await expect(conn.sendMessage("c1", { content: "" })).rejects.toThrow(
      /content/,
    );
  });

  it("rejects content longer than 2000 chars", async () => {
    const conn = await makeConnector();
    const long = "a".repeat(2001);
    await expect(conn.sendMessage("c1", { content: long })).rejects.toThrow(
      /2000/,
    );
  });

  it("403 surfaces permission_denied with bot-scope guidance", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(mockResponseStatus(403));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const conn = await makeConnector();
    await expect(conn.sendMessage("c1", { content: "hi" })).rejects.toThrow(
      /bot scope/i,
    );
  });

  it("404 surfaces not_found", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(mockResponseStatus(404));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const conn = await makeConnector();
    await expect(conn.sendMessage("c1", { content: "hi" })).rejects.toThrow(
      /not found/i,
    );
  });

  it("honors explicit tts: true", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      mockOk({
        id: "m1",
        channel_id: "c1",
        content: "spoken",
        timestamp: "2026-04-29T12:00:00Z",
        author: { id: "u1", username: "alice" },
      }),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const conn = await makeConnector();
    await conn.sendMessage("c1", { content: "spoken", tts: true });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      content: "spoken",
      tts: true,
    });
  });
});

// ── writes: refresh-on-401 ───────────────────────────────────────────────────

describe("DiscordConnector.sendMessage refresh on 401", () => {
  const tmpDir = join(
    os.tmpdir(),
    `patchwork-discord-write-refresh-${Date.now()}`,
  );
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    process.env.DISCORD_CLIENT_ID = "cid";
    process.env.DISCORD_CLIENT_SECRET = "csecret";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("on 401, refreshes token and retries the POST once", async () => {
    const expired = {
      ok: false,
      status: 401,
      headers: { get: () => null },
    };
    Object.setPrototypeOf(expired, Response.prototype);

    const fetchSpy = vi
      .fn()
      // initial POST: 401
      .mockResolvedValueOnce(expired)
      // refresh: 200
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 604800,
          scope: "identify guilds messages.read",
          token_type: "Bearer",
        }),
        headers: { get: () => null },
      })
      // retry POST: 200 with the message
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: "m42",
          channel_id: "c1",
          content: "after-refresh",
          timestamp: "2026-04-29T12:00:00Z",
          author: { id: "u1", username: "alice" },
        }),
        headers: { get: () => null },
      });

    global.fetch = fetchSpy as unknown as typeof fetch;

    const { DiscordConnector, saveTokens, loadTokens } = await import(
      "../discord.js"
    );
    saveTokens({
      access_token: "stale-access",
      refresh_token: "stale-refresh",
      expires_at: Date.now() + 60_000,
      scope: "identify guilds messages.read",
      token_type: "Bearer",
      _client_id: "cid",
      _client_secret: "csecret",
      connected_at: new Date().toISOString(),
    });

    const conn = new DiscordConnector();
    const result = await conn.sendMessage("c1", { content: "after-refresh" });

    expect(result.id).toBe("m42");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const url1 = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    const url2 = String(fetchSpy.mock.calls[1]?.[0] ?? "");
    const url3 = String(fetchSpy.mock.calls[2]?.[0] ?? "");
    expect(url1).toContain("/channels/c1/messages");
    expect(url2).toContain("/oauth2/token");
    expect(url3).toContain("/channels/c1/messages");

    const stored = loadTokens();
    expect(stored?.access_token).toBe("new-access");
  });
});
