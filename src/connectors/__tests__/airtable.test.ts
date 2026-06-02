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

const tmpDir = join(os.tmpdir(), `patchwork-airtable-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  delete process.env.AIRTABLE_ACCESS_TOKEN;
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.AIRTABLE_ACCESS_TOKEN;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── normalizeError ─────────────────────────────────────────────────────────

describe("normalizeError", () => {
  it("maps HTTP status codes from Response", async () => {
    const { AirtableConnector } = await import("../airtable.js");
    const c = new AirtableConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(401)).code).toBe("auth_expired");
    expect(c.normalizeError(make(403)).code).toBe("permission_denied");
    expect(c.normalizeError(make(404)).code).toBe("not_found");
    expect(c.normalizeError(make(422)).code).toBe("provider_error");
    expect(c.normalizeError(make(429)).code).toBe("rate_limited");
    expect(c.normalizeError(make(500)).code).toBe("provider_error");
  });

  it("marks 429 + 5xx retryable; 4xx non-retryable", async () => {
    const { AirtableConnector } = await import("../airtable.js");
    const c = new AirtableConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(429)).retryable).toBe(true);
    expect(c.normalizeError(make(503)).retryable).toBe(true);
    expect(c.normalizeError(make(401)).retryable).toBe(false);
    expect(c.normalizeError(make(403)).retryable).toBe(false);
    expect(c.normalizeError(make(404)).retryable).toBe(false);
    expect(c.normalizeError(make(422)).retryable).toBe(false);
  });

  it("detects ENOTFOUND/ECONNREFUSED as network_error", async () => {
    const { AirtableConnector } = await import("../airtable.js");
    const c = new AirtableConnector();
    expect(c.normalizeError(new Error("getaddrinfo ENOTFOUND x")).code).toBe(
      "network_error",
    );
    expect(c.normalizeError(new Error("ECONNREFUSED")).code).toBe(
      "network_error",
    );
  });

  it("defaults to provider_error", async () => {
    const { AirtableConnector } = await import("../airtable.js");
    const c = new AirtableConnector();
    expect(c.normalizeError(new Error("boom")).code).toBe("provider_error");
    expect(c.normalizeError("plain string").code).toBe("provider_error");
  });
});

// ── listRecords URL encoding + maxRecords cap ──────────────────────────────

describe("listRecords", () => {
  it("URL-encodes filterByFormula and caps maxRecords at 1000", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({ records: [], offset: undefined }),
    );

    const c = getAirtableConnector();
    await c.listRecords("appXYZ", "Tasks", {
      filterByFormula: "AND({Status}='Open', {Name}='A&B')",
      maxRecords: 5000, // should be capped at 1000
    });

    expect(calls).toHaveLength(1);
    const url = calls[0]!.url;
    expect(url).toContain("/v0/appXYZ/Tasks?");
    expect(url).toContain("maxRecords=1000");
    // URLSearchParams encodes — verify the raw formula is NOT present
    expect(url).not.toContain("{Status}='Open'");
    // Verify the encoded form is present
    expect(url).toMatch(/filterByFormula=AND/);
    expect(url).toContain("%7BStatus%7D"); // {Status} encoded
    expect(url).toContain("%26"); // & encoded
  });

  it("defaults maxRecords to 100 when omitted", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");
    const { calls } = installFetchMock(() => jsonResponse({ records: [] }));
    const c = getAirtableConnector();
    await c.listRecords("appXYZ", "Tasks");
    expect(calls[0]!.url).toContain("maxRecords=100");
  });

  it("encodes baseId and table name with special chars", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");
    const { calls } = installFetchMock(() => jsonResponse({ records: [] }));
    const c = getAirtableConnector();
    await c.listRecords("appXYZ", "My Table/With Slash");
    expect(calls[0]!.url).toContain("My%20Table%2FWith%20Slash");
  });

  it("serialises sort and fields params", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");
    const { calls } = installFetchMock(() => jsonResponse({ records: [] }));
    const c = getAirtableConnector();
    await c.listRecords("appXYZ", "Tasks", {
      sort: [{ field: "Name", direction: "desc" }],
      fields: ["Name", "Status"],
      view: "Grid view",
    });
    const url = calls[0]!.url;
    expect(url).toMatch(/sort%5B0%5D%5Bfield%5D=Name/);
    expect(url).toMatch(/sort%5B0%5D%5Bdirection%5D=desc/);
    expect(url).toMatch(/fields%5B%5D=Name/);
    expect(url).toMatch(/fields%5B%5D=Status/);
    expect(url).toMatch(/view=Grid\+view|view=Grid%20view/);
  });
});

// ── createRecord wraps fields in records array ─────────────────────────────

describe("createRecord", () => {
  it("POSTs JSON with { records: [{ fields }] } shape", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({
        records: [
          {
            id: "recNEW1",
            createdTime: "2026-01-01T00:00:00.000Z",
            fields: { Name: "Hello" },
          },
        ],
      }),
    );

    const c = getAirtableConnector();
    const out = await c.createRecord("appXYZ", "Tasks", { Name: "Hello" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({ records: [{ fields: { Name: "Hello" } }] });
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer pat_test_abc");
    expect(out.id).toBe("recNEW1");
  });

  it("throws when Airtable returns empty records array", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");
    installFetchMock(() => jsonResponse({ records: [] }));
    const c = getAirtableConnector();
    await expect(c.createRecord("appXYZ", "Tasks", {})).rejects.toThrow(
      /no record/i,
    );
  });
});

// ── updateRecord ───────────────────────────────────────────────────────────

describe("updateRecord", () => {
  it("PATCHes with { fields } body (no records wrapper)", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");
    const { calls } = installFetchMock(() =>
      jsonResponse({
        id: "rec1",
        createdTime: "2026-01-01T00:00:00.000Z",
        fields: { Status: "Done" },
      }),
    );
    const c = getAirtableConnector();
    const out = await c.updateRecord("appXYZ", "Tasks", "rec1", {
      Status: "Done",
    });
    expect(calls[0]!.init?.method).toBe("PATCH");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({ fields: { Status: "Done" } });
    expect(out.fields.Status).toBe("Done");
  });
});

// ── Connect handler captures user id + email ───────────────────────────────

describe("handleAirtableConnect", () => {
  it("rejects invalid JSON", async () => {
    const { handleAirtableConnect } = await import("../airtable.js");
    const r = await handleAirtableConnect("not json");
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid JSON/);
  });

  it("requires accessToken field", async () => {
    const { handleAirtableConnect } = await import("../airtable.js");
    const r = await handleAirtableConnect(JSON.stringify({}));
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/accessToken is required/);
  });

  it("validates via /v0/meta/whoami and captures user id + email", async () => {
    const { handleAirtableConnect, loadTokens } = await import(
      "../airtable.js"
    );

    const { calls } = installFetchMock(() =>
      jsonResponse({ id: "usrAAA", email: "user@example.com" }),
    );

    const r = await handleAirtableConnect(
      JSON.stringify({ accessToken: "patABC123" }),
    );

    expect(r.status).toBe(200);
    expect(calls[0]!.url).toBe("https://api.airtable.com/v0/meta/whoami");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer patABC123");

    const body = JSON.parse(r.body) as {
      ok: boolean;
      userId?: string;
      email?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.userId).toBe("usrAAA");
    expect(body.email).toBe("user@example.com");

    const stored = loadTokens();
    expect(stored?.userId).toBe("usrAAA");
    expect(stored?.email).toBe("user@example.com");
    expect(stored?.accessToken).toBe("patABC123");
  });

  it("captures user id when email scope absent", async () => {
    const { handleAirtableConnect, loadTokens } = await import(
      "../airtable.js"
    );
    installFetchMock(() => jsonResponse({ id: "usrBBB" })); // no email
    const r = await handleAirtableConnect(
      JSON.stringify({ accessToken: "patXYZ" }),
    );
    expect(r.status).toBe(200);
    const stored = loadTokens();
    expect(stored?.userId).toBe("usrBBB");
    expect(stored?.email).toBeUndefined();
  });

  it("returns 401 when Airtable rejects token, without persisting", async () => {
    const { handleAirtableConnect, loadTokens } = await import(
      "../airtable.js"
    );
    installFetchMock(() => new Response("nope", { status: 401 }));
    const r = await handleAirtableConnect(
      JSON.stringify({ accessToken: "patBAD" }),
    );
    expect(r.status).toBe(401);
    expect(loadTokens()).toBeNull();
  });
});

// ── Disconnect ─────────────────────────────────────────────────────────────

describe("handleAirtableDisconnect", () => {
  it("clears stored tokens", async () => {
    const { handleAirtableDisconnect, saveTokens, loadTokens } = await import(
      "../airtable.js"
    );
    saveTokens({
      accessToken: "patABC",
      connected_at: new Date().toISOString(),
    });
    expect(loadTokens()).not.toBeNull();
    const r = handleAirtableDisconnect();
    expect(r.status).toBe(200);
    expect(loadTokens()).toBeNull();
  });
});

// ── getStatus ──────────────────────────────────────────────────────────────

describe("getStatus", () => {
  it("returns disconnected when no tokens", async () => {
    const { getAirtableConnector } = await import("../airtable.js");
    const s = getAirtableConnector().getStatus();
    expect(s.status).toBe("disconnected");
  });

  it("returns connected + workspace label from email", async () => {
    const { getAirtableConnector, saveTokens } = await import("../airtable.js");
    saveTokens({
      accessToken: "patABC",
      userId: "usrAAA",
      email: "u@x.com",
      connected_at: new Date().toISOString(),
    });
    const s = getAirtableConnector().getStatus();
    expect(s.status).toBe("connected");
    expect(s.workspace).toContain("u@x.com");
  });
});

// ── OAuth token storage ────────────────────────────────────────────────────

describe("OAuth token storage", () => {
  it("saveOAuthTokens / loadRawTokens round-trips OAuth tokens", async () => {
    const { saveOAuthTokens, loadRawTokens } = await import("../airtable.js");
    const now = new Date().toISOString();
    saveOAuthTokens({
      accessToken: "oat_abc",
      refreshToken: "oat_refresh",
      expiresAt: now,
      scopes: ["data.records:read"],
      connected_at: now,
      _oauth: true,
    });
    const raw = loadRawTokens();
    expect(raw).not.toBeNull();
    expect((raw as { _oauth?: boolean })._oauth).toBe(true);
    expect(raw!.accessToken).toBe("oat_abc");
  });

  it("loadTokens returns accessToken for OAuth tokens (backward compat)", async () => {
    const { saveOAuthTokens, loadTokens } = await import("../airtable.js");
    const now = new Date().toISOString();
    saveOAuthTokens({
      accessToken: "oat_compat",
      refreshToken: "oat_refresh",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ["data.records:read"],
      connected_at: now,
      _oauth: true,
    });
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.accessToken).toBe("oat_compat");
  });

  it("getStatus returns connected for OAuth tokens", async () => {
    const { getAirtableConnector, saveOAuthTokens } = await import(
      "../airtable.js"
    );
    const now = new Date().toISOString();
    saveOAuthTokens({
      accessToken: "oat_status",
      refreshToken: "oat_refresh",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: [],
      connected_at: now,
      _oauth: true,
    });
    const s = getAirtableConnector().getStatus();
    expect(s.status).toBe("connected");
  });

  it("PAT env var takes precedence over stored OAuth tokens", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_env_override";
    const { loadRawTokens, saveOAuthTokens } = await import("../airtable.js");
    const now = new Date().toISOString();
    saveOAuthTokens({
      accessToken: "oat_should_not_load",
      refreshToken: "r",
      expiresAt: now,
      scopes: [],
      connected_at: now,
      _oauth: true,
    });
    const raw = loadRawTokens();
    // Env var should win — returns a synthetic PAT token, not OAuth
    expect(raw!.accessToken).toBe("pat_env_override");
    expect((raw as { _oauth?: boolean })._oauth).toBeUndefined();
  });
});

// ── OAuth refresh flow ─────────────────────────────────────────────────────

describe("OAuth refresh flow", () => {
  it("refreshes expired OAuth token using HTTP Basic auth", async () => {
    process.env.AIRTABLE_CLIENT_ID = "clientId123";
    process.env.AIRTABLE_CLIENT_SECRET = "clientSecret456";

    const { saveOAuthTokens, getAirtableConnector, loadRawTokens } =
      await import("../airtable.js");

    const expiredAt = new Date(Date.now() - 1000).toISOString();
    saveOAuthTokens({
      accessToken: "oat_expired",
      refreshToken: "oat_refresh_token",
      expiresAt: expiredAt,
      scopes: ["data.records:read"],
      connected_at: new Date().toISOString(),
      _oauth: true,
    });

    // Token refresh response
    const { calls } = installFetchMock((url) => {
      if (url.includes("oauth2/v1/token")) {
        return jsonResponse({
          access_token: "oat_new_access",
          refresh_token: "oat_new_refresh",
          expires_in: 3600,
          scope: "data.records:read data.records:write",
        });
      }
      // fallback for any other call (e.g., listBases)
      return jsonResponse({ bases: [] });
    });

    const connector = getAirtableConnector();
    const ctx = await connector.authenticate();

    expect(ctx.token).toBe("oat_new_access");
    expect(ctx.refreshToken).toBe("oat_new_refresh");

    // Check that the token refresh call used Basic auth
    const refreshCall = calls.find((c) => c.url.includes("oauth2/v1/token"));
    expect(refreshCall).toBeDefined();
    const authHeader = (refreshCall!.init?.headers as Record<string, string>)
      .Authorization;
    expect(authHeader).toMatch(/^Basic /);
    const decoded = Buffer.from(authHeader!.slice(6), "base64").toString();
    expect(decoded).toBe("clientId123:clientSecret456");

    // Updated tokens should be persisted
    const raw = loadRawTokens();
    expect(raw!.accessToken).toBe("oat_new_access");

    delete process.env.AIRTABLE_CLIENT_ID;
    delete process.env.AIRTABLE_CLIENT_SECRET;
  });

  it("returns existing token when not expired", async () => {
    process.env.AIRTABLE_CLIENT_ID = "clientId123";
    process.env.AIRTABLE_CLIENT_SECRET = "clientSecret456";

    const { saveOAuthTokens, getAirtableConnector } = await import(
      "../airtable.js"
    );

    const futureAt = new Date(Date.now() + 3600_000).toISOString();
    saveOAuthTokens({
      accessToken: "oat_valid",
      refreshToken: "oat_refresh",
      expiresAt: futureAt,
      scopes: ["data.records:read"],
      connected_at: new Date().toISOString(),
      _oauth: true,
    });

    installFetchMock(() => jsonResponse({ bases: [] }));
    const connector = getAirtableConnector();
    const ctx = await connector.authenticate();

    expect(ctx.token).toBe("oat_valid");

    delete process.env.AIRTABLE_CLIENT_ID;
    delete process.env.AIRTABLE_CLIENT_SECRET;
  });
});

// ── Webhook methods ────────────────────────────────────────────────────────

describe("listWebhooks", () => {
  it("GETs /v0/bases/{baseId}/webhooks and returns webhook array", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test";
    const { getAirtableConnector } = await import("../airtable.js");

    const mockWebhook = {
      id: "wbh1",
      isHookEnabled: true,
      notificationUrl: "https://example.com/hook",
    };
    const { calls } = installFetchMock(() =>
      jsonResponse({ webhooks: [mockWebhook] }),
    );

    const c = getAirtableConnector();
    const result = await c.listWebhooks("appXYZ");

    expect(calls[0]!.url).toBe(
      "https://api.airtable.com/v0/bases/appXYZ/webhooks",
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("wbh1");
  });
});

describe("createWebhook", () => {
  it("POSTs to /v0/bases/{baseId}/webhooks with default filters", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test";
    const { getAirtableConnector } = await import("../airtable.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({
        id: "wbhNEW",
        macSecretBase64: "c2VjcmV0MTIz",
        expirationTime: "2026-12-31T00:00:00.000Z",
      }),
    );

    const c = getAirtableConnector();
    const result = await c.createWebhook("appXYZ", "https://example.com/hook");

    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://api.airtable.com/v0/bases/appXYZ/webhooks",
    );
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.notificationUrl).toBe("https://example.com/hook");
    expect(body.specification.filters.fromSources).toContain("client");
    expect(body.specification.filters.dataTypes).toContain("tableData");
    expect(result.id).toBe("wbhNEW");
    expect(result.macSecretBase64).toBe("c2VjcmV0MTIz");
  });

  it("uses provided custom filters", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test";
    const { getAirtableConnector } = await import("../airtable.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({
        id: "wbhCUSTOM",
        macSecretBase64: "abc",
        expirationTime: null,
      }),
    );

    const c = getAirtableConnector();
    await c.createWebhook("appXYZ", "https://example.com/hook", {
      filters: {
        fromSources: ["publicApi"],
        dataTypes: ["tableData"],
        changeTypes: ["add"],
      },
    });

    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.specification.filters.fromSources).toEqual(["publicApi"]);
    expect(body.specification.filters.changeTypes).toEqual(["add"]);
  });
});

describe("deleteWebhook", () => {
  it("DELETEs /v0/bases/{baseId}/webhooks/{webhookId}", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test";
    const { getAirtableConnector } = await import("../airtable.js");

    const { calls } = installFetchMock(
      () => new Response(null, { status: 200 }),
    );
    const c = getAirtableConnector();
    await c.deleteWebhook("appXYZ", "wbhDEL");

    expect(calls[0]!.init?.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(
      "https://api.airtable.com/v0/bases/appXYZ/webhooks/wbhDEL",
    );
  });
});

describe("getWebhookPayloads", () => {
  it("GETs payloads without cursor", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test";
    const { getAirtableConnector } = await import("../airtable.js");

    const mockResult = { payloads: [], cursor: 1, mightHaveMore: false };
    const { calls } = installFetchMock(() => jsonResponse(mockResult));
    const c = getAirtableConnector();
    const result = await c.getWebhookPayloads("appXYZ", "wbh1");

    expect(calls[0]!.url).toBe(
      "https://api.airtable.com/v0/bases/appXYZ/webhooks/wbh1/payloads",
    );
    expect(result.mightHaveMore).toBe(false);
  });

  it("GETs payloads with cursor appended as query param", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test";
    const { getAirtableConnector } = await import("../airtable.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({ payloads: [], cursor: 5, mightHaveMore: false }),
    );
    const c = getAirtableConnector();
    await c.getWebhookPayloads("appXYZ", "wbh1", 3);

    expect(calls[0]!.url).toContain("?cursor=3");
  });
});

describe("refreshWebhook", () => {
  it("POSTs to /v0/bases/{baseId}/webhooks/{webhookId}/refresh", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test";
    const { getAirtableConnector } = await import("../airtable.js");

    const { calls } = installFetchMock(
      () => new Response(null, { status: 200 }),
    );
    const c = getAirtableConnector();
    await c.refreshWebhook("appXYZ", "wbhREF");

    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://api.airtable.com/v0/bases/appXYZ/webhooks/wbhREF/refresh",
    );
  });
});

// ── verifyAirtableWebhook ──────────────────────────────────────────────────

describe("verifyAirtableWebhook", () => {
  it("returns true for valid HMAC signature", async () => {
    const { verifyAirtableWebhook } = await import("../airtable.js");
    const { createHmac } = await import("node:crypto");

    const secret = Buffer.from("my-secret-bytes");
    const macSecretBase64 = secret.toString("base64");
    const body = Buffer.from('{"test":1}');
    const validHmac = createHmac("sha256", secret).update(body).digest("hex");

    expect(verifyAirtableWebhook(body, validHmac, macSecretBase64)).toBe(true);
  });

  it("returns false for wrong HMAC signature", async () => {
    const { verifyAirtableWebhook } = await import("../airtable.js");

    const secret = Buffer.from("my-secret-bytes");
    const macSecretBase64 = secret.toString("base64");
    const body = Buffer.from('{"test":1}');

    expect(
      verifyAirtableWebhook(body, "deadbeef".repeat(8), macSecretBase64),
    ).toBe(false);
  });

  it("accepts string body as well as Buffer", async () => {
    const { verifyAirtableWebhook } = await import("../airtable.js");
    const { createHmac } = await import("node:crypto");

    const secret = Buffer.from("my-secret-bytes");
    const macSecretBase64 = secret.toString("base64");
    const bodyStr = '{"test":1}';
    const validHmac = createHmac("sha256", secret)
      .update(Buffer.from(bodyStr, "utf-8"))
      .digest("hex");

    expect(verifyAirtableWebhook(bodyStr, validHmac, macSecretBase64)).toBe(
      true,
    );
  });

  it("returns false when length differs (prevents padding oracle)", async () => {
    const { verifyAirtableWebhook } = await import("../airtable.js");

    const secret = Buffer.from("key");
    const macSecretBase64 = secret.toString("base64");

    expect(
      verifyAirtableWebhook(Buffer.from("body"), "short", macSecretBase64),
    ).toBe(false);
  });
});
