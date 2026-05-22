import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── fetch mock helpers ──────────────────────────────────────────────────────

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(
  responder: (call: FetchCall) => {
    status?: number;
    body?: unknown;
    ok?: boolean;
  },
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      const r = responder({ url, init });
      const status = r.status ?? 200;
      const bodyStr = JSON.stringify(r.body ?? {});
      return new Response(bodyStr, {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  ) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ── Test harness (token storage on disk) ────────────────────────────────────

const tmpDir = join(
  os.tmpdir(),
  `patchwork-webflow-${Date.now()}-${Math.random()}`,
);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  delete process.env.WEBFLOW_API_TOKEN;
  delete process.env.WEBFLOW_SITE_ID;
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.WEBFLOW_API_TOKEN;
  delete process.env.WEBFLOW_SITE_ID;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── normalizeError ──────────────────────────────────────────────────────────

describe("normalizeError", () => {
  it("maps HTTP status codes to ConnectorError shapes", async () => {
    const { WebflowConnector } = await import("../webflow.js");
    const c = new WebflowConnector();
    const mk = (s: number) =>
      new Response(null, { status: s }) as unknown as Response;
    expect(c.normalizeError(mk(400)).code).toBe("provider_error");
    expect(c.normalizeError(mk(401)).code).toBe("auth_expired");
    expect(c.normalizeError(mk(403)).code).toBe("permission_denied");
    expect(c.normalizeError(mk(404)).code).toBe("not_found");
    expect(c.normalizeError(mk(429)).code).toBe("rate_limited");
    expect(c.normalizeError(mk(429)).retryable).toBe(true);
    expect(c.normalizeError(mk(500)).code).toBe("provider_error");
    expect(c.normalizeError(mk(500)).retryable).toBe(true);
    expect(c.normalizeError(mk(502)).retryable).toBe(true);
  });

  it("400 is not retryable", async () => {
    const { WebflowConnector } = await import("../webflow.js");
    const c = new WebflowConnector();
    const r = c.normalizeError(
      new Response(null, { status: 400 }) as unknown as Response,
    );
    expect(r.retryable).toBe(false);
  });

  it("detects ENOTFOUND/ECONNREFUSED as network_error", async () => {
    const { WebflowConnector } = await import("../webflow.js");
    const c = new WebflowConnector();
    expect(
      c.normalizeError(new Error("getaddrinfo ENOTFOUND api.webflow.com")).code,
    ).toBe("network_error");
    expect(c.normalizeError(new Error("ECONNREFUSED")).code).toBe(
      "network_error",
    );
  });

  it("defaults to provider_error", async () => {
    const { WebflowConnector } = await import("../webflow.js");
    const c = new WebflowConnector();
    expect(c.normalizeError(new Error("boom")).code).toBe("provider_error");
    expect(c.normalizeError("plain string").code).toBe("provider_error");
  });
});

// ── handleWebflowConnect ────────────────────────────────────────────────────

describe("handleWebflowConnect", () => {
  it("rejects invalid JSON", async () => {
    const { handleWebflowConnect } = await import("../webflow.js");
    const r = await handleWebflowConnect("not json");
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid JSON/);
  });

  it("requires accessToken", async () => {
    const { handleWebflowConnect } = await import("../webflow.js");
    const r = await handleWebflowConnect(JSON.stringify({}));
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/accessToken/);
  });

  it("captures first site id + displayName + sends accept-version header", async () => {
    const { handleWebflowConnect, loadTokens } = await import("../webflow.js");
    const fetchMock = mockFetch(() => ({
      status: 200,
      body: {
        sites: [
          { id: "site_abc", displayName: "My Portfolio" },
          { id: "site_def", displayName: "Other" },
        ],
      },
    }));
    try {
      const r = await handleWebflowConnect(
        JSON.stringify({ accessToken: "tok_123" }),
      );
      expect(r.status).toBe(200);
      const parsed = JSON.parse(r.body) as {
        siteId?: string;
        siteName?: string;
      };
      expect(parsed.siteId).toBe("site_abc");
      expect(parsed.siteName).toBe("My Portfolio");
      const headers = (fetchMock.calls[0]?.init?.headers ?? {}) as Record<
        string,
        string
      >;
      expect(headers.Authorization).toBe("Bearer tok_123");
      expect(headers["accept-version"]).toBe("2.0.0");
      const tokens = loadTokens();
      expect(tokens?.siteId).toBe("site_abc");
      expect(tokens?.siteName).toBe("My Portfolio");
    } finally {
      fetchMock.restore();
    }
  });

  it("returns 401 on auth failure + does not store tokens", async () => {
    const { handleWebflowConnect, loadTokens } = await import("../webflow.js");
    const fetchMock = mockFetch(() => ({ status: 401, body: {} }));
    try {
      const r = await handleWebflowConnect(
        JSON.stringify({ accessToken: "bad" }),
      );
      expect(r.status).toBe(401);
      expect(loadTokens()).toBeNull();
    } finally {
      fetchMock.restore();
    }
  });
});

// ── API methods ─────────────────────────────────────────────────────────────

describe("listCollectionItems", () => {
  it("caps limit at 100 even when caller passes higher", async () => {
    const { getWebflowConnector, saveTokens } = await import("../webflow.js");
    saveTokens({
      accessToken: "tok_xyz",
      connected_at: new Date().toISOString(),
    });
    const fetchMock = mockFetch(() => ({
      status: 200,
      body: { items: [], pagination: { limit: 100, offset: 0, total: 0 } },
    }));
    try {
      const c = getWebflowConnector();
      await c.listCollectionItems("col_1", { limit: 500 });
      const url = fetchMock.calls[0]!.url;
      expect(url).toContain("limit=100");
      expect(url).not.toContain("limit=500");
    } finally {
      fetchMock.restore();
    }
  });

  it("passes through offset + default limit 100 when none given", async () => {
    const { getWebflowConnector, saveTokens } = await import("../webflow.js");
    saveTokens({
      accessToken: "tok_xyz",
      connected_at: new Date().toISOString(),
    });
    const fetchMock = mockFetch(() => ({
      status: 200,
      body: { items: [{ id: "item_1" }], pagination: {} },
    }));
    try {
      const c = getWebflowConnector();
      const r = await c.listCollectionItems("col_1", { offset: 200 });
      expect(r.items).toHaveLength(1);
      const url = fetchMock.calls[0]!.url;
      expect(url).toContain("limit=100");
      expect(url).toContain("offset=200");
    } finally {
      fetchMock.restore();
    }
  });

  it("always sets accept-version: 2.0.0 header", async () => {
    const { getWebflowConnector, saveTokens } = await import("../webflow.js");
    saveTokens({
      accessToken: "tok_xyz",
      connected_at: new Date().toISOString(),
    });
    const fetchMock = mockFetch(() => ({
      status: 200,
      body: { items: [] },
    }));
    try {
      const c = getWebflowConnector();
      await c.listCollectionItems("col_1");
      const headers = (fetchMock.calls[0]?.init?.headers ?? {}) as Record<
        string,
        string
      >;
      expect(headers["accept-version"]).toBe("2.0.0");
      expect(headers.Authorization).toBe("Bearer tok_xyz");
    } finally {
      fetchMock.restore();
    }
  });
});

describe("listFormSubmissions", () => {
  it("caps limit at 100", async () => {
    const { getWebflowConnector, saveTokens } = await import("../webflow.js");
    saveTokens({
      accessToken: "tok_xyz",
      connected_at: new Date().toISOString(),
    });
    const fetchMock = mockFetch(() => ({
      status: 200,
      body: { formSubmissions: [], pagination: {} },
    }));
    try {
      const c = getWebflowConnector();
      await c.listFormSubmissions("form_1", { limit: 9999 });
      const url = fetchMock.calls[0]!.url;
      expect(url).toContain("limit=100");
    } finally {
      fetchMock.restore();
    }
  });
});

describe("listSites / listCollections / listForms", () => {
  it("unwraps Webflow's named array fields into items[]", async () => {
    const { getWebflowConnector, saveTokens } = await import("../webflow.js");
    saveTokens({
      accessToken: "tok_xyz",
      connected_at: new Date().toISOString(),
    });
    const fetchMock = mockFetch(({ url }) => {
      if (url.endsWith("/sites")) {
        return { status: 200, body: { sites: [{ id: "s1" }, { id: "s2" }] } };
      }
      if (url.endsWith("/collections")) {
        return { status: 200, body: { collections: [{ id: "c1" }] } };
      }
      if (url.endsWith("/forms")) {
        return {
          status: 200,
          body: { forms: [{ id: "f1" }, { id: "f2" }, { id: "f3" }] },
        };
      }
      return { status: 404, body: {} };
    });
    try {
      const c = getWebflowConnector();
      expect((await c.listSites()).items).toHaveLength(2);
      expect((await c.listCollections("s1")).items).toHaveLength(1);
      expect((await c.listForms("s1")).items).toHaveLength(3);
    } finally {
      fetchMock.restore();
    }
  });
});

// ── healthCheck ─────────────────────────────────────────────────────────────

describe("healthCheck", () => {
  it("returns ok:true on 200", async () => {
    const { getWebflowConnector, saveTokens } = await import("../webflow.js");
    saveTokens({
      accessToken: "tok_xyz",
      connected_at: new Date().toISOString(),
    });
    const fetchMock = mockFetch(() => ({ status: 200, body: { id: "u1" } }));
    try {
      const c = getWebflowConnector();
      const r = await c.healthCheck();
      expect(r.ok).toBe(true);
      expect(fetchMock.calls[0]!.url).toContain("/token/authorized_by");
    } finally {
      fetchMock.restore();
    }
  });

  it("returns auth_expired on 401", async () => {
    const { getWebflowConnector, saveTokens } = await import("../webflow.js");
    saveTokens({
      accessToken: "tok_xyz",
      connected_at: new Date().toISOString(),
    });
    const fetchMock = mockFetch(() => ({ status: 401, body: {} }));
    try {
      const c = getWebflowConnector();
      const r = await c.healthCheck();
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("auth_expired");
    } finally {
      fetchMock.restore();
    }
  });
});

// ── env var override ────────────────────────────────────────────────────────

describe("env var override", () => {
  it("WEBFLOW_API_TOKEN populates loadTokens()", async () => {
    process.env.WEBFLOW_API_TOKEN = "env_tok";
    process.env.WEBFLOW_SITE_ID = "env_site";
    const { loadTokens } = await import("../webflow.js");
    const tokens = loadTokens();
    expect(tokens?.accessToken).toBe("env_tok");
    expect(tokens?.siteId).toBe("env_site");
  });
});

// ── getStatus ───────────────────────────────────────────────────────────────

describe("getStatus", () => {
  it("disconnected when no tokens", async () => {
    const { getWebflowConnector } = await import("../webflow.js");
    const c = getWebflowConnector();
    expect(c.getStatus().status).toBe("disconnected");
  });

  it("connected + workspace label when tokens present", async () => {
    const { getWebflowConnector, saveTokens } = await import("../webflow.js");
    saveTokens({
      accessToken: "t",
      siteId: "s1",
      siteName: "Portfolio",
      connected_at: new Date().toISOString(),
    });
    const s = getWebflowConnector().getStatus();
    expect(s.status).toBe("connected");
    expect(s.workspace).toMatch(/Portfolio/);
  });
});

// ── disconnect ──────────────────────────────────────────────────────────────

describe("handleWebflowDisconnect", () => {
  it("clears tokens", async () => {
    const { handleWebflowDisconnect, saveTokens, loadTokens } = await import(
      "../webflow.js"
    );
    saveTokens({ accessToken: "t", connected_at: new Date().toISOString() });
    expect(loadTokens()).not.toBeNull();
    const r = handleWebflowDisconnect();
    expect(r.status).toBe(200);
    expect(loadTokens()).toBeNull();
  });
});
