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

const tmpDir = join(os.tmpdir(), `patchwork-grafana-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  delete process.env.GRAFANA_API_KEY;
  delete process.env.GRAFANA_BASE_URL;
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.GRAFANA_API_KEY;
  delete process.env.GRAFANA_BASE_URL;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── normalizeError ─────────────────────────────────────────────────────────

describe("normalizeError", () => {
  it("maps HTTP status codes from Response", async () => {
    const { GrafanaConnector } = await import("../grafana.js");
    const c = new GrafanaConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(401)).code).toBe("auth_expired");
    expect(c.normalizeError(make(403)).code).toBe("permission_denied");
    expect(c.normalizeError(make(404)).code).toBe("not_found");
    expect(c.normalizeError(make(429)).code).toBe("rate_limited");
    expect(c.normalizeError(make(500)).code).toBe("provider_error");
  });

  it("marks 429 + 5xx retryable; 4xx non-retryable", async () => {
    const { GrafanaConnector } = await import("../grafana.js");
    const c = new GrafanaConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(429)).retryable).toBe(true);
    expect(c.normalizeError(make(503)).retryable).toBe(true);
    expect(c.normalizeError(make(401)).retryable).toBe(false);
    expect(c.normalizeError(make(403)).retryable).toBe(false);
    expect(c.normalizeError(make(404)).retryable).toBe(false);
  });

  it("detects ENOTFOUND/ECONNREFUSED as network_error", async () => {
    const { GrafanaConnector } = await import("../grafana.js");
    const c = new GrafanaConnector();
    expect(
      c.normalizeError(new Error("getaddrinfo ENOTFOUND grafana.local")).code,
    ).toBe("network_error");
    expect(c.normalizeError(new Error("ECONNREFUSED")).code).toBe(
      "network_error",
    );
  });

  it("defaults to provider_error", async () => {
    const { GrafanaConnector } = await import("../grafana.js");
    const c = new GrafanaConnector();
    expect(c.normalizeError(new Error("boom")).code).toBe("provider_error");
    expect(c.normalizeError("plain string").code).toBe("provider_error");
  });
});

// ── getDashboards ──────────────────────────────────────────────────────────

describe("getDashboards", () => {
  it("calls /api/search with type=dash-db and returns array", async () => {
    process.env.GRAFANA_API_KEY = "glsa_test_key";
    process.env.GRAFANA_BASE_URL = "http://localhost:3000";
    const { getGrafanaConnector } = await import("../grafana.js");

    const mockDashboards = [
      {
        id: 1,
        uid: "abc123",
        title: "My Dashboard",
        url: "/d/abc123",
        tags: ["production"],
        folderTitle: "General",
        folderId: 0,
      },
    ];
    const { calls } = installFetchMock(() => jsonResponse(mockDashboards));

    const c = getGrafanaConnector();
    const result = await c.getDashboards();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/api/search");
    expect(calls[0]!.url).toContain("type=dash-db");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer glsa_test_key");
    expect(result).toHaveLength(1);
    expect(result[0]!.uid).toBe("abc123");
  });

  it("includes query param when provided", async () => {
    process.env.GRAFANA_API_KEY = "glsa_test_key";
    process.env.GRAFANA_BASE_URL = "http://localhost:3000";
    const { getGrafanaConnector } = await import("../grafana.js");

    const { calls } = installFetchMock(() => jsonResponse([]));
    const c = getGrafanaConnector();
    await c.getDashboards("CPU metrics", 10);

    expect(calls[0]!.url).toContain("query=CPU+metrics");
    expect(calls[0]!.url).toContain("limit=10");
  });

  it("strips trailing slash from baseUrl", async () => {
    process.env.GRAFANA_API_KEY = "glsa_test_key";
    process.env.GRAFANA_BASE_URL = "http://localhost:3000/";
    const { getGrafanaConnector } = await import("../grafana.js");

    const { calls } = installFetchMock(() => jsonResponse([]));
    const c = getGrafanaConnector();
    await c.getDashboards();

    expect(calls[0]!.url).toBe(
      "http://localhost:3000/api/search?type=dash-db&limit=50",
    );
  });
});

// ── createAnnotation ───────────────────────────────────────────────────────

describe("createAnnotation", () => {
  it("POSTs to /api/annotations with correct body shape", async () => {
    process.env.GRAFANA_API_KEY = "glsa_test_key";
    process.env.GRAFANA_BASE_URL = "http://localhost:3000";
    const { getGrafanaConnector } = await import("../grafana.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({ id: 42, message: "Annotation added" }),
    );

    const c = getGrafanaConnector();
    const result = await c.createAnnotation("dash-uid-1", 5, "Deployed v1.2", {
      tags: ["deploy", "production"],
      time: 1700000000000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:3000/api/annotations");
    expect(calls[0]!.init?.method).toBe("POST");

    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body.dashboardUID).toBe("dash-uid-1");
    expect(body.panelId).toBe(5);
    expect(body.text).toBe("Deployed v1.2");
    expect(body.tags).toEqual(["deploy", "production"]);
    expect(body.time).toBe(1700000000000);

    expect(result.id).toBe(42);
  });

  it("omits optional fields when not provided", async () => {
    process.env.GRAFANA_API_KEY = "glsa_test_key";
    process.env.GRAFANA_BASE_URL = "http://localhost:3000";
    const { getGrafanaConnector } = await import("../grafana.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({ id: 1, message: "ok" }),
    );

    const c = getGrafanaConnector();
    await c.createAnnotation("dash-uid-2", 1, "Simple note");

    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body.tags).toBeUndefined();
    expect(body.time).toBeUndefined();
    expect(body.timeEnd).toBeUndefined();
  });
});

// ── getAnnotations ─────────────────────────────────────────────────────────

describe("getAnnotations", () => {
  it("returns annotations array", async () => {
    process.env.GRAFANA_API_KEY = "glsa_test_key";
    process.env.GRAFANA_BASE_URL = "http://localhost:3000";
    const { getGrafanaConnector } = await import("../grafana.js");

    const mockAnnotations = [
      {
        id: 1,
        dashboardUID: "abc",
        panelId: 2,
        time: 1000,
        text: "hello",
        tags: [],
      },
    ];
    const { calls } = installFetchMock(() => jsonResponse(mockAnnotations));

    const c = getGrafanaConnector();
    const result = await c.getAnnotations({
      dashboardUid: "abc",
      limit: 10,
      from: 900,
      to: 1100,
    });

    expect(calls[0]!.url).toContain("dashboardUID=abc");
    expect(calls[0]!.url).toContain("limit=10");
    expect(calls[0]!.url).toContain("from=900");
    expect(calls[0]!.url).toContain("to=1100");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(1);
  });

  it("calls /api/annotations without query string when no options", async () => {
    process.env.GRAFANA_API_KEY = "glsa_test_key";
    process.env.GRAFANA_BASE_URL = "http://localhost:3000";
    const { getGrafanaConnector } = await import("../grafana.js");

    const { calls } = installFetchMock(() => jsonResponse([]));
    const c = getGrafanaConnector();
    await c.getAnnotations();

    expect(calls[0]!.url).toBe("http://localhost:3000/api/annotations");
  });
});

// ── verifyGrafanaWebhook ───────────────────────────────────────────────────

describe("verifyGrafanaWebhook", () => {
  it("returns true for a valid HMAC-SHA256 signature", async () => {
    const { verifyGrafanaWebhook } = await import("../grafana.js");
    const secret = "mysecret";
    const body = '{"alert":"firing"}';
    const sig = createHmac("sha256", secret).update(body).digest("hex");

    expect(verifyGrafanaWebhook(body, sig, secret)).toBe(true);
  });

  it("accepts sha256= prefixed signature", async () => {
    const { verifyGrafanaWebhook } = await import("../grafana.js");
    const secret = "mysecret";
    const body = '{"alert":"firing"}';
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    expect(verifyGrafanaWebhook(body, sig, secret)).toBe(true);
  });

  it("returns false for a wrong signature", async () => {
    const { verifyGrafanaWebhook } = await import("../grafana.js");
    expect(
      verifyGrafanaWebhook(
        '{"alert":"firing"}',
        "deadbeef".repeat(8),
        "secret",
      ),
    ).toBe(false);
  });

  it("returns false when signatureHeader is empty", async () => {
    const { verifyGrafanaWebhook } = await import("../grafana.js");
    expect(verifyGrafanaWebhook("body", "", "secret")).toBe(false);
  });

  it("returns false when signingSecret is empty", async () => {
    const { verifyGrafanaWebhook } = await import("../grafana.js");
    expect(verifyGrafanaWebhook("body", "abc123", "")).toBe(false);
  });

  it("works with Buffer rawBody", async () => {
    const { verifyGrafanaWebhook } = await import("../grafana.js");
    const secret = "buftest";
    const body = Buffer.from('{"foo":"bar"}');
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyGrafanaWebhook(body, sig, secret)).toBe(true);
  });
});

// ── handleGrafanaConnect ───────────────────────────────────────────────────

describe("handleGrafanaConnect", () => {
  it("rejects invalid JSON", async () => {
    const { handleGrafanaConnect } = await import("../grafana.js");
    const r = await handleGrafanaConnect("not json");
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid JSON/);
  });

  it("requires apiKey field", async () => {
    const { handleGrafanaConnect } = await import("../grafana.js");
    const r = await handleGrafanaConnect(
      JSON.stringify({ baseUrl: "http://localhost:3000" }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/apiKey is required/);
  });

  it("requires baseUrl field", async () => {
    const { handleGrafanaConnect } = await import("../grafana.js");
    const r = await handleGrafanaConnect(
      JSON.stringify({ apiKey: "glsa_test" }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/baseUrl is required/);
  });

  it("rejects non-http baseUrl", async () => {
    const { handleGrafanaConnect } = await import("../grafana.js");
    const r = await handleGrafanaConnect(
      JSON.stringify({
        apiKey: "glsa_test",
        baseUrl: "ftp://grafana.example.com",
      }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/http/i);
  });

  it("validates via /api/org and stores tokens on success", async () => {
    const { handleGrafanaConnect, loadTokens } = await import("../grafana.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({ id: 1, name: "Main Org." }),
    );

    const r = await handleGrafanaConnect(
      JSON.stringify({
        apiKey: "glsa_abc123",
        baseUrl: "http://localhost:3000",
      }),
    );

    expect(r.status).toBe(200);
    expect(calls[0]!.url).toBe("http://localhost:3000/api/org");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer glsa_abc123");

    const body = JSON.parse(r.body) as {
      ok: boolean;
      orgName?: string;
      baseUrl?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.orgName).toBe("Main Org.");

    const stored = loadTokens();
    expect(stored?.apiKey).toBe("glsa_abc123");
    expect(stored?.baseUrl).toBe("http://localhost:3000");
    expect(stored?.orgName).toBe("Main Org.");
  });

  it("returns 401 when Grafana rejects token, without persisting", async () => {
    const { handleGrafanaConnect, loadTokens } = await import("../grafana.js");
    installFetchMock(() => new Response("Unauthorized", { status: 401 }));
    const r = await handleGrafanaConnect(
      JSON.stringify({ apiKey: "bad_key", baseUrl: "http://localhost:3000" }),
    );
    expect(r.status).toBe(401);
    expect(loadTokens()).toBeNull();
  });

  it("strips trailing slash from baseUrl before storing", async () => {
    const { handleGrafanaConnect, loadTokens } = await import("../grafana.js");
    installFetchMock(() => jsonResponse({ id: 1, name: "Org" }));
    await handleGrafanaConnect(
      JSON.stringify({ apiKey: "glsa_x", baseUrl: "http://localhost:3000/" }),
    );
    expect(loadTokens()?.baseUrl).toBe("http://localhost:3000");
  });
});

// ── handleGrafanaDisconnect ────────────────────────────────────────────────

describe("handleGrafanaDisconnect", () => {
  it("clears stored tokens", async () => {
    const { handleGrafanaDisconnect, saveTokens, loadTokens } = await import(
      "../grafana.js"
    );
    saveTokens({
      apiKey: "glsa_abc",
      baseUrl: "http://localhost:3000",
      connected_at: new Date().toISOString(),
    });
    expect(loadTokens()).not.toBeNull();
    const r = handleGrafanaDisconnect();
    expect(r.status).toBe(200);
    expect(loadTokens()).toBeNull();
  });
});

// ── getStatus ──────────────────────────────────────────────────────────────

describe("getStatus", () => {
  it("returns disconnected when no tokens", async () => {
    const { getGrafanaConnector } = await import("../grafana.js");
    const s = getGrafanaConnector().getStatus();
    expect(s.status).toBe("disconnected");
  });

  it("returns connected + workspace label from orgName", async () => {
    const { getGrafanaConnector, saveTokens } = await import("../grafana.js");
    saveTokens({
      apiKey: "glsa_abc",
      baseUrl: "http://localhost:3000",
      orgName: "Main Org.",
      connected_at: new Date().toISOString(),
    });
    const s = getGrafanaConnector().getStatus();
    expect(s.status).toBe("connected");
    expect(s.workspace).toBe("Main Org.");
  });

  it("falls back to baseUrl when orgName absent", async () => {
    const { getGrafanaConnector, saveTokens } = await import("../grafana.js");
    saveTokens({
      apiKey: "glsa_abc",
      baseUrl: "http://localhost:3000",
      connected_at: new Date().toISOString(),
    });
    const s = getGrafanaConnector().getStatus();
    expect(s.workspace).toBe("http://localhost:3000");
  });
});

// ── env var override ───────────────────────────────────────────────────────

describe("loadTokens env override", () => {
  it("reads from GRAFANA_API_KEY + GRAFANA_BASE_URL env vars", async () => {
    process.env.GRAFANA_API_KEY = "env_key";
    process.env.GRAFANA_BASE_URL = "https://grafana.example.com";
    const { loadTokens } = await import("../grafana.js");
    const t = loadTokens();
    expect(t?.apiKey).toBe("env_key");
    expect(t?.baseUrl).toBe("https://grafana.example.com");
  });

  it("returns null when neither env nor stored tokens present", async () => {
    const { loadTokens } = await import("../grafana.js");
    expect(loadTokens()).toBeNull();
  });
});
