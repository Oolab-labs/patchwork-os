import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------------ helpers

function makeBooking(uid: string): object {
  return {
    uid,
    title: "Test Meeting",
    start: "2026-06-01T10:00:00Z",
    end: "2026-06-01T11:00:00Z",
    status: "accepted",
    attendees: [{ name: "Alice", email: "alice@example.com", timeZone: "UTC" }],
  };
}

function mockOkJson(data: unknown): typeof fetch {
  return vi.fn().mockResolvedValueOnce({
    ok: true,
    json: async () => ({ status: "success", data }),
  }) as unknown as typeof fetch;
}

function mockHttpError(status: number): typeof fetch {
  return vi.fn().mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({ message: `HTTP ${status}` }),
  }) as unknown as typeof fetch;
}

// ------------------------------------------------------------------ token helpers

describe("caldiy token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-caldiy-${Date.now()}`);
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
    delete process.env.CALCOM_API_KEY;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns env token without reading storage", async () => {
    process.env.CALCOM_API_KEY = "cal_live_abc123";
    const { loadTokens } = await import("../caldiy.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.apiKey).toBe("cal_live_abc123");
    expect(tokens!.baseUrl).toBe("https://api.cal.com/v2");
  });

  it("loadTokens returns null when no env and no stored token", async () => {
    const { loadTokens } = await import("../caldiy.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips through file storage", async () => {
    const { loadTokens, saveTokens } = await import("../caldiy.js");
    const tokens = {
      apiKey: "cal_live_stored",
      baseUrl: "https://api.cal.com/v2",
      username: "janedoe",
      connected_at: "2026-06-01T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      apiKey: "cal_live_stored",
      username: "janedoe",
    });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../caldiy.js");
    expect(() => clearTokens()).not.toThrow();
  });
});

// ------------------------------------------------------------------ getBookings

describe("CalDiyConnector.getBookings", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CALCOM_API_KEY = "cal_live_test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CALCOM_API_KEY;
  });

  it("returns array of bookings with no filters", async () => {
    const bookings = [makeBooking("uid-1"), makeBooking("uid-2")];
    global.fetch = mockOkJson(bookings);

    const { CalDiyConnector } = await import("../caldiy.js");
    const conn = new CalDiyConnector();
    const result = await conn.getBookings();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ uid: "uid-1" });
  });

  it("appends query params when filters are provided", async () => {
    global.fetch = mockOkJson([makeBooking("uid-3")]);

    const { CalDiyConnector } = await import("../caldiy.js");
    const conn = new CalDiyConnector();
    await conn.getBookings({
      status: "accepted",
      attendeeEmail: "alice@example.com",
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
    });

    const url = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(url).toContain("status=accepted");
    expect(url).toContain("attendeeEmail=alice%40example.com");
    expect(url).toContain("dateFrom=2026-06-01");
    expect(url).toContain("dateTo=2026-06-30");
  });

  it("sends correct auth headers", async () => {
    global.fetch = mockOkJson([]);

    const { CalDiyConnector } = await import("../caldiy.js");
    const conn = new CalDiyConnector();
    await conn.getBookings();

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cal_live_test");
    expect(headers["cal-api-version"]).toBe("2024-09-04");
  });

  it("throws on 401 with auth_expired error", async () => {
    global.fetch = mockHttpError(401);

    const { CalDiyConnector } = await import("../caldiy.js");
    const conn = new CalDiyConnector();
    await expect(conn.getBookings()).rejects.toThrow();
  });

  it("throws on 404 with not_found error", async () => {
    global.fetch = mockHttpError(404);

    const { CalDiyConnector } = await import("../caldiy.js");
    const conn = new CalDiyConnector();
    await expect(conn.getBookings()).rejects.toThrow();
  });
});

// ------------------------------------------------------------------ cancelBooking

describe("CalDiyConnector.cancelBooking", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CALCOM_API_KEY = "cal_live_test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CALCOM_API_KEY;
  });

  it("sends DELETE to /bookings/{uid}", async () => {
    global.fetch = mockOkJson({ uid: "uid-cancel-1" });

    const { CalDiyConnector } = await import("../caldiy.js");
    const conn = new CalDiyConnector();
    const result = await conn.cancelBooking("uid-cancel-1");
    expect(result).toMatchObject({ uid: "uid-cancel-1" });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toContain("/bookings/uid-cancel-1");
    expect(init.method).toBe("DELETE");
  });

  it("sends reason in body when provided", async () => {
    global.fetch = mockOkJson({ uid: "uid-cancel-2" });

    const { CalDiyConnector } = await import("../caldiy.js");
    const conn = new CalDiyConnector();
    await conn.cancelBooking("uid-cancel-2", "Schedule conflict");

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    expect(init.body).toBeDefined();
    const body = JSON.parse(init.body as string) as { reason: string };
    expect(body.reason).toBe("Schedule conflict");
  });

  it("sends no body when reason is not provided", async () => {
    global.fetch = mockOkJson({ uid: "uid-cancel-3" });

    const { CalDiyConnector } = await import("../caldiy.js");
    const conn = new CalDiyConnector();
    await conn.cancelBooking("uid-cancel-3");

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    expect(init.body).toBeUndefined();
  });
});

// ------------------------------------------------------------------ verifyCalDiyWebhook

describe("verifyCalDiyWebhook", () => {
  it("returns true for valid HMAC-SHA256 signature", async () => {
    const { verifyCalDiyWebhook } = await import("../caldiy.js");
    const secret = "my-webhook-secret";
    const body = JSON.stringify({ event: "BOOKING_CREATED", uid: "abc" });
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyCalDiyWebhook(body, signature, secret)).toBe(true);
  });

  it("returns false for tampered body", async () => {
    const { verifyCalDiyWebhook } = await import("../caldiy.js");
    const secret = "my-webhook-secret";
    const originalBody = JSON.stringify({
      event: "BOOKING_CREATED",
      uid: "abc",
    });
    const signature = createHmac("sha256", secret)
      .update(originalBody)
      .digest("hex");
    const tamperedBody = JSON.stringify({
      event: "BOOKING_CANCELLED",
      uid: "abc",
    });
    expect(verifyCalDiyWebhook(tamperedBody, signature, secret)).toBe(false);
  });

  it("returns false for wrong secret", async () => {
    const { verifyCalDiyWebhook } = await import("../caldiy.js");
    const body = JSON.stringify({ event: "BOOKING_CREATED" });
    const signature = createHmac("sha256", "correct-secret")
      .update(body)
      .digest("hex");
    expect(verifyCalDiyWebhook(body, signature, "wrong-secret")).toBe(false);
  });

  it("returns false for empty signature header", async () => {
    const { verifyCalDiyWebhook } = await import("../caldiy.js");
    const body = "{}";
    expect(verifyCalDiyWebhook(body, "", "secret")).toBe(false);
  });

  it("accepts Buffer rawBody", async () => {
    const { verifyCalDiyWebhook } = await import("../caldiy.js");
    const secret = "buf-secret";
    const body = Buffer.from('{"event":"test"}', "utf8");
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyCalDiyWebhook(body, signature, secret)).toBe(true);
  });
});

// ------------------------------------------------------------------ handleCalDiyConnect

describe("handleCalDiyConnect", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CALCOM_API_KEY;
  });

  it("rejects missing apiKey", async () => {
    const { handleCalDiyConnect } = await import("../caldiy.js");
    const result = await handleCalDiyConnect(JSON.stringify({}));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("rejects invalid JSON body", async () => {
    const { handleCalDiyConnect } = await import("../caldiy.js");
    const result = await handleCalDiyConnect("not json");
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 401 when Cal.diy API rejects the key", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    const { handleCalDiyConnect } = await import("../caldiy.js");
    const result = await handleCalDiyConnect(
      JSON.stringify({ apiKey: "cal_live_invalid" }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("stores tokens and returns ok=true on success", async () => {
    const tmpDir2 = join(os.tmpdir(), `patchwork-caldiy-hc-${Date.now()}`);
    const homeDir2 = join(tmpDir2, "home");
    const patchworkHome2 = join(homeDir2, ".patchwork");
    mkdirSync(join(patchworkHome2, "tokens"), { recursive: true });
    process.env.HOME = homeDir2;
    process.env.PATCHWORK_HOME = patchworkHome2;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "success",
        data: {
          id: 1,
          username: "johndoe",
          email: "john@example.com",
          name: "John Doe",
          timeZone: "UTC",
          weekStart: "Sunday",
        },
      }),
    }) as unknown as typeof fetch;

    const { handleCalDiyConnect, loadTokens } = await import("../caldiy.js");
    const result = await handleCalDiyConnect(
      JSON.stringify({ apiKey: "cal_live_good" }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { ok: boolean; username: string };
    expect(body.ok).toBe(true);
    expect(body.username).toBe("johndoe");

    const stored = loadTokens();
    expect(stored?.apiKey).toBe("cal_live_good");

    rmSync(tmpDir2, { recursive: true, force: true });
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  });

  it("uses custom baseUrl when provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "success",
        data: {
          id: 2,
          username: "self",
          email: "self@example.com",
          name: "Self Hosted",
          timeZone: "UTC",
          weekStart: "Monday",
        },
      }),
    }) as unknown as typeof fetch;

    const tmpDir3 = join(os.tmpdir(), `patchwork-caldiy-bu-${Date.now()}`);
    const homeDir3 = join(tmpDir3, "home");
    const patchworkHome3 = join(homeDir3, ".patchwork");
    mkdirSync(join(patchworkHome3, "tokens"), { recursive: true });
    process.env.HOME = homeDir3;
    process.env.PATCHWORK_HOME = patchworkHome3;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    const { handleCalDiyConnect } = await import("../caldiy.js");
    await handleCalDiyConnect(
      JSON.stringify({
        apiKey: "cal_self_key",
        baseUrl: "https://cal.example.com/api/v2",
      }),
    );

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toContain("cal.example.com");

    rmSync(tmpDir3, { recursive: true, force: true });
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  });
});

// ------------------------------------------------------------------ handleCalDiyTest

describe("handleCalDiyTest", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CALCOM_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when not connected", async () => {
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    const tmpDir4 = join(os.tmpdir(), `patchwork-caldiy-t-${Date.now()}`);
    const homeDir4 = join(tmpDir4, "home");
    mkdirSync(join(homeDir4, ".patchwork", "tokens"), { recursive: true });
    process.env.HOME = homeDir4;
    process.env.PATCHWORK_HOME = join(homeDir4, ".patchwork");

    const { handleCalDiyTest } = await import("../caldiy.js");
    const result = await handleCalDiyTest();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);

    rmSync(tmpDir4, { recursive: true, force: true });
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  });

  it("returns 200 when health check passes", async () => {
    process.env.CALCOM_API_KEY = "cal_live_healthy";
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "success",
        data: {
          id: 1,
          username: "healthy",
          email: "h@example.com",
          name: "Healthy",
          timeZone: "UTC",
          weekStart: "Sunday",
        },
      }),
    }) as unknown as typeof fetch;

    const { handleCalDiyTest, resetCalDiyConnector } = await import(
      "../caldiy.js"
    );
    resetCalDiyConnector();
    const result = await handleCalDiyTest();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});

// ------------------------------------------------------------------ handleCalDiyDisconnect

describe("handleCalDiyDisconnect", () => {
  it("returns ok:true", async () => {
    const { handleCalDiyDisconnect } = await import("../caldiy.js");
    const result = handleCalDiyDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
