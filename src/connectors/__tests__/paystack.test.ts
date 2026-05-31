import crypto from "node:crypto";
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

const tmpDir = join(os.tmpdir(), `patchwork-paystack-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  delete process.env.PAYSTACK_SECRET_KEY;
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.PAYSTACK_SECRET_KEY;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── normalizeError ─────────────────────────────────────────────────────────

describe("normalizeError", () => {
  it("maps HTTP status codes from Response", async () => {
    const { PaystackConnector } = await import("../paystack.js");
    const c = new PaystackConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(401)).code).toBe("auth_expired");
    expect(c.normalizeError(make(403)).code).toBe("permission_denied");
    expect(c.normalizeError(make(404)).code).toBe("not_found");
    expect(c.normalizeError(make(429)).code).toBe("rate_limited");
    expect(c.normalizeError(make(500)).code).toBe("provider_error");
  });

  it("marks 429 + 5xx retryable; 4xx non-retryable", async () => {
    const { PaystackConnector } = await import("../paystack.js");
    const c = new PaystackConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(429)).retryable).toBe(true);
    expect(c.normalizeError(make(503)).retryable).toBe(true);
    expect(c.normalizeError(make(401)).retryable).toBe(false);
    expect(c.normalizeError(make(403)).retryable).toBe(false);
    expect(c.normalizeError(make(404)).retryable).toBe(false);
  });

  it("detects ENOTFOUND/ECONNREFUSED as network_error", async () => {
    const { PaystackConnector } = await import("../paystack.js");
    const c = new PaystackConnector();
    expect(c.normalizeError(new Error("getaddrinfo ENOTFOUND x")).code).toBe(
      "network_error",
    );
    expect(c.normalizeError(new Error("ECONNREFUSED")).code).toBe(
      "network_error",
    );
  });

  it("defaults to provider_error", async () => {
    const { PaystackConnector } = await import("../paystack.js");
    const c = new PaystackConnector();
    expect(c.normalizeError(new Error("boom")).code).toBe("provider_error");
    expect(c.normalizeError("plain string").code).toBe("provider_error");
  });
});

// ── verifyTransaction ──────────────────────────────────────────────────────

describe("verifyTransaction", () => {
  it("fetches from correct URL and returns transaction data", async () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_test_abc";
    const { getPaystackConnector } = await import("../paystack.js");

    const mockTxn = {
      id: 12345,
      domain: "test",
      status: "success",
      reference: "REF001",
      amount: 5000,
      currency: "NGN",
      paid_at: "2026-01-01T00:00:00.000Z",
      customer: { email: "user@example.com" },
      authorization: {
        authorization_code: "AUTH_abc",
        card_type: "visa",
        bank: "Test Bank",
        last4: "1234",
        exp_month: "12",
        exp_year: "2028",
      },
    };

    const { calls } = installFetchMock(() =>
      jsonResponse({ status: true, data: mockTxn }),
    );

    const c = getPaystackConnector();
    const txn = await c.verifyTransaction("REF001");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.paystack.co/transaction/verify/REF001",
    );
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test_abc");
    expect(txn.reference).toBe("REF001");
    expect(txn.status).toBe("success");
    expect(txn.amount).toBe(5000);
    expect(txn.customer.email).toBe("user@example.com");
  });

  it("URL-encodes the reference parameter", async () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_test_abc";
    const { getPaystackConnector } = await import("../paystack.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({
        status: true,
        data: {
          id: 1,
          domain: "test",
          status: "success",
          reference: "REF/2026",
          amount: 100,
          currency: "NGN",
          paid_at: null,
          customer: { email: "x@x.com" },
          authorization: {
            authorization_code: "auth",
            card_type: "visa",
            bank: "Bank",
            last4: "4321",
            exp_month: "01",
            exp_year: "2029",
          },
        },
      }),
    );

    const c = getPaystackConnector();
    await c.verifyTransaction("REF/2026");

    expect(calls[0]!.url).toContain("REF%2F2026");
  });

  it("throws when Paystack returns status: false", async () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_test_abc";
    const { getPaystackConnector } = await import("../paystack.js");

    installFetchMock(() =>
      jsonResponse({ status: false, message: "Transaction not found" }),
    );

    const c = getPaystackConnector();
    await expect(c.verifyTransaction("BOGUS")).rejects.toThrow(
      /Transaction not found/,
    );
  });

  it("throws on HTTP 404", async () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_test_abc";
    const { getPaystackConnector } = await import("../paystack.js");

    installFetchMock(() =>
      jsonResponse({ message: "Transaction not found" }, 404),
    );

    const c = getPaystackConnector();
    await expect(c.verifyTransaction("MISSING")).rejects.toThrow();
  });
});

// ── listTransactions ───────────────────────────────────────────────────────

describe("listTransactions", () => {
  it("returns array of transactions with no filters", async () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_test_abc";
    const { getPaystackConnector } = await import("../paystack.js");

    const mockTxns = [
      {
        id: 1,
        domain: "live",
        status: "success",
        reference: "A",
        amount: 1000,
        currency: "NGN",
        paid_at: "2026-01-01T00:00:00.000Z",
        customer: { email: "a@a.com" },
        authorization: {
          authorization_code: "auth1",
          card_type: "visa",
          bank: "GTB",
          last4: "0001",
          exp_month: "01",
          exp_year: "2030",
        },
      },
      {
        id: 2,
        domain: "live",
        status: "failed",
        reference: "B",
        amount: 2000,
        currency: "NGN",
        paid_at: null,
        customer: { email: "b@b.com" },
        authorization: {
          authorization_code: "auth2",
          card_type: "mastercard",
          bank: "Zenith",
          last4: "0002",
          exp_month: "06",
          exp_year: "2027",
        },
      },
    ];

    const { calls } = installFetchMock(() =>
      jsonResponse({ status: true, data: mockTxns }),
    );

    const c = getPaystackConnector();
    const result = await c.listTransactions();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/transaction");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test_abc");
    expect(result.data).toHaveLength(2);
    expect(result.data[0]!.reference).toBe("A");
    expect(result.data[1]!.reference).toBe("B");
  });

  it("passes query params when filters supplied", async () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_test_abc";
    const { getPaystackConnector } = await import("../paystack.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({ status: true, data: [] }),
    );

    const c = getPaystackConnector();
    await c.listTransactions({
      perPage: 10,
      page: 2,
      status: "success",
      from: "2026-01-01",
      to: "2026-01-31",
    });

    const url = calls[0]!.url;
    expect(url).toContain("perPage=10");
    expect(url).toContain("page=2");
    expect(url).toContain("status=success");
    expect(url).toContain("from=2026-01-01");
    expect(url).toContain("to=2026-01-31");
  });
});

// ── verifyPaystackWebhook ──────────────────────────────────────────────────

describe("verifyPaystackWebhook", () => {
  it("accepts a valid HMAC-SHA512 signature", async () => {
    const { verifyPaystackWebhook } = await import("../paystack.js");
    const secretKey = "whsec_test_secret";
    const rawBody = JSON.stringify({
      event: "charge.success",
      data: { id: 1 },
    });
    const expectedSig = crypto
      .createHmac("sha512", secretKey)
      .update(rawBody)
      .digest("hex");

    expect(verifyPaystackWebhook(rawBody, expectedSig, secretKey)).toBe(true);
  });

  it("accepts Buffer rawBody", async () => {
    const { verifyPaystackWebhook } = await import("../paystack.js");
    const secretKey = "whsec_buf_secret";
    const rawBody = Buffer.from(JSON.stringify({ event: "transfer.success" }));
    const expectedSig = crypto
      .createHmac("sha512", secretKey)
      .update(rawBody)
      .digest("hex");

    expect(verifyPaystackWebhook(rawBody, expectedSig, secretKey)).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const { verifyPaystackWebhook } = await import("../paystack.js");
    const secretKey = "whsec_test_secret";
    const rawBody = JSON.stringify({
      event: "charge.success",
      data: { id: 1 },
    });
    const expectedSig = crypto
      .createHmac("sha512", secretKey)
      .update(rawBody)
      .digest("hex");

    // Tamper with the body
    const tamperedBody = JSON.stringify({
      event: "charge.success",
      data: { id: 2 },
    });
    expect(verifyPaystackWebhook(tamperedBody, expectedSig, secretKey)).toBe(
      false,
    );
  });

  it("rejects a wrong secret key", async () => {
    const { verifyPaystackWebhook } = await import("../paystack.js");
    const rawBody = JSON.stringify({ event: "charge.success" });
    const sigFromCorrectKey = crypto
      .createHmac("sha512", "correct_secret")
      .update(rawBody)
      .digest("hex");

    expect(
      verifyPaystackWebhook(rawBody, sigFromCorrectKey, "wrong_secret"),
    ).toBe(false);
  });

  it("returns false for empty signature", async () => {
    const { verifyPaystackWebhook } = await import("../paystack.js");
    expect(verifyPaystackWebhook("body", "", "secret")).toBe(false);
  });

  it("returns false for empty secret key", async () => {
    const { verifyPaystackWebhook } = await import("../paystack.js");
    expect(verifyPaystackWebhook("body", "somesig", "")).toBe(false);
  });
});

// ── handlePaystackConnect ──────────────────────────────────────────────────

describe("handlePaystackConnect", () => {
  it("rejects invalid JSON", async () => {
    const { handlePaystackConnect } = await import("../paystack.js");
    const r = await handlePaystackConnect("not json");
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid JSON/);
  });

  it("requires secretKey field", async () => {
    const { handlePaystackConnect } = await import("../paystack.js");
    const r = await handlePaystackConnect(JSON.stringify({}));
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/secretKey is required/);
  });

  it("connects and stores tokens, fetching business name", async () => {
    const { handlePaystackConnect, loadTokens } = await import(
      "../paystack.js"
    );

    let callCount = 0;
    installFetchMock(() => {
      callCount++;
      if (callCount === 1) {
        // probe: /bank
        return jsonResponse({ status: true, data: [] });
      }
      // integration info
      return jsonResponse({
        status: true,
        data: { business_name: "Acme Payments Ltd" },
      });
    });

    const r = await handlePaystackConnect(
      JSON.stringify({ secretKey: "sk_test_valid" }),
    );

    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      ok: boolean;
      businessName?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.businessName).toBe("Acme Payments Ltd");

    const stored = loadTokens();
    expect(stored?.secretKey).toBe("sk_test_valid");
    expect(stored?.businessName).toBe("Acme Payments Ltd");
  });

  it("returns 401 when Paystack rejects the key, without persisting", async () => {
    const { handlePaystackConnect, loadTokens } = await import(
      "../paystack.js"
    );
    installFetchMock(() => new Response("nope", { status: 401 }));
    const r = await handlePaystackConnect(
      JSON.stringify({ secretKey: "sk_bad_key" }),
    );
    expect(r.status).toBe(401);
    expect(loadTokens()).toBeNull();
  });

  it("connects without business name when integration endpoint fails", async () => {
    const { handlePaystackConnect, loadTokens } = await import(
      "../paystack.js"
    );

    let callCount = 0;
    installFetchMock(() => {
      callCount++;
      if (callCount === 1) {
        return jsonResponse({ status: true, data: [] });
      }
      return new Response("not found", { status: 404 });
    });

    const r = await handlePaystackConnect(
      JSON.stringify({ secretKey: "sk_test_nobiz" }),
    );

    expect(r.status).toBe(200);
    const stored = loadTokens();
    expect(stored?.businessName).toBeUndefined();
  });
});

// ── handlePaystackDisconnect ───────────────────────────────────────────────

describe("handlePaystackDisconnect", () => {
  it("clears stored tokens", async () => {
    const { handlePaystackDisconnect, saveTokens, loadTokens } = await import(
      "../paystack.js"
    );
    saveTokens({
      secretKey: "sk_test_abc",
      connected_at: new Date().toISOString(),
    });
    expect(loadTokens()).not.toBeNull();
    const r = handlePaystackDisconnect();
    expect(r.status).toBe(200);
    expect(loadTokens()).toBeNull();
  });
});

// ── getStatus ──────────────────────────────────────────────────────────────

describe("getStatus", () => {
  it("returns disconnected when no tokens", async () => {
    const { getPaystackConnector } = await import("../paystack.js");
    const s = getPaystackConnector().getStatus();
    expect(s.status).toBe("disconnected");
  });

  it("returns connected with workspace label from businessName", async () => {
    const { getPaystackConnector, saveTokens } = await import("../paystack.js");
    saveTokens({
      secretKey: "sk_test_abc",
      businessName: "My Shop",
      connected_at: new Date().toISOString(),
    });
    const s = getPaystackConnector().getStatus();
    expect(s.status).toBe("connected");
    expect(s.workspace).toContain("My Shop");
  });

  it("returns connected with no workspace label when businessName absent", async () => {
    const { getPaystackConnector, saveTokens } = await import("../paystack.js");
    saveTokens({
      secretKey: "sk_test_abc",
      connected_at: new Date().toISOString(),
    });
    const s = getPaystackConnector().getStatus();
    expect(s.status).toBe("connected");
    expect(s.workspace).toBeUndefined();
  });

  it("uses env var when set", async () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_env_key";
    const { getPaystackConnector } = await import("../paystack.js");
    const s = getPaystackConnector().getStatus();
    expect(s.status).toBe("connected");
  });
});
