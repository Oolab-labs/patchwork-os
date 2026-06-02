import crypto from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmpDir = join(os.tmpdir(), `patchwork-supabase-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

const SUPABASE_URL = "https://xyzabc.supabase.co";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-service-role";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-anon";

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_ANON_KEY;
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_ANON_KEY;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function mockFetchOnce(
  response: Partial<Response> & {
    json?: () => unknown;
    arrayBuffer?: () => Promise<ArrayBuffer>;
    headers?: Record<string, string>;
  },
) {
  const fn = vi.fn(async () => {
    const hdrs = new Headers(response.headers ?? {});
    return Object.assign(
      {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: hdrs,
      },
      response,
    );
  });
  // @ts-expect-error — global fetch mock
  global.fetch = fn;
  return fn;
}

async function saveValidTokens() {
  const { saveTokens } = await import("../supabase.js");
  saveTokens({
    url: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    anonKey: ANON_KEY,
    connected_at: new Date().toISOString(),
  });
}

// ── select ───────────────────────────────────────────────────────────────────

describe("select", () => {
  it("builds correct GET URL with select + filter params", async () => {
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => [{ id: 1, name: "Alice" }],
    });
    const { getSupabaseConnector } = await import("../supabase.js");
    const c = getSupabaseConnector();
    await c.select("users", "id,name", "id=eq.1", 10);
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain(`${SUPABASE_URL}/rest/v1/users`);
    expect(url).toContain("select=id%2Cname");
    expect(url).toContain("id=eq.1");
    expect(url).toContain("limit=10");
  });

  it("defaults select to * when columns omitted", async () => {
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => [],
    });
    const { getSupabaseConnector } = await import("../supabase.js");
    const c = getSupabaseConnector();
    await c.select("items");
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("select=*");
  });

  it("sends apikey and Authorization headers", async () => {
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => [],
    });
    const { getSupabaseConnector } = await import("../supabase.js");
    const c = getSupabaseConnector();
    await c.select("users");
    const init = (
      fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(SERVICE_ROLE_KEY);
    expect(headers.Authorization).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
  });

  it("returns data array and count from content-range header", async () => {
    await saveValidTokens();
    const hdrs = new Headers({ "content-range": "0-1/42" });
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: 1 }, { id: 2 }],
      headers: hdrs,
    }));
    // @ts-expect-error — global fetch mock
    global.fetch = fn;
    const { getSupabaseConnector } = await import("../supabase.js");
    const c = getSupabaseConnector();
    const result = await c.select("users");
    expect(result.data).toHaveLength(2);
    expect(result.count).toBe(42);
  });
});

// ── insert ───────────────────────────────────────────────────────────────────

describe("insert", () => {
  it("sends POST with Prefer: return=representation", async () => {
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 201,
      json: async () => [{ id: 99, name: "Bob" }],
    });
    const { getSupabaseConnector } = await import("../supabase.js");
    const c = getSupabaseConnector();
    const result = await c.insert("users", { name: "Bob" });
    const init = (
      fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("POST");
    expect(headers.Prefer).toBe("return=representation");
    expect(result.data[0]).toMatchObject({ id: 99, name: "Bob" });
  });

  it("sends Prefer: return=minimal when returning=false", async () => {
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 201,
      json: async () => [],
    });
    const { getSupabaseConnector } = await import("../supabase.js");
    const c = getSupabaseConnector();
    await c.insert("users", { name: "Carol" }, false);
    const init = (
      fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    const headers = init.headers as Record<string, string>;
    expect(headers.Prefer).toBe("return=minimal");
  });
});

// ── update ───────────────────────────────────────────────────────────────────

describe("update", () => {
  it("sends PATCH to correct URL with filters", async () => {
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => [{ id: 1, name: "Updated" }],
    });
    const { getSupabaseConnector } = await import("../supabase.js");
    const c = getSupabaseConnector();
    await c.update("users", { name: "Updated" }, "id=eq.1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe("PATCH");
    expect(url).toContain("id=eq.1");
    expect(url).toContain("/rest/v1/users");
  });
});

// ── upsert ───────────────────────────────────────────────────────────────────

describe("upsert", () => {
  it("sends POST with merge-duplicates Prefer header", async () => {
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => [{ id: 1 }],
    });
    const { getSupabaseConnector } = await import("../supabase.js");
    const c = getSupabaseConnector();
    await c.upsert("users", { id: 1, name: "Dave" }, "id");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Prefer).toContain("resolution=merge-duplicates");
    expect(url).toContain("on_conflict=id");
  });
});

// ── delete ───────────────────────────────────────────────────────────────────

describe("delete", () => {
  it("sends DELETE with filters and return=representation", async () => {
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => [{ id: 5 }],
    });
    const { getSupabaseConnector } = await import("../supabase.js");
    const c = getSupabaseConnector();
    await c.delete("users", "id=eq.5");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe("DELETE");
    expect(url).toContain("id=eq.5");
    const headers = init.headers as Record<string, string>;
    expect(headers.Prefer).toBe("return=representation");
  });
});

// ── rpc ──────────────────────────────────────────────────────────────────────

describe("rpc", () => {
  it("calls POST /rest/v1/rpc/{functionName} with params body", async () => {
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: 42 }),
    });
    const { getSupabaseConnector } = await import("../supabase.js");
    const c = getSupabaseConnector();
    const result = await c.rpc("add_numbers", { a: 10, b: 32 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${SUPABASE_URL}/rest/v1/rpc/add_numbers`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ a: 10, b: 32 });
    expect(result.data).toMatchObject({ result: 42 });
  });

  it("sends empty object body when params omitted", async () => {
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => null,
    });
    const { getSupabaseConnector } = await import("../supabase.js");
    const c = getSupabaseConnector();
    await c.rpc("my_func");
    const init = (
      fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    expect(JSON.parse(init.body as string)).toEqual({});
  });
});

// ── invokeEdgeFunction ───────────────────────────────────────────────────────

describe("invokeEdgeFunction", () => {
  it("calls POST /functions/v1/{name} with body and auth headers", async () => {
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: "ok" }),
    });
    const { getSupabaseConnector } = await import("../supabase.js");
    const c = getSupabaseConnector();
    const result = await c.invokeEdgeFunction("send-email", { to: "a@b.com" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${SUPABASE_URL}/functions/v1/send-email`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
    expect(headers.apikey).toBe(SERVICE_ROLE_KEY);
    expect(result).toMatchObject({ message: "ok" });
  });

  it("merges custom headers", async () => {
    await saveValidTokens();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    const { getSupabaseConnector } = await import("../supabase.js");
    const c = getSupabaseConnector();
    await c.invokeEdgeFunction("my-fn", {}, { "X-Custom": "value" });
    const init = (
      fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Custom"]).toBe("value");
  });
});

// ── verifySupabaseWebhook ────────────────────────────────────────────────────

describe("verifySupabaseWebhook", () => {
  it("returns true for correct HMAC-SHA256 signature", async () => {
    const { verifySupabaseWebhook } = await import("../supabase.js");
    const secret = "my-webhook-secret";
    const body = '{"type":"INSERT","record":{"id":1}}';
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(verifySupabaseWebhook(body, sig, secret)).toBe(true);
  });

  it("returns false for wrong signature", async () => {
    const { verifySupabaseWebhook } = await import("../supabase.js");
    expect(verifySupabaseWebhook("body content", "wrong-sig", "secret")).toBe(
      false,
    );
  });

  it("returns false for wrong secret", async () => {
    const { verifySupabaseWebhook } = await import("../supabase.js");
    const body = "hello";
    const sig = crypto
      .createHmac("sha256", "correct-secret")
      .update(body)
      .digest("hex");
    expect(verifySupabaseWebhook(body, sig, "wrong-secret")).toBe(false);
  });

  it("accepts Buffer as body", async () => {
    const { verifySupabaseWebhook } = await import("../supabase.js");
    const secret = "s3cr3t";
    const bodyBuf = Buffer.from('{"event":"test"}');
    const sig = crypto
      .createHmac("sha256", secret)
      .update(bodyBuf)
      .digest("hex");
    expect(verifySupabaseWebhook(bodyBuf, sig, secret)).toBe(true);
  });

  it("returns false for different length signature (no timing leak)", async () => {
    const { verifySupabaseWebhook } = await import("../supabase.js");
    expect(verifySupabaseWebhook("body", "short", "secret")).toBe(false);
  });
});

// ── normalizeError ───────────────────────────────────────────────────────────

describe("normalizeError", () => {
  it("maps PGRST301 error object to auth_expired", async () => {
    const { SupabaseConnector } = await import("../supabase.js");
    const c = new SupabaseConnector();
    const e = c.normalizeError({
      code: "PGRST301",
      message: "JWT expired",
      status: 401,
    });
    expect(e.code).toBe("auth_expired");
    expect(e.retryable).toBe(false);
  });

  it("maps HTTP 429 Response to rate_limited retryable", async () => {
    const { SupabaseConnector } = await import("../supabase.js");
    const c = new SupabaseConnector();
    const e = c.normalizeError(new Response(null, { status: 429 }));
    expect(e.code).toBe("rate_limited");
    expect(e.retryable).toBe(true);
  });

  it("maps HTTP 404 Response to not_found", async () => {
    const { SupabaseConnector } = await import("../supabase.js");
    const c = new SupabaseConnector();
    const e = c.normalizeError(new Response(null, { status: 404 }));
    expect(e.code).toBe("not_found");
    expect(e.retryable).toBe(false);
  });

  it("maps HTTP 400 Response to validation_error", async () => {
    const { SupabaseConnector } = await import("../supabase.js");
    const c = new SupabaseConnector();
    const e = c.normalizeError(new Response(null, { status: 400 }));
    expect(e.code).toBe("validation_error");
    expect(e.retryable).toBe(false);
  });

  it("marks 5xx retryable", async () => {
    const { SupabaseConnector } = await import("../supabase.js");
    const c = new SupabaseConnector();
    expect(
      c.normalizeError(new Response(null, { status: 503 })).retryable,
    ).toBe(true);
  });

  it("detects ENOTFOUND as network_error", async () => {
    const { SupabaseConnector } = await import("../supabase.js");
    const c = new SupabaseConnector();
    const e = c.normalizeError(
      new Error("getaddrinfo ENOTFOUND xyzabc.supabase.co"),
    );
    expect(e.code).toBe("network_error");
    expect(e.retryable).toBe(true);
  });
});

// ── handleSupabaseConnect ────────────────────────────────────────────────────

describe("handleSupabaseConnect", () => {
  it("rejects invalid JSON", async () => {
    const { handleSupabaseConnect } = await import("../supabase.js");
    const r = await handleSupabaseConnect("not json");
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid JSON/);
  });

  it("requires url field", async () => {
    const { handleSupabaseConnect } = await import("../supabase.js");
    const r = await handleSupabaseConnect(
      JSON.stringify({ serviceRoleKey: SERVICE_ROLE_KEY }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/url/);
  });

  it("requires serviceRoleKey field", async () => {
    const { handleSupabaseConnect } = await import("../supabase.js");
    const r = await handleSupabaseConnect(
      JSON.stringify({ url: SUPABASE_URL }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/serviceRoleKey/);
  });

  it("returns 401 when Supabase rejects credentials", async () => {
    mockFetchOnce({ ok: false, status: 401, json: async () => ({}) });
    const { handleSupabaseConnect } = await import("../supabase.js");
    const r = await handleSupabaseConnect(
      JSON.stringify({ url: SUPABASE_URL, serviceRoleKey: "bad-key" }),
    );
    expect(r.status).toBe(401);
    expect(r.body).toMatch(/rejected/);
  });

  it("stores tokens and returns 200 on success", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ openapi: "3.0.0" }),
    });
    const { handleSupabaseConnect, loadTokens } = await import(
      "../supabase.js"
    );
    const r = await handleSupabaseConnect(
      JSON.stringify({
        url: SUPABASE_URL,
        serviceRoleKey: SERVICE_ROLE_KEY,
        anonKey: ANON_KEY,
      }),
    );
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body) as { ok: boolean; url: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.url).toBe(SUPABASE_URL);
    const tokens = loadTokens();
    expect(tokens?.serviceRoleKey).toBe(SERVICE_ROLE_KEY);
    expect(tokens?.anonKey).toBe(ANON_KEY);
  });

  it("strips trailing slash from URL", async () => {
    mockFetchOnce({ ok: true, status: 200, json: async () => ({}) });
    const { handleSupabaseConnect, loadTokens } = await import(
      "../supabase.js"
    );
    await handleSupabaseConnect(
      JSON.stringify({
        url: `${SUPABASE_URL}/`,
        serviceRoleKey: SERVICE_ROLE_KEY,
      }),
    );
    const tokens = loadTokens();
    expect(tokens?.url).toBe(SUPABASE_URL);
  });
});

// ── handleSupabaseDisconnect ─────────────────────────────────────────────────

describe("handleSupabaseDisconnect", () => {
  it("clears tokens and returns 200", async () => {
    await saveValidTokens();
    const { handleSupabaseDisconnect, loadTokens } = await import(
      "../supabase.js"
    );
    const r = handleSupabaseDisconnect();
    expect(r.status).toBe(200);
    expect(loadTokens()).toBeNull();
  });
});

// ── env override ─────────────────────────────────────────────────────────────

describe("env override", () => {
  it("loadTokens reads from SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars", async () => {
    process.env.SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
    process.env.SUPABASE_ANON_KEY = ANON_KEY;
    const { loadTokens } = await import("../supabase.js");
    const t = loadTokens();
    expect(t?.url).toBe(SUPABASE_URL);
    expect(t?.serviceRoleKey).toBe(SERVICE_ROLE_KEY);
    expect(t?.anonKey).toBe(ANON_KEY);
  });

  it("returns null when no env vars and no stored tokens", async () => {
    const { loadTokens } = await import("../supabase.js");
    expect(loadTokens()).toBeNull();
  });
});

// ── connector registry ───────────────────────────────────────────────────────

describe("connectorRegistry", () => {
  it("supabase is registered as a PAT connector with connect/test/delete", async () => {
    const { CONNECTORS } = await import("../connectorRegistry.js");
    const entry = CONNECTORS.find((c) => c.id === "supabase");
    expect(entry).toBeDefined();
    expect(entry?.authKind).toBe("pat");
    expect(entry?.supports.connect).toBe(true);
    expect(entry?.supports.test).toBe(true);
    expect(entry?.supports.delete).toBe(true);
  });
});
