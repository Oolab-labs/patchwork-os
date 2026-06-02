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

const tmpDir = join(os.tmpdir(), `patchwork-pipedrive-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  delete process.env.PIPEDRIVE_API_TOKEN;
  delete process.env.PIPEDRIVE_COMPANY_DOMAIN;
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.PIPEDRIVE_API_TOKEN;
  delete process.env.PIPEDRIVE_COMPANY_DOMAIN;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── normalizeError ─────────────────────────────────────────────────────────

describe("normalizeError", () => {
  it("maps HTTP status codes from Response", async () => {
    const { PipedriveConnector } = await import("../pipedrive.js");
    const c = new PipedriveConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(401)).code).toBe("auth_expired");
    expect(c.normalizeError(make(403)).code).toBe("permission_denied");
    expect(c.normalizeError(make(404)).code).toBe("not_found");
    expect(c.normalizeError(make(429)).code).toBe("rate_limited");
    expect(c.normalizeError(make(400)).code).toBe("validation_error");
    expect(c.normalizeError(make(500)).code).toBe("provider_error");
  });

  it("marks 429 + 5xx retryable; 4xx non-retryable", async () => {
    const { PipedriveConnector } = await import("../pipedrive.js");
    const c = new PipedriveConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(429)).retryable).toBe(true);
    expect(c.normalizeError(make(503)).retryable).toBe(true);
    expect(c.normalizeError(make(401)).retryable).toBe(false);
    expect(c.normalizeError(make(403)).retryable).toBe(false);
    expect(c.normalizeError(make(404)).retryable).toBe(false);
    expect(c.normalizeError(make(400)).retryable).toBe(false);
  });

  it("maps network errors", async () => {
    const { PipedriveConnector } = await import("../pipedrive.js");
    const c = new PipedriveConnector();
    const err = new Error("ENOTFOUND api.pipedrive.com");
    expect(c.normalizeError(err).code).toBe("network_error");
    expect(c.normalizeError(err).retryable).toBe(true);
  });
});

// ── getDeals ────────────────────────────────────────────────────────────────

describe("getDeals", () => {
  it("returns unwrapped deal array", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "test-token";
    process.env.PIPEDRIVE_COMPANY_DOMAIN = "mycompany";

    const deal = {
      id: 1,
      title: "Big Deal",
      value: 5000,
      currency: "USD",
      status: "open",
      stage_id: 2,
      person_id: null,
      org_id: null,
      expected_close_date: null,
      add_time: "2024-01-01T00:00:00Z",
      update_time: "2024-01-01T00:00:00Z",
    };

    const { calls } = installFetchMock(() =>
      jsonResponse({ success: true, data: [deal] }),
    );

    const { PipedriveConnector } = await import("../pipedrive.js");
    const c = new PipedriveConnector();
    const result = await c.getDeals();

    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Big Deal");
    expect(result[0]?.value).toBe(5000);

    // Verify api_token is in query string
    expect(calls[0]?.url).toContain("api_token=test-token");
    expect(calls[0]?.url).toContain("mycompany.pipedrive.com");
    expect(calls[0]?.url).toContain("/deals");
  });

  it("passes status filter in query string", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "test-token";
    process.env.PIPEDRIVE_COMPANY_DOMAIN = "mycompany";

    const { calls } = installFetchMock(() =>
      jsonResponse({ success: true, data: [] }),
    );

    const { PipedriveConnector } = await import("../pipedrive.js");
    const c = new PipedriveConnector();
    await c.getDeals({ status: "won", limit: 10 });

    expect(calls[0]?.url).toContain("status=won");
    expect(calls[0]?.url).toContain("limit=10");
  });

  it("throws on non-ok response", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "test-token";
    process.env.PIPEDRIVE_COMPANY_DOMAIN = "mycompany";

    installFetchMock(() => jsonResponse({ error: "Unauthorized" }, 401));

    const { PipedriveConnector } = await import("../pipedrive.js");
    const c = new PipedriveConnector();
    await expect(c.getDeals()).rejects.toThrow();
  });
});

// ── getDeal ────────────────────────────────────────────────────────────────

describe("getDeal", () => {
  it("returns single deal", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "tok";
    process.env.PIPEDRIVE_COMPANY_DOMAIN = "acme";

    const deal = {
      id: 42,
      title: "Enterprise Deal",
      value: 99000,
      currency: "EUR",
      status: "open",
      stage_id: 5,
      person_id: { value: 7, name: "Alice" },
      org_id: null,
      expected_close_date: "2024-12-31",
      add_time: "2024-01-01T00:00:00Z",
      update_time: "2024-06-01T00:00:00Z",
    };

    const { calls } = installFetchMock(() =>
      jsonResponse({ success: true, data: deal }),
    );

    const { PipedriveConnector } = await import("../pipedrive.js");
    const c = new PipedriveConnector();
    const result = await c.getDeal(42);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(42);
    expect(result?.title).toBe("Enterprise Deal");
    expect(calls[0]?.url).toContain("/deals/42");
  });

  it("returns null on 404", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "tok";
    process.env.PIPEDRIVE_COMPANY_DOMAIN = "acme";

    installFetchMock(() => new Response(null, { status: 404 }));

    const { PipedriveConnector } = await import("../pipedrive.js");
    const c = new PipedriveConnector();
    const result = await c.getDeal(999);
    expect(result).toBeNull();
  });
});

// ── createDeal ─────────────────────────────────────────────────────────────

describe("createDeal", () => {
  it("POSTs with correct body and returns created deal", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "tok";
    process.env.PIPEDRIVE_COMPANY_DOMAIN = "acme";

    const created = {
      id: 100,
      title: "New Deal",
      value: 1000,
      currency: "USD",
      status: "open",
      stage_id: 1,
      person_id: null,
      org_id: null,
      expected_close_date: null,
      add_time: "2024-01-01T00:00:00Z",
      update_time: "2024-01-01T00:00:00Z",
    };

    const { calls } = installFetchMock(() =>
      jsonResponse({ success: true, data: created }),
    );

    const { PipedriveConnector } = await import("../pipedrive.js");
    const c = new PipedriveConnector();
    const result = await c.createDeal({
      title: "New Deal",
      value: 1000,
      currency: "USD",
      stageId: 1,
    });

    expect(result.id).toBe(100);
    expect(result.title).toBe("New Deal");

    // Verify POST method and body
    const call = calls[0]!;
    expect(call.init?.method).toBe("POST");
    const body = JSON.parse(call.init?.body as string) as Record<
      string,
      unknown
    >;
    expect(body.title).toBe("New Deal");
    expect(body.value).toBe(1000);
    expect(body.currency).toBe("USD");
    expect(body.stage_id).toBe(1);
    expect(call.url).toContain("/deals");
  });
});

// ── getPerson ──────────────────────────────────────────────────────────────

describe("getPerson", () => {
  it("returns person with email/phone arrays", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "tok";
    process.env.PIPEDRIVE_COMPANY_DOMAIN = "acme";

    const person = {
      id: 7,
      name: "Alice Smith",
      email: [{ value: "alice@example.com", primary: true }],
      phone: [{ value: "+1-555-0100", primary: true }],
      org_id: { value: 3, name: "Acme Corp" },
      add_time: "2024-01-01T00:00:00Z",
    };

    const { calls } = installFetchMock(() =>
      jsonResponse({ success: true, data: person }),
    );

    const { PipedriveConnector } = await import("../pipedrive.js");
    const c = new PipedriveConnector();
    const result = await c.getPerson(7);

    expect(result?.name).toBe("Alice Smith");
    expect(result?.email[0]?.value).toBe("alice@example.com");
    expect(result?.phone[0]?.primary).toBe(true);
    expect(calls[0]?.url).toContain("/persons/7");
  });

  it("returns null on 404", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "tok";
    process.env.PIPEDRIVE_COMPANY_DOMAIN = "acme";

    installFetchMock(() => new Response(null, { status: 404 }));

    const { PipedriveConnector } = await import("../pipedrive.js");
    const c = new PipedriveConnector();
    expect(await c.getPerson(9999)).toBeNull();
  });
});

// ── createPerson ───────────────────────────────────────────────────────────

describe("createPerson", () => {
  it("wraps email/phone in array format", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "tok";
    process.env.PIPEDRIVE_COMPANY_DOMAIN = "acme";

    const created = {
      id: 50,
      name: "Bob Jones",
      email: [{ value: "bob@example.com", primary: true }],
      phone: [],
      org_id: null,
      add_time: "2024-01-01T00:00:00Z",
    };

    const { calls } = installFetchMock(() =>
      jsonResponse({ success: true, data: created }),
    );

    const { PipedriveConnector } = await import("../pipedrive.js");
    const c = new PipedriveConnector();
    await c.createPerson({ name: "Bob Jones", email: "bob@example.com" });

    const body = JSON.parse(calls[0]!.init?.body as string) as Record<
      string,
      unknown
    >;
    expect(body.name).toBe("Bob Jones");
    expect(Array.isArray(body.email)).toBe(true);
    const emailArr = body.email as { value: string; primary: boolean }[];
    expect(emailArr[0]?.value).toBe("bob@example.com");
    expect(emailArr[0]?.primary).toBe(true);
  });
});

// ── verifyPipedriveWebhook ─────────────────────────────────────────────────

describe("verifyPipedriveWebhook", () => {
  it("returns true for a valid HMAC-SHA256 signature", async () => {
    const { verifyPipedriveWebhook } = await import("../pipedrive.js");
    const secret = "my-webhook-secret";
    const body = JSON.stringify({ event: "deal.added", data: { id: 1 } });
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyPipedriveWebhook(body, sig, secret)).toBe(true);
  });

  it("returns false for a tampered body", async () => {
    const { verifyPipedriveWebhook } = await import("../pipedrive.js");
    const secret = "my-webhook-secret";
    const original = '{"event":"deal.added"}';
    const tampered = '{"event":"deal.deleted"}';
    const sig = createHmac("sha256", secret).update(original).digest("hex");
    expect(verifyPipedriveWebhook(tampered, sig, secret)).toBe(false);
  });

  it("returns false for a wrong secret", async () => {
    const { verifyPipedriveWebhook } = await import("../pipedrive.js");
    const body = '{"event":"deal.added"}';
    const sig = createHmac("sha256", "correct-secret")
      .update(body)
      .digest("hex");
    expect(verifyPipedriveWebhook(body, sig, "wrong-secret")).toBe(false);
  });

  it("returns false for empty signature", async () => {
    const { verifyPipedriveWebhook } = await import("../pipedrive.js");
    expect(verifyPipedriveWebhook("body", "", "secret")).toBe(false);
  });

  it("returns false for empty secret", async () => {
    const { verifyPipedriveWebhook } = await import("../pipedrive.js");
    expect(verifyPipedriveWebhook("body", "sig", "")).toBe(false);
  });

  it("works with Buffer input", async () => {
    const { verifyPipedriveWebhook } = await import("../pipedrive.js");
    const secret = "buf-secret";
    const body = Buffer.from('{"event":"test"}', "utf8");
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyPipedriveWebhook(body, sig, secret)).toBe(true);
  });
});

// ── loadTokens / env override ──────────────────────────────────────────────

describe("loadTokens", () => {
  it("returns null when no token stored or in env", async () => {
    const { loadTokens } = await import("../pipedrive.js");
    expect(loadTokens()).toBeNull();
  });

  it("uses PIPEDRIVE_API_TOKEN env var", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "env-token";
    process.env.PIPEDRIVE_COMPANY_DOMAIN = "envdomain";
    const { loadTokens } = await import("../pipedrive.js");
    const t = loadTokens();
    expect(t?.apiToken).toBe("env-token");
    expect(t?.companyDomain).toBe("envdomain");
  });

  it("falls back to api domain when PIPEDRIVE_COMPANY_DOMAIN not set", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "env-token";
    const { loadTokens } = await import("../pipedrive.js");
    const t = loadTokens();
    expect(t?.companyDomain).toBe("api");
  });
});

// ── HTTP handlers ──────────────────────────────────────────────────────────

describe("handlePipedriveConnect", () => {
  it("returns 400 when apiToken missing", async () => {
    const { handlePipedriveConnect } = await import("../pipedrive.js");
    const r = await handlePipedriveConnect(
      JSON.stringify({ companyDomain: "acme" }),
    );
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toMatchObject({ ok: false });
  });

  it("returns 400 when companyDomain missing", async () => {
    const { handlePipedriveConnect } = await import("../pipedrive.js");
    const r = await handlePipedriveConnect(JSON.stringify({ apiToken: "tok" }));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toMatchObject({ ok: false });
  });

  it("returns 400 on invalid JSON", async () => {
    const { handlePipedriveConnect } = await import("../pipedrive.js");
    const r = await handlePipedriveConnect("not-json");
    expect(r.status).toBe(400);
  });

  it("returns 401 when Pipedrive rejects credentials", async () => {
    installFetchMock(() => jsonResponse({ error: "Unauthorized" }, 401));
    const { handlePipedriveConnect } = await import("../pipedrive.js");
    const r = await handlePipedriveConnect(
      JSON.stringify({ apiToken: "bad", companyDomain: "acme" }),
    );
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toMatchObject({ ok: false });
  });

  it("saves tokens and returns 200 on success", async () => {
    installFetchMock(() =>
      jsonResponse({
        success: true,
        data: { id: 1, name: "Admin User", email: "admin@acme.com" },
      }),
    );

    const { handlePipedriveConnect, loadTokens } = await import(
      "../pipedrive.js"
    );
    const r = await handlePipedriveConnect(
      JSON.stringify({ apiToken: "good-tok", companyDomain: "acme" }),
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.companyDomain).toBe("acme");
    expect(body.userId).toBe(1);

    // Tokens should be persisted
    const stored = loadTokens();
    expect(stored?.apiToken).toBe("good-tok");
    expect(stored?.companyDomain).toBe("acme");
  });
});

describe("handlePipedriveDisconnect", () => {
  it("returns 200 and clears tokens", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "tok";
    process.env.PIPEDRIVE_COMPANY_DOMAIN = "acme";
    const { handlePipedriveDisconnect } = await import("../pipedrive.js");
    const r = handlePipedriveDisconnect();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true });
  });
});

// ── connectorRegistry ─────────────────────────────────────────────────────

describe("connectorRegistry", () => {
  it("includes pipedrive entry", async () => {
    const { CONNECTORS } = await import("../connectorRegistry.js");
    const entry = CONNECTORS.find((c) => c.id === "pipedrive");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Pipedrive");
    expect(entry?.authKind).toBe("pat");
    expect(entry?.supports.connect).toBe(true);
    expect(entry?.supports.test).toBe(true);
    expect(entry?.supports.delete).toBe(true);
  });
});
