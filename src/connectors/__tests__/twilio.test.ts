import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmpDir = join(os.tmpdir(), `patchwork-twilio-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

const ACCOUNT_SID = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const AUTH_TOKEN = "secret-auth-token";

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_DEFAULT_FROM;
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_DEFAULT_FROM;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function mockFetchOnce(response: Partial<Response> & { json?: () => unknown }) {
  const fn = vi.fn(async () =>
    Object.assign(
      {
        ok: true,
        status: 200,
        json: async () => ({}),
      },
      response,
    ),
  );
  // @ts-expect-error — global fetch mock
  global.fetch = fn;
  return fn;
}

function saveValidTokens(extra: Partial<Record<string, string>> = {}) {
  return import("../twilio.js").then(({ saveTokens }) => {
    saveTokens({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      defaultFrom: extra.defaultFrom,
      connected_at: new Date().toISOString(),
    });
  });
}

// ── normalizeError ──────────────────────────────────────────────────────────

describe("normalizeError", () => {
  it("maps Response status codes to ConnectorError shapes", async () => {
    const { TwilioConnector } = await import("../twilio.js");
    const c = new TwilioConnector();
    expect(c.normalizeError(new Response(null, { status: 401 })).code).toBe(
      "auth_expired",
    );
    expect(c.normalizeError(new Response(null, { status: 403 })).code).toBe(
      "permission_denied",
    );
    expect(c.normalizeError(new Response(null, { status: 404 })).code).toBe(
      "not_found",
    );
    expect(c.normalizeError(new Response(null, { status: 429 })).code).toBe(
      "rate_limited",
    );
    expect(c.normalizeError(new Response(null, { status: 500 })).code).toBe(
      "provider_error",
    );
  });

  it("marks 429 + 5xx retryable, 401/403/404 not retryable", async () => {
    const { TwilioConnector } = await import("../twilio.js");
    const c = new TwilioConnector();
    expect(
      c.normalizeError(new Response(null, { status: 429 })).retryable,
    ).toBe(true);
    expect(
      c.normalizeError(new Response(null, { status: 503 })).retryable,
    ).toBe(true);
    expect(
      c.normalizeError(new Response(null, { status: 401 })).retryable,
    ).toBe(false);
    expect(
      c.normalizeError(new Response(null, { status: 404 })).retryable,
    ).toBe(false);
  });

  it("extracts Twilio JSON {code, message} into provider_error text", async () => {
    const { TwilioConnector } = await import("../twilio.js");
    const c = new TwilioConnector();
    const e = c.normalizeError({
      code: 21211,
      message: "Invalid 'To' Phone Number",
      status: 400,
    });
    expect(e.code).toBe("provider_error");
    expect(e.message).toContain("21211");
    expect(e.message).toContain("Invalid 'To' Phone Number");
  });

  it("detects ENOTFOUND as network_error retryable", async () => {
    const { TwilioConnector } = await import("../twilio.js");
    const c = new TwilioConnector();
    const e = c.normalizeError(
      new Error("getaddrinfo ENOTFOUND api.twilio.com"),
    );
    expect(e.code).toBe("network_error");
    expect(e.retryable).toBe(true);
  });
});

// ── sendSms validation ──────────────────────────────────────────────────────

describe("sendSms", () => {
  it("rejects non-E.164 'to' numbers", async () => {
    const { getTwilioConnector } = await import("../twilio.js");
    await saveValidTokens({ defaultFrom: "+14155550100" });
    const c = getTwilioConnector();
    await expect(c.sendSms({ to: "5551234", body: "hi" })).rejects.toThrow(
      /E\.164/,
    );
    await expect(c.sendSms({ to: "14155551234", body: "hi" })).rejects.toThrow(
      /E\.164/,
    );
    await expect(c.sendSms({ to: "+1abc", body: "hi" })).rejects.toThrow(
      /E\.164/,
    );
  });

  it("accepts valid E.164 numbers", async () => {
    const { getTwilioConnector } = await import("../twilio.js");
    await saveValidTokens({ defaultFrom: "+14155550100" });
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 201,
      json: async () => ({ sid: "SM123", to: "+14155551234" }),
    });
    const c = getTwilioConnector();
    const result = await c.sendSms({ to: "+14155551234", body: "hi" });
    expect(result.sid).toBe("SM123");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("requires body", async () => {
    const { getTwilioConnector } = await import("../twilio.js");
    await saveValidTokens({ defaultFrom: "+14155550100" });
    const c = getTwilioConnector();
    await expect(c.sendSms({ to: "+14155551234", body: "" })).rejects.toThrow(
      /body/,
    );
  });

  it("throws when no 'from' provided and no defaultFrom", async () => {
    const { getTwilioConnector } = await import("../twilio.js");
    await saveValidTokens(); // no defaultFrom
    const c = getTwilioConnector();
    await expect(c.sendSms({ to: "+14155551234", body: "hi" })).rejects.toThrow(
      /defaultFrom/,
    );
  });

  it("uses stored defaultFrom when 'from' omitted", async () => {
    const { getTwilioConnector } = await import("../twilio.js");
    await saveValidTokens({ defaultFrom: "+14155550100" });
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 201,
      json: async () => ({ sid: "SM999" }),
    });
    const c = getTwilioConnector();
    await c.sendSms({ to: "+14155551234", body: "hi" });
    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(String(init.body)).toContain("From=%2B14155550100");
    expect(String(init.body)).toContain("To=%2B14155551234");
    expect(String(init.body)).toContain("Body=hi");
  });

  it("rejects non-E.164 'from'", async () => {
    const { getTwilioConnector } = await import("../twilio.js");
    await saveValidTokens();
    const c = getTwilioConnector();
    await expect(
      c.sendSms({ to: "+14155551234", body: "hi", from: "555-bad" }),
    ).rejects.toThrow(/E\.164/);
  });
});

// ── listMessages query params ───────────────────────────────────────────────

describe("listMessages", () => {
  it("builds correct query params with PageSize + filters", async () => {
    const { getTwilioConnector } = await import("../twilio.js");
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [], page: 0, page_size: 50 }),
    });
    const c = getTwilioConnector();
    await c.listMessages({
      to: "+14155551234",
      from: "+14155550100",
      dateSent: "2026-01-01",
      limit: 50,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("PageSize=50");
    expect(url).toContain("To=%2B14155551234");
    expect(url).toContain("From=%2B14155550100");
    expect(url).toContain("DateSent=2026-01-01");
    expect(url).toContain(`/Accounts/${ACCOUNT_SID}/Messages.json`);
  });

  it("defaults PageSize to 20", async () => {
    const { getTwilioConnector } = await import("../twilio.js");
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [], page: 0, page_size: 20 }),
    });
    const c = getTwilioConnector();
    await c.listMessages();
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("PageSize=20");
  });
});

// ── connect handler ─────────────────────────────────────────────────────────

describe("handleTwilioConnect", () => {
  it("rejects invalid JSON", async () => {
    const { handleTwilioConnect } = await import("../twilio.js");
    const r = await handleTwilioConnect("not json");
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid JSON/);
  });

  it("requires accountSid + authToken", async () => {
    const { handleTwilioConnect } = await import("../twilio.js");
    const r1 = await handleTwilioConnect(JSON.stringify({}));
    expect(r1.status).toBe(400);
    const r2 = await handleTwilioConnect(
      JSON.stringify({ accountSid: ACCOUNT_SID }),
    );
    expect(r2.status).toBe(400);
    expect(r2.body).toMatch(/authToken/);
  });

  it("rejects accountSid that doesn't start with 'AC'", async () => {
    const { handleTwilioConnect } = await import("../twilio.js");
    const r = await handleTwilioConnect(
      JSON.stringify({ accountSid: "XX123", authToken: AUTH_TOKEN }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/AC/);
  });

  it("rejects non-E.164 defaultFrom", async () => {
    const { handleTwilioConnect } = await import("../twilio.js");
    const r = await handleTwilioConnect(
      JSON.stringify({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        defaultFrom: "555-not-e164",
      }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/E\.164/);
  });

  it("captures friendly_name + sid on success and stores tokens", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        sid: ACCOUNT_SID,
        friendly_name: "Test Acme Account",
      }),
    });
    const { handleTwilioConnect, loadTokens } = await import("../twilio.js");
    const r = await handleTwilioConnect(
      JSON.stringify({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        defaultFrom: "+14155550100",
      }),
    );
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body) as {
      ok: boolean;
      friendlyName?: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.friendlyName).toBe("Test Acme Account");
    const tokens = loadTokens();
    expect(tokens?.friendlyName).toBe("Test Acme Account");
    expect(tokens?.defaultFrom).toBe("+14155550100");
    expect(tokens?.accountSid).toBe(ACCOUNT_SID);
  });

  it("returns 401 on credentials rejected without storing tokens", async () => {
    mockFetchOnce({
      ok: false,
      status: 401,
      json: async () => ({ code: 20003, message: "Authenticate" }),
    });
    const { handleTwilioConnect, loadTokens } = await import("../twilio.js");
    const r = await handleTwilioConnect(
      JSON.stringify({ accountSid: ACCOUNT_SID, authToken: "wrong" }),
    );
    expect(r.status).toBe(401);
    expect(loadTokens()).toBeNull();
  });
});

// ── env override ────────────────────────────────────────────────────────────

describe("env override", () => {
  it("loadTokens reads from TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN", async () => {
    process.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.TWILIO_DEFAULT_FROM = "+14155550100";
    const { loadTokens } = await import("../twilio.js");
    const t = loadTokens();
    expect(t?.accountSid).toBe(ACCOUNT_SID);
    expect(t?.authToken).toBe(AUTH_TOKEN);
    expect(t?.defaultFrom).toBe("+14155550100");
  });
});
