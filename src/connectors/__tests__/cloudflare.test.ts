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

function cfOk<T>(result: T): object {
  return { success: true, errors: [], messages: [], result };
}

function cfFail(code: number, message: string): object {
  return {
    success: false,
    errors: [{ code, message }],
    messages: [],
    result: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Test harness ───────────────────────────────────────────────────────────

const tmpDir = join(os.tmpdir(), `patchwork-cloudflare-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── normalizeError ─────────────────────────────────────────────────────────

describe("normalizeError", () => {
  it("maps HTTP Response status codes", async () => {
    const { CloudflareConnector } = await import("../cloudflare.js");
    const c = new CloudflareConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(401)).code).toBe("auth_expired");
    expect(c.normalizeError(make(403)).code).toBe("permission_denied");
    expect(c.normalizeError(make(404)).code).toBe("not_found");
    expect(c.normalizeError(make(429)).code).toBe("rate_limited");
    expect(c.normalizeError(make(500)).code).toBe("provider_error");
  });

  it("marks 429 + 5xx retryable; 4xx non-retryable", async () => {
    const { CloudflareConnector } = await import("../cloudflare.js");
    const c = new CloudflareConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(429)).retryable).toBe(true);
    expect(c.normalizeError(make(503)).retryable).toBe(true);
    expect(c.normalizeError(make(401)).retryable).toBe(false);
    expect(c.normalizeError(make(404)).retryable).toBe(false);
  });

  it("parses CF: prefixed error messages from success:false body", async () => {
    const { CloudflareConnector } = await import("../cloudflare.js");
    const c = new CloudflareConnector();
    const err = new Error("CF:9109: Invalid API token");
    expect(c.normalizeError(err).code).toBe("auth_expired");
  });

  it("maps unknown CF error to provider_error", async () => {
    const { CloudflareConnector } = await import("../cloudflare.js");
    const c = new CloudflareConnector();
    const err = new Error("CF:1234: Zone not found");
    expect(c.normalizeError(err).code).toBe("provider_error");
  });

  it("detects ENOTFOUND/ECONNREFUSED as network_error", async () => {
    const { CloudflareConnector } = await import("../cloudflare.js");
    const c = new CloudflareConnector();
    expect(
      c.normalizeError(new Error("getaddrinfo ENOTFOUND api.cloudflare.com"))
        .code,
    ).toBe("network_error");
    expect(c.normalizeError(new Error("ECONNREFUSED")).code).toBe(
      "network_error",
    );
  });
});

// ── listZones ─────────────────────────────────────────────────────────────

describe("listZones", () => {
  it("GETs /zones and returns zone array", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const { getCloudflareConnector } = await import("../cloudflare.js");

    const zone = {
      id: "zone1",
      name: "example.com",
      status: "active",
      nameservers: ["ns1"],
      plan: { name: "Free" },
    };
    const { calls } = installFetchMock(() => jsonResponse(cfOk([zone])));

    const c = getCloudflareConnector();
    const zones = await c.listZones();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/zones?");
    expect(zones).toHaveLength(1);
    expect(zones[0]!.id).toBe("zone1");
  });

  it("passes name filter as query param", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const { getCloudflareConnector } = await import("../cloudflare.js");

    const { calls } = installFetchMock(() => jsonResponse(cfOk([])));
    const c = getCloudflareConnector();
    await c.listZones("example.com");

    expect(calls[0]!.url).toContain("name=example.com");
  });

  it("throws when success is false", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const { getCloudflareConnector } = await import("../cloudflare.js");

    installFetchMock(() =>
      jsonResponse(cfFail(7003, "Could not route to /zones")),
    );
    const c = getCloudflareConnector();
    await expect(c.listZones()).rejects.toThrow(/7003/);
  });

  it("uses Bearer auth header", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "mytoken123";
    const { getCloudflareConnector } = await import("../cloudflare.js");

    const { calls } = installFetchMock(() => jsonResponse(cfOk([])));
    const c = getCloudflareConnector();
    await c.listZones();

    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mytoken123");
  });
});

// ── createDnsRecord ────────────────────────────────────────────────────────

describe("createDnsRecord", () => {
  it("POSTs to /zones/{id}/dns_records with correct body", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const { getCloudflareConnector } = await import("../cloudflare.js");

    const record = {
      id: "rec1",
      type: "A",
      name: "api.example.com",
      content: "1.2.3.4",
      ttl: 300,
      proxied: false,
      proxiable: true,
      created_on: "2026-01-01T00:00:00Z",
      modified_on: "2026-01-01T00:00:00Z",
    };
    const { calls } = installFetchMock(() => jsonResponse(cfOk(record)));

    const c = getCloudflareConnector();
    const out = await c.createDnsRecord(
      "zone1",
      "A",
      "api.example.com",
      "1.2.3.4",
      300,
      false,
    );

    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.url).toContain("/zones/zone1/dns_records");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({
      type: "A",
      name: "api.example.com",
      content: "1.2.3.4",
      ttl: 300,
      proxied: false,
    });
    expect(out.id).toBe("rec1");
  });

  it("omits optional ttl/proxied when not provided", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const { getCloudflareConnector } = await import("../cloudflare.js");

    const { calls } = installFetchMock(() =>
      jsonResponse(
        cfOk({
          id: "r1",
          type: "CNAME",
          name: "www",
          content: "example.com",
          ttl: 1,
          proxied: true,
          proxiable: true,
          created_on: "",
          modified_on: "",
        }),
      ),
    );
    const c = getCloudflareConnector();
    await c.createDnsRecord("zone1", "CNAME", "www", "example.com");

    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.ttl).toBeUndefined();
    expect(body.proxied).toBeUndefined();
  });
});

// ── purgeCache ─────────────────────────────────────────────────────────────

describe("purgeCache", () => {
  it("purges everything when no params passed", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const { getCloudflareConnector } = await import("../cloudflare.js");

    const { calls } = installFetchMock(() =>
      jsonResponse(cfOk({ id: "zone1" })),
    );
    const c = getCloudflareConnector();
    await c.purgeCache("zone1");

    expect(calls[0]!.url).toContain("/zones/zone1/purge_cache");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.purge_everything).toBe(true);
  });

  it("sends specific files array when provided", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const { getCloudflareConnector } = await import("../cloudflare.js");

    const { calls } = installFetchMock(() =>
      jsonResponse(cfOk({ id: "zone1" })),
    );
    const c = getCloudflareConnector();
    await c.purgeCache("zone1", { files: ["https://example.com/style.css"] });

    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.files).toEqual(["https://example.com/style.css"]);
    expect(body.purge_everything).toBeUndefined();
  });

  it("supports tags, hosts, and prefixes", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const { getCloudflareConnector } = await import("../cloudflare.js");

    const { calls } = installFetchMock(() =>
      jsonResponse(cfOk({ id: "zone1" })),
    );
    const c = getCloudflareConnector();
    await c.purgeCache("zone1", {
      tags: ["tag1"],
      hosts: ["cdn.example.com"],
      prefixes: ["/assets/"],
    });

    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.tags).toEqual(["tag1"]);
    expect(body.hosts).toEqual(["cdn.example.com"]);
    expect(body.prefixes).toEqual(["/assets/"]);
  });
});

// ── connect handler ────────────────────────────────────────────────────────

describe("handleCloudflareConnect", () => {
  it("rejects invalid JSON", async () => {
    const { handleCloudflareConnect } = await import("../cloudflare.js");
    const r = await handleCloudflareConnect("not json");
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid JSON/);
  });

  it("requires apiToken field", async () => {
    const { handleCloudflareConnect } = await import("../cloudflare.js");
    const r = await handleCloudflareConnect(JSON.stringify({}));
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/apiToken is required/);
  });

  it("validates token and stores with account + email", async () => {
    const { handleCloudflareConnect, loadTokens } = await import(
      "../cloudflare.js"
    );

    let _callCount = 0;
    installFetchMock((url) => {
      _callCount++;
      if (url.includes("/user/tokens/verify")) {
        return jsonResponse(cfOk({ id: "tok1", status: "active" }));
      }
      if (url.includes("/user") && !url.includes("tokens")) {
        return jsonResponse(cfOk({ email: "user@example.com" }));
      }
      if (url.includes("/accounts")) {
        return jsonResponse(cfOk([{ id: "acct123", name: "My Org" }]));
      }
      return jsonResponse({ ok: true });
    });

    const r = await handleCloudflareConnect(
      JSON.stringify({ apiToken: "tok-abc" }),
    );

    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      ok: boolean;
      accountId?: string;
      email?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.email).toBe("user@example.com");
    expect(body.accountId).toBe("acct123");

    const stored = loadTokens();
    expect(stored?.apiToken).toBe("tok-abc");
    expect(stored?.accountId).toBe("acct123");
    expect(stored?.email).toBe("user@example.com");
  });

  it("accepts explicit accountId and skips account fetch", async () => {
    const { handleCloudflareConnect, loadTokens } = await import(
      "../cloudflare.js"
    );

    const { calls } = installFetchMock((url) => {
      if (url.includes("/user/tokens/verify"))
        return jsonResponse(cfOk({ status: "active" }));
      if (url.includes("/user"))
        return jsonResponse(cfOk({ email: "u@x.com" }));
      return jsonResponse(cfOk([]));
    });

    await handleCloudflareConnect(
      JSON.stringify({ apiToken: "tok", accountId: "explicit-acct" }),
    );

    const stored = loadTokens();
    expect(stored?.accountId).toBe("explicit-acct");
    // Should not call /accounts
    expect(calls.some((c) => c.url.includes("/accounts"))).toBe(false);
  });

  it("returns 401 when Cloudflare rejects token", async () => {
    const { handleCloudflareConnect, loadTokens } = await import(
      "../cloudflare.js"
    );

    installFetchMock(() => new Response(null, { status: 403 }));
    const r = await handleCloudflareConnect(
      JSON.stringify({ apiToken: "bad-token" }),
    );

    expect(r.status).toBe(401);
    expect(loadTokens()).toBeNull();
  });

  it("returns 401 when success:false in verify body", async () => {
    const { handleCloudflareConnect } = await import("../cloudflare.js");

    installFetchMock(() => jsonResponse(cfFail(9109, "Invalid API Token")));
    const r = await handleCloudflareConnect(
      JSON.stringify({ apiToken: "bad" }),
    );

    expect(r.status).toBe(401);
    expect(r.body).toMatch(/Invalid API Token/);
  });
});

// ── disconnect ─────────────────────────────────────────────────────────────

describe("handleCloudflareDisconnect", () => {
  it("clears stored tokens", async () => {
    const { handleCloudflareDisconnect, saveTokens, loadTokens } = await import(
      "../cloudflare.js"
    );
    saveTokens({ apiToken: "tok", connected_at: new Date().toISOString() });
    expect(loadTokens()).not.toBeNull();

    const r = handleCloudflareDisconnect();
    expect(r.status).toBe(200);
    expect(loadTokens()).toBeNull();
  });
});

// ── getStatus ──────────────────────────────────────────────────────────────

describe("getStatus", () => {
  it("returns disconnected when no tokens", async () => {
    const { getCloudflareConnector } = await import("../cloudflare.js");
    const s = getCloudflareConnector().getStatus();
    expect(s.status).toBe("disconnected");
  });

  it("returns connected + workspace label from email", async () => {
    const { getCloudflareConnector, saveTokens } = await import(
      "../cloudflare.js"
    );
    saveTokens({
      apiToken: "tok",
      email: "u@example.com",
      connected_at: new Date().toISOString(),
    });
    const s = getCloudflareConnector().getStatus();
    expect(s.status).toBe("connected");
    expect(s.workspace).toContain("u@example.com");
  });

  it("falls back to accountId label when no email", async () => {
    const { getCloudflareConnector, saveTokens } = await import(
      "../cloudflare.js"
    );
    saveTokens({
      apiToken: "tok",
      accountId: "acct123",
      connected_at: new Date().toISOString(),
    });
    const s = getCloudflareConnector().getStatus();
    expect(s.workspace).toContain("acct123");
  });
});

// ── env var fallback ───────────────────────────────────────────────────────

describe("loadTokens env fallback", () => {
  it("reads from CLOUDFLARE_API_TOKEN env", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "env-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "env-acct";
    const { loadTokens } = await import("../cloudflare.js");
    const t = loadTokens();
    expect(t?.apiToken).toBe("env-token");
    expect(t?.accountId).toBe("env-acct");
  });

  it("returns null when no token set and no stored tokens", async () => {
    const { loadTokens } = await import("../cloudflare.js");
    expect(loadTokens()).toBeNull();
  });
});

// ── connectorRegistry ─────────────────────────────────────────────────────

describe("connectorRegistry", () => {
  it("includes cloudflare in CONNECTORS list", async () => {
    const { CONNECTORS } = await import("../connectorRegistry.js");
    const cf = CONNECTORS.find((c) => c.id === "cloudflare");
    expect(cf).toBeDefined();
    expect(cf?.authKind).toBe("pat");
    expect(cf?.supports.connect).toBe(true);
    expect(cf?.supports.test).toBe(true);
    expect(cf?.supports.delete).toBe(true);
  });
});
