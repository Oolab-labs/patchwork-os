import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Fetch mock helper ──────────────────────────────────────────────────────

type FetchCall = { url: string; init?: RequestInit };

function installFetchMock(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({ url: u, init });
    return responder(u, init);
  });
  // @ts-expect-error — override global fetch
  globalThis.fetch = fn;
  return { calls, fn };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Test harness ───────────────────────────────────────────────────────────

const tmpDir = join(os.tmpdir(), `patchwork-resend-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  delete process.env.RESEND_API_KEY;
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.RESEND_API_KEY;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── normalizeError ─────────────────────────────────────────────────────────

describe("normalizeError", () => {
  it("maps HTTP status codes from Response", async () => {
    const { ResendConnector } = await import("../resend.js");
    const c = new ResendConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(401)).code).toBe("auth_expired");
    expect(c.normalizeError(make(403)).code).toBe("permission_denied");
    expect(c.normalizeError(make(404)).code).toBe("not_found");
    expect(c.normalizeError(make(422)).code).toBe("validation_error");
    expect(c.normalizeError(make(429)).code).toBe("rate_limited");
    expect(c.normalizeError(make(500)).code).toBe("provider_error");
  });

  it("marks 429 + 5xx retryable; 4xx non-retryable", async () => {
    const { ResendConnector } = await import("../resend.js");
    const c = new ResendConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(429)).retryable).toBe(true);
    expect(c.normalizeError(make(503)).retryable).toBe(true);
    expect(c.normalizeError(make(401)).retryable).toBe(false);
    expect(c.normalizeError(make(403)).retryable).toBe(false);
    expect(c.normalizeError(make(404)).retryable).toBe(false);
    expect(c.normalizeError(make(422)).retryable).toBe(false);
  });

  it("detects ENOTFOUND/ECONNREFUSED as network_error", async () => {
    const { ResendConnector } = await import("../resend.js");
    const c = new ResendConnector();
    expect(
      c.normalizeError(new Error("getaddrinfo ENOTFOUND api.resend.com")).code,
    ).toBe("network_error");
    expect(c.normalizeError(new Error("ECONNREFUSED")).code).toBe(
      "network_error",
    );
  });

  it("defaults to provider_error for unknown errors", async () => {
    const { ResendConnector } = await import("../resend.js");
    const c = new ResendConnector();
    expect(c.normalizeError(new Error("boom")).code).toBe("provider_error");
    expect(c.normalizeError("plain string").code).toBe("provider_error");
  });
});

// ── sendEmail ─────────────────────────────────────────────────────────────

describe("sendEmail", () => {
  it("POSTs to /emails with correct body and auth header", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const { getResendConnector } = await import("../resend.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({ id: "email_123abc" }),
    );

    const c = getResendConnector();
    const result = await c.sendEmail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Hello",
      html: "<p>Hi</p>",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.init?.method).toBe("POST");

    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.from).toBe("sender@example.com");
    expect(body.to).toBe("recipient@example.com");
    expect(body.subject).toBe("Hello");
    expect(body.html).toBe("<p>Hi</p>");

    expect(result.id).toBe("email_123abc");
  });

  it("includes reply_to when replyTo is provided", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const { getResendConnector } = await import("../resend.js");
    const { calls } = installFetchMock(() => jsonResponse({ id: "email_xyz" }));

    const c = getResendConnector();
    await c.sendEmail({
      from: "a@example.com",
      to: "b@example.com",
      subject: "Test",
      text: "Hello",
      replyTo: "replies@example.com",
    });

    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.reply_to).toBe("replies@example.com");
    expect(body.text).toBe("Hello");
  });

  it("throws when from is missing", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const { getResendConnector } = await import("../resend.js");
    installFetchMock(() => jsonResponse({ id: "x" }));
    const c = getResendConnector();
    await expect(
      c.sendEmail({ from: "", to: "b@example.com", subject: "S", html: "h" }),
    ).rejects.toThrow(/from/);
  });

  it("throws when neither html nor text provided", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const { getResendConnector } = await import("../resend.js");
    installFetchMock(() => jsonResponse({ id: "x" }));
    const c = getResendConnector();
    await expect(
      c.sendEmail({ from: "a@example.com", to: "b@example.com", subject: "S" }),
    ).rejects.toThrow(/html.*text|text.*html/i);
  });
});

// ── getEmail ───────────────────────────────────────────────────────────────

describe("getEmail", () => {
  it("GETs /emails/{id}", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const { getResendConnector } = await import("../resend.js");

    const emailObj = {
      object: "email",
      id: "email_abc",
      from: "a@example.com",
      to: "b@example.com",
      subject: "Hello",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const { calls } = installFetchMock(() => jsonResponse(emailObj));

    const c = getResendConnector();
    const result = await c.getEmail("email_abc");

    expect(calls[0]!.url).toBe("https://api.resend.com/emails/email_abc");
    expect(calls[0]!.init?.method).toBeUndefined(); // GET (default)
    expect(result.id).toBe("email_abc");
    expect(result.subject).toBe("Hello");
  });
});

// ── listEmails ────────────────────────────────────────────────────────────

describe("listEmails", () => {
  it("GETs /emails without query string by default", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const { getResendConnector } = await import("../resend.js");
    const { calls } = installFetchMock(() =>
      jsonResponse({ object: "list", data: [] }),
    );
    const c = getResendConnector();
    await c.listEmails();
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
  });

  it("appends limit and page as query params", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const { getResendConnector } = await import("../resend.js");
    const { calls } = installFetchMock(() =>
      jsonResponse({ object: "list", data: [] }),
    );
    const c = getResendConnector();
    await c.listEmails({ limit: 10, page: 2 });
    expect(calls[0]!.url).toContain("limit=10");
    expect(calls[0]!.url).toContain("page=2");
  });
});

// ── Connect handler ────────────────────────────────────────────────────────

describe("handleResendConnect", () => {
  it("rejects invalid JSON", async () => {
    const { handleResendConnect } = await import("../resend.js");
    const r = await handleResendConnect("not json");
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid JSON/);
  });

  it("requires apiKey field", async () => {
    const { handleResendConnect } = await import("../resend.js");
    const r = await handleResendConnect(JSON.stringify({}));
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/apiKey is required/);
  });

  it("verifies key via /api-keys and stores tokens", async () => {
    const { handleResendConnect, loadTokens } = await import("../resend.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({ data: [{ id: "key_1", name: "My Key" }] }),
    );

    const r = await handleResendConnect(
      JSON.stringify({ apiKey: "re_test_abc" }),
    );

    expect(r.status).toBe(200);
    expect(calls[0]!.url).toBe("https://api.resend.com/api-keys");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_abc");

    const body = JSON.parse(r.body) as {
      ok: boolean;
      name?: string;
      connectedAt?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("My Key");

    const stored = loadTokens();
    expect(stored?.apiKey).toBe("re_test_abc");
    expect(stored?.name).toBe("My Key");
  });

  it("returns 401 when Resend rejects the key, without persisting", async () => {
    const { handleResendConnect, loadTokens } = await import("../resend.js");
    installFetchMock(() => new Response("nope", { status: 401 }));
    const r = await handleResendConnect(
      JSON.stringify({ apiKey: "re_bad_key" }),
    );
    expect(r.status).toBe(401);
    expect(loadTokens()).toBeNull();
  });
});

// ── Disconnect ─────────────────────────────────────────────────────────────

describe("handleResendDisconnect", () => {
  it("clears stored tokens", async () => {
    const { handleResendDisconnect, saveTokens, loadTokens } = await import(
      "../resend.js"
    );
    saveTokens({
      apiKey: "re_test_key",
      connected_at: new Date().toISOString(),
    });
    expect(loadTokens()).not.toBeNull();
    const r = handleResendDisconnect();
    expect(r.status).toBe(200);
    expect(loadTokens()).toBeNull();
  });
});

// ── getStatus ──────────────────────────────────────────────────────────────

describe("getStatus", () => {
  it("returns disconnected when no tokens", async () => {
    const { getResendConnector } = await import("../resend.js");
    const s = getResendConnector().getStatus();
    expect(s.status).toBe("disconnected");
  });

  it("returns connected when tokens present", async () => {
    const { getResendConnector, saveTokens } = await import("../resend.js");
    saveTokens({
      apiKey: "re_test_key",
      name: "Production Key",
      connected_at: new Date().toISOString(),
    });
    const s = getResendConnector().getStatus();
    expect(s.status).toBe("connected");
    expect(s.workspace).toContain("Production Key");
  });
});

// ── RESEND_API_KEY env override ────────────────────────────────────────────

describe("RESEND_API_KEY env override", () => {
  it("loadTokens returns env-based tokens when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY = "re_env_key";
    const { loadTokens } = await import("../resend.js");
    const tokens = loadTokens();
    expect(tokens?.apiKey).toBe("re_env_key");
  });
});

// ── verifyResendWebhook ────────────────────────────────────────────────────

describe("verifyResendWebhook", () => {
  function makeSignature(
    secret: Buffer,
    id: string,
    ts: string,
    body: string,
  ): string {
    const payload = `${id}.${ts}.${body}`;
    return createHmac("sha256", secret).update(payload).digest("base64");
  }

  it("returns true for a valid signature", async () => {
    const { verifyResendWebhook } = await import("../resend.js");
    const rawSecret = Buffer.from("super-secret-bytes");
    const b64Secret = rawSecret.toString("base64");
    const webhookSecret = `whsec_${b64Secret}`;

    const id = "msg_01234";
    const ts = "1717000000";
    const body = JSON.stringify({ type: "email.sent" });

    const sig = makeSignature(rawSecret, id, ts, body);
    const svixSignature = `v1,${sig}`;

    expect(
      verifyResendWebhook(body, id, ts, svixSignature, webhookSecret),
    ).toBe(true);
  });

  it("returns false for a tampered body", async () => {
    const { verifyResendWebhook } = await import("../resend.js");
    const rawSecret = Buffer.from("super-secret-bytes");
    const b64Secret = rawSecret.toString("base64");
    const webhookSecret = `whsec_${b64Secret}`;

    const id = "msg_01234";
    const ts = "1717000000";
    const body = JSON.stringify({ type: "email.sent" });

    const sig = makeSignature(rawSecret, id, ts, body);
    const svixSignature = `v1,${sig}`;

    const tamperedBody = JSON.stringify({ type: "email.bounced" });
    expect(
      verifyResendWebhook(tamperedBody, id, ts, svixSignature, webhookSecret),
    ).toBe(false);
  });

  it("returns false for a wrong secret", async () => {
    const { verifyResendWebhook } = await import("../resend.js");
    const rawSecret = Buffer.from("super-secret-bytes");
    const b64Secret = rawSecret.toString("base64");
    const webhookSecret = `whsec_${b64Secret}`;

    const wrongSecret = `whsec_${Buffer.from("wrong-secret").toString("base64")}`;
    const id = "msg_01234";
    const ts = "1717000000";
    const body = JSON.stringify({ type: "email.sent" });

    const sig = makeSignature(rawSecret, id, ts, body);
    const svixSignature = `v1,${sig}`;

    expect(verifyResendWebhook(body, id, ts, svixSignature, wrongSecret)).toBe(
      false,
    );

    // Also returns false with wrong secret used for signing
    expect(
      verifyResendWebhook(body, id, ts, svixSignature, webhookSecret),
    ).toBe(true); // sanity check
    expect(verifyResendWebhook(body, id, ts, svixSignature, wrongSecret)).toBe(
      false,
    );
  });

  it("returns false for an empty/invalid signature header", async () => {
    const { verifyResendWebhook } = await import("../resend.js");
    const webhookSecret = `whsec_${Buffer.from("secret").toString("base64")}`;
    expect(
      verifyResendWebhook(
        "body",
        "id",
        "ts",
        "invalid_no_comma",
        webhookSecret,
      ),
    ).toBe(false);
  });

  it("accepts multiple space-separated signatures and matches any valid one", async () => {
    const { verifyResendWebhook } = await import("../resend.js");
    const rawSecret = Buffer.from("real-secret");
    const webhookSecret = `whsec_${rawSecret.toString("base64")}`;

    const id = "msg_001";
    const ts = "1717001000";
    const body = "{}";

    const validSig = makeSignature(rawSecret, id, ts, body);
    const fakeSig = "YWJj"; // garbage base64

    // Both an invalid sig and the valid sig present — should still return true
    const svixSignature = `v1,${fakeSig} v1,${validSig}`;
    expect(
      verifyResendWebhook(body, id, ts, svixSignature, webhookSecret),
    ).toBe(true);
  });
});
