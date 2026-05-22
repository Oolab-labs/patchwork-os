import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Fake fetch helpers ──────────────────────────────────────────────────────

type FetchCall = { url: string; init?: RequestInit };

function mockFetchResponse(opts: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}): Response {
  const status = opts.status ?? 200;
  const headers = new Headers(opts.headers ?? {});
  const bodyStr =
    opts.body === undefined
      ? ""
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
  return new Response(bodyStr, { status, headers });
}

function installFetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  // Cast — Node global fetch type.
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fn as unknown as typeof fetch;
  return { calls };
}

// ── Test harness ────────────────────────────────────────────────────────────

const tmpDir = join(os.tmpdir(), `patchwork-sendgrid-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  delete process.env.SENDGRID_API_KEY;
  delete process.env.SENDGRID_FROM_EMAIL;
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.SENDGRID_API_KEY;
  delete process.env.SENDGRID_FROM_EMAIL;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── normalizeError status mapping ───────────────────────────────────────────

describe("normalizeError", () => {
  it("maps 401 → auth_expired", async () => {
    const { SendGridConnector } = await import("../sendgrid.js");
    const c = new SendGridConnector();
    const err = c.normalizeError(new Response("", { status: 401 }));
    expect(err.code).toBe("auth_expired");
    expect(err.retryable).toBe(false);
  });

  it("maps 403 → permission_denied", async () => {
    const { SendGridConnector } = await import("../sendgrid.js");
    const c = new SendGridConnector();
    expect(c.normalizeError(new Response("", { status: 403 })).code).toBe(
      "permission_denied",
    );
  });

  it("maps 404 → not_found", async () => {
    const { SendGridConnector } = await import("../sendgrid.js");
    const c = new SendGridConnector();
    expect(c.normalizeError(new Response("", { status: 404 })).code).toBe(
      "not_found",
    );
  });

  it("maps 413 → provider_error (payload too large)", async () => {
    const { SendGridConnector } = await import("../sendgrid.js");
    const c = new SendGridConnector();
    const e = c.normalizeError(new Response("", { status: 413 }));
    expect(e.code).toBe("provider_error");
    expect(e.message).toMatch(/too large/i);
    expect(e.retryable).toBe(false);
  });

  it("maps 429 → rate_limited retryable", async () => {
    const { SendGridConnector } = await import("../sendgrid.js");
    const c = new SendGridConnector();
    const e = c.normalizeError(new Response("", { status: 429 }));
    expect(e.code).toBe("rate_limited");
    expect(e.retryable).toBe(true);
  });

  it("maps 5xx → provider_error retryable", async () => {
    const { SendGridConnector } = await import("../sendgrid.js");
    const c = new SendGridConnector();
    const e = c.normalizeError(new Response("", { status: 503 }));
    expect(e.code).toBe("provider_error");
    expect(e.retryable).toBe(true);
  });

  it("maps unexpected 4xx → provider_error non-retryable", async () => {
    const { SendGridConnector } = await import("../sendgrid.js");
    const c = new SendGridConnector();
    const e = c.normalizeError(new Response("", { status: 418 }));
    expect(e.code).toBe("provider_error");
    expect(e.retryable).toBe(false);
  });

  it("detects ENOTFOUND/ECONNREFUSED as network_error", async () => {
    const { SendGridConnector } = await import("../sendgrid.js");
    const c = new SendGridConnector();
    expect(
      c.normalizeError(new Error("getaddrinfo ENOTFOUND api.sendgrid.com"))
        .code,
    ).toBe("network_error");
    expect(c.normalizeError(new Error("connect ECONNREFUSED")).code).toBe(
      "network_error",
    );
  });

  it("defaults to provider_error", async () => {
    const { SendGridConnector } = await import("../sendgrid.js");
    const c = new SendGridConnector();
    expect(c.normalizeError(new Error("boom")).code).toBe("provider_error");
    expect(c.normalizeError("string err").code).toBe("provider_error");
  });
});

// ── send() validation ───────────────────────────────────────────────────────

describe("send()", () => {
  it("rejects missing/invalid `to`", async () => {
    const { getSendGridConnector, saveTokens } = await import("../sendgrid.js");
    saveTokens({
      apiKey: "SG.test",
      fromEmail: "from@example.com",
      connected_at: new Date().toISOString(),
    });
    const c = getSendGridConnector();
    await expect(
      c.send({ to: "not-an-email", subject: "hi", text: "x" }),
    ).rejects.toThrow(/valid email/i);
  });

  it("rejects missing subject", async () => {
    const { getSendGridConnector, saveTokens } = await import("../sendgrid.js");
    saveTokens({
      apiKey: "SG.test",
      fromEmail: "from@example.com",
      connected_at: new Date().toISOString(),
    });
    const c = getSendGridConnector();
    await expect(
      c.send({ to: "a@b.com", subject: "  ", text: "x" }),
    ).rejects.toThrow(/subject/i);
  });

  it("rejects when neither text nor html provided", async () => {
    const { getSendGridConnector, saveTokens } = await import("../sendgrid.js");
    saveTokens({
      apiKey: "SG.test",
      fromEmail: "from@example.com",
      connected_at: new Date().toISOString(),
    });
    const c = getSendGridConnector();
    await expect(c.send({ to: "a@b.com", subject: "hi" })).rejects.toThrow(
      /text.*html/i,
    );
  });

  it("rejects when no `from` and no stored fromEmail", async () => {
    const { getSendGridConnector, saveTokens } = await import("../sendgrid.js");
    saveTokens({
      apiKey: "SG.test",
      // no fromEmail
      connected_at: new Date().toISOString(),
    });
    const c = getSendGridConnector();
    await expect(
      c.send({ to: "a@b.com", subject: "hi", text: "x" }),
    ).rejects.toThrow(/from/i);
  });

  it("happy path: POSTs to /v3/mail/send and returns message id", async () => {
    const { getSendGridConnector, saveTokens } = await import("../sendgrid.js");
    saveTokens({
      apiKey: "SG.test",
      fromEmail: "from@example.com",
      connected_at: new Date().toISOString(),
    });
    const { calls } = installFetchMock(() =>
      mockFetchResponse({
        status: 202,
        headers: { "x-message-id": "msg-abc-123" },
      }),
    );
    const c = getSendGridConnector();
    // Force authenticate first so apiCall has an auth context.
    await c["authenticate"]();
    const result = await c.send({
      to: "a@b.com",
      subject: "hi",
      text: "hello",
    });
    expect(result.messageId).toBe("msg-abc-123");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer SG.test");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.from.email).toBe("from@example.com");
    expect(body.personalizations[0].to[0].email).toBe("a@b.com");
    expect(body.subject).toBe("hi");
    expect(body.content[0]).toEqual({ type: "text/plain", value: "hello" });
  });
});

// ── HTTP connect handler ────────────────────────────────────────────────────

describe("handleSendGridConnect", () => {
  it("rejects invalid JSON", async () => {
    const { handleSendGridConnect } = await import("../sendgrid.js");
    const r = await handleSendGridConnect("not json");
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid JSON/);
  });

  it("requires apiKey", async () => {
    const { handleSendGridConnect } = await import("../sendgrid.js");
    const r = await handleSendGridConnect(JSON.stringify({}));
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/apiKey/);
  });

  it("rejects malformed fromEmail", async () => {
    const { handleSendGridConnect } = await import("../sendgrid.js");
    const r = await handleSendGridConnect(
      JSON.stringify({ apiKey: "SG.test", fromEmail: "nope" }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/fromEmail/);
  });

  it("validates by GET /v3/user/profile, captures username", async () => {
    const { handleSendGridConnect, loadTokens } = await import(
      "../sendgrid.js"
    );
    const { calls } = installFetchMock(() =>
      mockFetchResponse({
        status: 200,
        body: { username: "acme-co", email: "ops@acme.test" },
      }),
    );
    const r = await handleSendGridConnect(
      JSON.stringify({ apiKey: "SG.test", fromEmail: "from@acme.test" }),
    );
    expect(r.status).toBe(200);
    expect(calls[0]!.url).toBe("https://api.sendgrid.com/v3/user/profile");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer SG.test");
    const tokens = loadTokens();
    expect(tokens?.apiKey).toBe("SG.test");
    expect(tokens?.accountName).toBe("acme-co");
    expect(tokens?.fromEmail).toBe("from@acme.test");
  });

  it("returns 401 on profile fetch failure without storing tokens", async () => {
    const { handleSendGridConnect, loadTokens } = await import(
      "../sendgrid.js"
    );
    installFetchMock(() => mockFetchResponse({ status: 401 }));
    const r = await handleSendGridConnect(JSON.stringify({ apiKey: "SG.bad" }));
    expect(r.status).toBe(401);
    expect(loadTokens()).toBeNull();
  });
});

// ── getStatus ───────────────────────────────────────────────────────────────

describe("getStatus", () => {
  it("reports disconnected when no tokens", async () => {
    const { SendGridConnector } = await import("../sendgrid.js");
    const c = new SendGridConnector();
    expect(c.getStatus().status).toBe("disconnected");
  });

  it("reports connected when tokens stored", async () => {
    const { SendGridConnector, saveTokens } = await import("../sendgrid.js");
    saveTokens({
      apiKey: "SG.x",
      fromEmail: "f@x.com",
      accountName: "acme",
      connected_at: new Date().toISOString(),
    });
    const c = new SendGridConnector();
    const status = c.getStatus();
    expect(status.status).toBe("connected");
    expect(status.workspace).toMatch(/acme/);
  });
});
