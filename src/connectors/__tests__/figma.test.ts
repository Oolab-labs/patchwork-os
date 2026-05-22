import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Test harness ────────────────────────────────────────────────────────────

const tmpDir = join(os.tmpdir(), `patchwork-figma-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  });
  // biome-ignore lint/suspicious/noExplicitAny: test seam
  globalThis.fetch = fn as any;
  return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  delete process.env.FIGMA_ACCESS_TOKEN;
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.FIGMA_ACCESS_TOKEN;
  globalThis.fetch = originalFetch;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── normalizeError ──────────────────────────────────────────────────────────

describe("normalizeError", () => {
  it("maps 401 to auth_expired", async () => {
    const { FigmaConnector } = await import("../figma.js");
    const c = new FigmaConnector();
    const res = new Response("", { status: 401 });
    const err = c.normalizeError(res);
    expect(err.code).toBe("auth_expired");
    expect(err.retryable).toBe(false);
  });

  it("maps 403 to auth_expired (Figma quirk)", async () => {
    const { FigmaConnector } = await import("../figma.js");
    const c = new FigmaConnector();
    const res = new Response("", { status: 403 });
    const err = c.normalizeError(res);
    expect(err.code).toBe("auth_expired");
    expect(err.retryable).toBe(false);
  });

  it("maps 404 to not_found", async () => {
    const { FigmaConnector } = await import("../figma.js");
    const c = new FigmaConnector();
    expect(c.normalizeError(new Response("", { status: 404 })).code).toBe(
      "not_found",
    );
  });

  it("maps 429 to rate_limited (retryable)", async () => {
    const { FigmaConnector } = await import("../figma.js");
    const c = new FigmaConnector();
    const err = c.normalizeError(new Response("", { status: 429 }));
    expect(err.code).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });

  it("maps 5xx to provider_error retryable", async () => {
    const { FigmaConnector } = await import("../figma.js");
    const c = new FigmaConnector();
    const err = c.normalizeError(new Response("", { status: 503 }));
    expect(err.code).toBe("provider_error");
    expect(err.retryable).toBe(true);
  });

  it("maps non-retryable 4xx other to provider_error", async () => {
    const { FigmaConnector } = await import("../figma.js");
    const c = new FigmaConnector();
    const err = c.normalizeError(new Response("", { status: 418 }));
    expect(err.code).toBe("provider_error");
    expect(err.retryable).toBe(false);
  });

  it("detects ENOTFOUND/ECONNREFUSED as network_error", async () => {
    const { FigmaConnector } = await import("../figma.js");
    const c = new FigmaConnector();
    expect(
      c.normalizeError(new Error("getaddrinfo ENOTFOUND api.figma.com")).code,
    ).toBe("network_error");
    expect(c.normalizeError(new Error("connect ECONNREFUSED")).code).toBe(
      "network_error",
    );
  });

  it("defaults to provider_error for unknown errors", async () => {
    const { FigmaConnector } = await import("../figma.js");
    const c = new FigmaConnector();
    expect(c.normalizeError(new Error("boom")).code).toBe("provider_error");
    expect(c.normalizeError("something").code).toBe("provider_error");
  });
});

// ── getFile depth param ─────────────────────────────────────────────────────

describe("getFile", () => {
  it("applies default depth=2 query param", async () => {
    process.env.FIGMA_ACCESS_TOKEN = "figd_test";
    const fetchSpy = mockFetch(() =>
      jsonResponse({
        name: "f",
        lastModified: "x",
        version: "1",
        document: {},
      }),
    );
    const { getFigmaConnector } = await import("../figma.js");
    const c = getFigmaConnector();
    await c.getFile("ABC123");
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("/v1/files/ABC123");
    expect(url).toContain("depth=2");
  });

  it("respects explicit depth and geometry", async () => {
    process.env.FIGMA_ACCESS_TOKEN = "figd_test";
    const fetchSpy = mockFetch(() =>
      jsonResponse({
        name: "f",
        lastModified: "x",
        version: "1",
        document: {},
      }),
    );
    const { getFigmaConnector } = await import("../figma.js");
    const c = getFigmaConnector();
    await c.getFile("KEY", { depth: 5, geometry: "paths" });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("depth=5");
    expect(url).toContain("geometry=paths");
  });

  it("rejects empty fileKey", async () => {
    const { getFigmaConnector } = await import("../figma.js");
    process.env.FIGMA_ACCESS_TOKEN = "figd_test";
    const c = getFigmaConnector();
    await expect(c.getFile("")).rejects.toThrow(/fileKey/);
  });
});

// ── getImageUrls validation ─────────────────────────────────────────────────

describe("getImageUrls", () => {
  it("rejects empty ids array", async () => {
    process.env.FIGMA_ACCESS_TOKEN = "figd_test";
    const { getFigmaConnector } = await import("../figma.js");
    const c = getFigmaConnector();
    await expect(c.getImageUrls("KEY", { ids: [] })).rejects.toThrow(
      /non-empty/,
    );
  });

  it("rejects invalid format", async () => {
    process.env.FIGMA_ACCESS_TOKEN = "figd_test";
    const { getFigmaConnector } = await import("../figma.js");
    const c = getFigmaConnector();
    await expect(
      // @ts-expect-error — testing runtime guard
      c.getImageUrls("KEY", { ids: ["1:2"], format: "gif" }),
    ).rejects.toThrow(/Invalid format/);
  });

  it("accepts png, jpg, svg, pdf", async () => {
    process.env.FIGMA_ACCESS_TOKEN = "figd_test";
    const fetchSpy = mockFetch(() =>
      jsonResponse({ err: null, images: { "1:2": "https://s3/x" } }),
    );
    const { getFigmaConnector } = await import("../figma.js");
    const c = getFigmaConnector();
    for (const format of ["png", "jpg", "svg", "pdf"] as const) {
      await c.getImageUrls("KEY", { ids: ["1:2"], format });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const urls = fetchSpy.mock.calls.map((call) => call[0] as string);
    expect(urls[0]).toContain("format=png");
    expect(urls[1]).toContain("format=jpg");
    expect(urls[2]).toContain("format=svg");
    expect(urls[3]).toContain("format=pdf");
  });

  it("joins ids with comma and applies scale", async () => {
    process.env.FIGMA_ACCESS_TOKEN = "figd_test";
    const fetchSpy = mockFetch(() => jsonResponse({ err: null, images: {} }));
    const { getFigmaConnector } = await import("../figma.js");
    const c = getFigmaConnector();
    await c.getImageUrls("KEY", { ids: ["1:2", "3:4"], scale: 2 });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("ids=1%3A2%2C3%3A4");
    expect(url).toContain("scale=2");
  });
});

// ── getFileNodes ────────────────────────────────────────────────────────────

describe("getFileNodes", () => {
  it("rejects empty nodeIds", async () => {
    process.env.FIGMA_ACCESS_TOKEN = "figd_test";
    const { getFigmaConnector } = await import("../figma.js");
    const c = getFigmaConnector();
    await expect(c.getFileNodes("KEY", [])).rejects.toThrow(/non-empty/);
  });

  it("joins ids in query string", async () => {
    process.env.FIGMA_ACCESS_TOKEN = "figd_test";
    const fetchSpy = mockFetch(() =>
      jsonResponse({ name: "f", lastModified: "x", version: "1", nodes: {} }),
    );
    const { getFigmaConnector } = await import("../figma.js");
    const c = getFigmaConnector();
    await c.getFileNodes("KEY", ["1:2", "3:4"]);
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("/nodes?");
    expect(url).toContain("ids=1%3A2%2C3%3A4");
  });
});

// ── Auth header ─────────────────────────────────────────────────────────────

describe("X-Figma-Token header", () => {
  it("sends the token from FIGMA_ACCESS_TOKEN env", async () => {
    process.env.FIGMA_ACCESS_TOKEN = "figd_abcdef";
    const fetchSpy = mockFetch(() =>
      jsonResponse({ id: "u1", handle: "alice" }),
    );
    const { getFigmaConnector } = await import("../figma.js");
    const c = getFigmaConnector();
    await c.getMe();
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Figma-Token"]).toBe("figd_abcdef");
  });
});

// ── HTTP connect handler ────────────────────────────────────────────────────

describe("handleFigmaConnect", () => {
  it("rejects invalid JSON", async () => {
    const { handleFigmaConnect } = await import("../figma.js");
    const r = await handleFigmaConnect("not json");
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid JSON/);
  });

  it("requires accessToken", async () => {
    const { handleFigmaConnect } = await import("../figma.js");
    const r = await handleFigmaConnect(JSON.stringify({}));
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/accessToken/);
  });

  it("validates via /v1/me + stores tokens", async () => {
    mockFetch(() =>
      jsonResponse({ id: "u1", handle: "alice", email: "a@x.io" }),
    );
    const { handleFigmaConnect, loadTokens } = await import("../figma.js");
    const r = await handleFigmaConnect(
      JSON.stringify({ accessToken: "figd_xyz" }),
    );
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.userHandle).toBe("alice");
    expect(parsed.email).toBe("a@x.io");
    const tokens = loadTokens();
    expect(tokens?.userHandle).toBe("alice");
    expect(tokens?.accessToken).toBe("figd_xyz");
  });

  it("returns 401 on auth failure without storing tokens", async () => {
    mockFetch(() => new Response("forbidden", { status: 403 }));
    const { handleFigmaConnect, loadTokens } = await import("../figma.js");
    const r = await handleFigmaConnect(
      JSON.stringify({ accessToken: "figd_bad" }),
    );
    expect(r.status).toBe(401);
    expect(loadTokens()).toBeNull();
  });
});

// ── Disconnect ──────────────────────────────────────────────────────────────

describe("handleFigmaDisconnect", () => {
  it("clears stored tokens", async () => {
    const { handleFigmaDisconnect, saveTokens, loadTokens } = await import(
      "../figma.js"
    );
    saveTokens({
      accessToken: "figd_x",
      connected_at: new Date().toISOString(),
    });
    expect(loadTokens()).not.toBeNull();
    const r = handleFigmaDisconnect();
    expect(r.status).toBe(200);
    expect(loadTokens()).toBeNull();
  });
});

// ── getStatus ───────────────────────────────────────────────────────────────

describe("getStatus", () => {
  it("reports disconnected when no tokens", async () => {
    const { getFigmaConnector } = await import("../figma.js");
    const c = getFigmaConnector();
    const status = c.getStatus();
    expect(status.status).toBe("disconnected");
  });

  it("reports connected with handle from stored tokens", async () => {
    const { getFigmaConnector, saveTokens } = await import("../figma.js");
    saveTokens({
      accessToken: "figd_stored",
      userHandle: "bob",
      connected_at: new Date().toISOString(),
    });
    const c = getFigmaConnector();
    const status = c.getStatus();
    expect(status.status).toBe("connected");
    expect(status.workspace).toContain("bob");
  });
});
