import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("telegram token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-telegram-${Date.now()}`);
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
    delete process.env.TELEGRAM_BOT_TOKEN;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns env var without reading storage", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:abc-bot-token";
    const { loadTokens } = await import("../telegram.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.token).toBe("123:abc-bot-token");
  });

  it("loadTokens returns null when no env and no stored token", async () => {
    const { loadTokens } = await import("../telegram.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../telegram.js");
    const tokens = {
      token: "123:secret-bot-token",
      botUsername: "my_bot",
      botId: 123,
      connected_at: "2026-04-29T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      token: "123:secret-bot-token",
      botUsername: "my_bot",
    });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../telegram.js");
    expect(() => clearTokens()).not.toThrow();
  });
});

describe("TelegramConnector.healthCheck", () => {
  async function makeConn(fetchImpl: ReturnType<typeof vi.fn>) {
    global.fetch = fetchImpl as unknown as typeof fetch;
    vi.resetModules();
    const { TelegramConnector } = await import("../telegram.js");
    const conn = new TelegramConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "good", scopes: [] });
    return conn;
  }

  it("returns ok:true when getMe responds ok", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { id: 1, username: "bot" } }),
    });
    const conn = await makeConn(fetchSpy);

    const result = await conn.healthCheck();
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with auth_expired when Telegram rejects the token", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({
        ok: false,
        error_code: 401,
        description: "Unauthorized",
      }),
    });
    const conn = await makeConn(fetchSpy);

    const result = await conn.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("auth_expired");
  });
});

describe("TelegramConnector.sendMessage", () => {
  async function makeConn(fetchImpl: ReturnType<typeof vi.fn>) {
    global.fetch = fetchImpl as unknown as typeof fetch;
    vi.resetModules();
    const { TelegramConnector } = await import("../telegram.js");
    const conn = new TelegramConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "tok", scopes: [] });
    return conn;
  }

  it("embeds the token in the URL path (not a header) and POSTs chat_id/text", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { message_id: 42, date: 0, chat: { id: 555, type: "private" } },
      }),
    });
    const conn = await makeConn(fetchSpy);

    const result = await conn.sendMessage({ chatId: 555, text: "hello" });

    expect(result.message_id).toBe(42);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bottok/sendMessage");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe(555);
    expect(body.text).toBe("hello");
    expect(body.parse_mode).toBeUndefined();
  });

  it("includes parse_mode when supplied", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } },
      }),
    });
    const conn = await makeConn(fetchSpy);

    await conn.sendMessage({
      chatId: 1,
      text: "*bold*",
      parseMode: "Markdown",
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.parse_mode).toBe("Markdown");
  });

  it("translates a Telegram-level error (ok:false in a 200 response) into a thrown message", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: false,
        error_code: 400,
        description: "Bad Request: chat not found",
      }),
    });
    const conn = await makeConn(fetchSpy);

    await expect(conn.sendMessage({ chatId: 999, text: "hi" })).rejects.toThrow(
      /chat not found/i,
    );
  });

  it("translates HTTP 429 to a retryable rate_limited error", async () => {
    // 429 is retryable — apiCall retries internally (default 2 retries, 3
    // attempts total) before giving up, so the mock must keep returning the
    // same response rather than being exhausted after one call.
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
      }),
    });
    const conn = await makeConn(fetchSpy);

    await expect(conn.sendMessage({ chatId: 1, text: "hi" })).rejects.toThrow(
      /Too Many Requests/i,
    );
  }, 10000);
});

describe("TelegramConnector.getChat", () => {
  it("passes chat_id as a query param", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { id: 555, type: "group", title: "Ops Room" },
      }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    vi.resetModules();
    const { TelegramConnector } = await import("../telegram.js");
    const conn = new TelegramConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "tok", scopes: [] });

    const chat = await conn.getChat(555);
    expect(chat.title).toBe("Ops Room");
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("chat_id=555");
    expect(url).toContain("/bottok/getChat");
  });
});

describe("TelegramConnector.getUpdates", () => {
  it("defaults limit to 25 and includes offset when supplied", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: [] }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    vi.resetModules();
    const { TelegramConnector } = await import("../telegram.js");
    const conn = new TelegramConnector();
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "tok", scopes: [] });

    const { updates } = await conn.getUpdates({ offset: 100 });
    expect(updates).toEqual([]);
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("offset=100");
    expect(url).toContain("limit=25");
  });
});

describe("handleTelegramConnect", () => {
  it("returns 400 when token missing", async () => {
    vi.resetModules();
    const { handleTelegramConnect } = await import("../telegram.js");
    const result = await handleTelegramConnect(JSON.stringify({}));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 on invalid JSON", async () => {
    vi.resetModules();
    const { handleTelegramConnect } = await import("../telegram.js");
    const result = await handleTelegramConnect("not-json");
    expect(result.status).toBe(400);
  });

  it("returns 401 when Telegram rejects the bot token", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({
        ok: false,
        error_code: 401,
        description: "Unauthorized",
      }),
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleTelegramConnect } = await import("../telegram.js");
    const result = await handleTelegramConnect(
      JSON.stringify({ token: "bad" }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 and stores tokens on success", async () => {
    const tmpDir2 = join(
      os.tmpdir(),
      `patchwork-telegram-connect-${Date.now()}`,
    );
    const pHome = join(tmpDir2, ".patchwork");
    mkdirSync(join(pHome, "tokens"), { recursive: true });
    process.env.PATCHWORK_HOME = pHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { id: 999, username: "my_bot" },
      }),
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleTelegramConnect, loadTokens } = await import(
      "../telegram.js"
    );
    const result = await handleTelegramConnect(
      JSON.stringify({ token: "999:good-token" }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.botUsername).toBe("my_bot");

    const stored = loadTokens();
    expect(stored?.token).toBe("999:good-token");
    expect(stored?.botUsername).toBe("my_bot");

    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("handleTelegramTest", () => {
  it("returns 400 when not connected", async () => {
    vi.resetModules();
    const { handleTelegramTest } = await import("../telegram.js");
    const result = await handleTelegramTest();
    expect(result.status).toBe(400);
  });
});

describe("handleTelegramDisconnect", () => {
  it("returns 200 always", async () => {
    vi.resetModules();
    const { handleTelegramDisconnect } = await import("../telegram.js");
    const result = handleTelegramDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
