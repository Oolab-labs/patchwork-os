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

const tmpDir = join(os.tmpdir(), `patchwork-circleci-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  delete process.env.CIRCLECI_API_TOKEN;
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.CIRCLECI_API_TOKEN;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── normalizeError ─────────────────────────────────────────────────────────

describe("normalizeError", () => {
  it("maps HTTP status codes from Response", async () => {
    const { CircleCIConnector } = await import("../circleci.js");
    const c = new CircleCIConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(401)).code).toBe("auth_expired");
    expect(c.normalizeError(make(403)).code).toBe("permission_denied");
    expect(c.normalizeError(make(404)).code).toBe("not_found");
    expect(c.normalizeError(make(429)).code).toBe("rate_limited");
    expect(c.normalizeError(make(500)).code).toBe("provider_error");
  });

  it("marks 429 + 5xx retryable; 4xx non-retryable", async () => {
    const { CircleCIConnector } = await import("../circleci.js");
    const c = new CircleCIConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(429)).retryable).toBe(true);
    expect(c.normalizeError(make(503)).retryable).toBe(true);
    expect(c.normalizeError(make(401)).retryable).toBe(false);
    expect(c.normalizeError(make(403)).retryable).toBe(false);
    expect(c.normalizeError(make(404)).retryable).toBe(false);
  });

  it("handles network errors", async () => {
    const { CircleCIConnector } = await import("../circleci.js");
    const c = new CircleCIConnector();
    const err = c.normalizeError(new Error("ENOTFOUND circleci.com"));
    expect(err.code).toBe("network_error");
    expect(err.retryable).toBe(true);
  });
});

// ── loadTokens / env var ──────────────────────────────────────────────────

describe("loadTokens", () => {
  it("reads from env var when set", async () => {
    process.env.CIRCLECI_API_TOKEN = "test-token-from-env";
    const { loadTokens } = await import("../circleci.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens?.apiToken).toBe("test-token-from-env");
  });

  it("returns null when not connected", async () => {
    const { loadTokens } = await import("../circleci.js");
    expect(loadTokens()).toBeNull();
  });
});

// ── getStatus ─────────────────────────────────────────────────────────────

describe("getStatus", () => {
  it("returns disconnected when no tokens", async () => {
    const { CircleCIConnector } = await import("../circleci.js");
    const c = new CircleCIConnector();
    expect(c.getStatus().status).toBe("disconnected");
  });

  it("returns connected with login when tokens present", async () => {
    process.env.CIRCLECI_API_TOKEN = "tok";
    const { loadTokens, saveTokens } = await import("../circleci.js");
    const tokens = loadTokens()!;
    tokens.login = "johndoe";
    saveTokens(tokens);
    // reload so singleton picks up file-stored tokens
    vi.resetModules();
    const { CircleCIConnector: C2 } = await import("../circleci.js");
    delete process.env.CIRCLECI_API_TOKEN;
    const c = new C2();
    const s = c.getStatus();
    expect(s.status).toBe("connected");
    expect(s.workspace).toBe("CircleCI: johndoe");
  });
});

// ── triggerPipeline ────────────────────────────────────────────────────────

describe("triggerPipeline", () => {
  it("POSTs to the correct URL with branch", async () => {
    process.env.CIRCLECI_API_TOKEN = "mytoken";
    const triggerResult = {
      id: "pipe-123",
      state: "pending",
      number: 42,
      created_at: "2024-01-01T00:00:00Z",
    };
    const { calls } = installFetchMock((url) => {
      if (url.includes("/me")) return jsonResponse({ login: "user" });
      return jsonResponse(triggerResult);
    });

    const { CircleCIConnector } = await import("../circleci.js");
    const c = new CircleCIConnector();
    const result = await c.triggerPipeline("gh/owner/repo", {
      branch: "main",
    });

    expect(result.id).toBe("pipe-123");
    expect(result.number).toBe(42);
    const postCall = calls.find(
      (c) => c.url.includes("/pipeline") && c.init?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect(postCall?.url).toContain("gh/owner/repo/pipeline");
    const body = JSON.parse(postCall?.init?.body as string);
    expect(body.branch).toBe("main");
  });

  it("normalises github/ prefix to gh/", async () => {
    process.env.CIRCLECI_API_TOKEN = "mytoken";
    installFetchMock(() =>
      jsonResponse({
        id: "x",
        state: "pending",
        number: 1,
        created_at: "2024-01-01T00:00:00Z",
      }),
    );

    const { CircleCIConnector } = await import("../circleci.js");
    const c = new CircleCIConnector();
    // Should not throw; URL will have gh/ not github/
    await c.triggerPipeline("github/owner/repo", { branch: "main" });
  });

  it("includes pipeline parameters when provided", async () => {
    process.env.CIRCLECI_API_TOKEN = "mytoken";
    const { calls } = installFetchMock(() =>
      jsonResponse({
        id: "x",
        state: "pending",
        number: 1,
        created_at: "2024-01-01T00:00:00Z",
      }),
    );

    const { CircleCIConnector } = await import("../circleci.js");
    const c = new CircleCIConnector();
    await c.triggerPipeline("gh/owner/repo", {
      parameters: { run_integration: true, env: "staging" },
    });

    const postCall = calls.find(
      (c) => c.url.includes("/pipeline") && c.init?.method === "POST",
    );
    const body = JSON.parse(postCall?.init?.body as string);
    expect(body.parameters).toEqual({ run_integration: true, env: "staging" });
  });

  it("throws when not connected", async () => {
    const { CircleCIConnector } = await import("../circleci.js");
    const c = new CircleCIConnector();
    await expect(
      c.triggerPipeline("gh/owner/repo", { branch: "main" }),
    ).rejects.toThrow("not connected");
  });
});

// ── approveJob ─────────────────────────────────────────────────────────────

describe("approveJob", () => {
  it("POSTs to workflow approve endpoint", async () => {
    process.env.CIRCLECI_API_TOKEN = "mytoken";
    const { calls } = installFetchMock(
      () => new Response(null, { status: 202 }),
    );

    const { CircleCIConnector } = await import("../circleci.js");
    const c = new CircleCIConnector();
    await c.approveJob("wf-abc", "approval-req-xyz");

    const approveCall = calls.find((c) => c.init?.method === "POST");
    expect(approveCall?.url).toContain(
      "/workflow/wf-abc/approve/approval-req-xyz",
    );
  });

  it("throws on 403", async () => {
    process.env.CIRCLECI_API_TOKEN = "mytoken";
    installFetchMock(() => new Response(null, { status: 403 }));

    const { CircleCIConnector } = await import("../circleci.js");
    const c = new CircleCIConnector();
    await expect(c.approveJob("wf-abc", "req-xyz")).rejects.toThrow();
  });

  it("throws when not connected", async () => {
    const { CircleCIConnector } = await import("../circleci.js");
    const c = new CircleCIConnector();
    await expect(c.approveJob("wf-abc", "req-xyz")).rejects.toThrow(
      "not connected",
    );
  });
});

// ── createWebhook ──────────────────────────────────────────────────────────

describe("createWebhook", () => {
  it("POSTs correct body to /webhook", async () => {
    process.env.CIRCLECI_API_TOKEN = "mytoken";
    const webhookResult = {
      id: "wh-1",
      name: "my-hook",
      url: "https://example.com/hook",
      scope: { id: "proj-1", type: "project" },
      events: ["workflow-completed"],
      verify_tls: true,
      signing_secret: "secret123",
    };
    const { calls } = installFetchMock(() => jsonResponse(webhookResult));

    const { CircleCIConnector } = await import("../circleci.js");
    const c = new CircleCIConnector();
    const result = await c.createWebhook({
      name: "my-hook",
      events: ["workflow-completed"],
      url: "https://example.com/hook",
      scopeId: "proj-1",
      signingSecret: "secret123",
    });

    expect(result.id).toBe("wh-1");
    const postCall = calls.find((c) => c.init?.method === "POST");
    expect(postCall?.url).toContain("/webhook");
    const body = JSON.parse(postCall?.init?.body as string);
    expect(body.name).toBe("my-hook");
    expect(body.events).toEqual(["workflow-completed"]);
    expect(body.scope).toEqual({ id: "proj-1", type: "project" });
    expect(body.signing_secret).toBe("secret123");
    expect(body.verify_tls).toBe(true);
  });

  it("uses custom scopeType when provided", async () => {
    process.env.CIRCLECI_API_TOKEN = "mytoken";
    const { calls } = installFetchMock(() =>
      jsonResponse({
        id: "wh-2",
        name: "org-hook",
        url: "https://example.com/hook",
        scope: { id: "org-1", type: "organization" },
        events: ["workflow-completed"],
        verify_tls: false,
        signing_secret: "s",
      }),
    );

    const { CircleCIConnector } = await import("../circleci.js");
    const c = new CircleCIConnector();
    await c.createWebhook({
      name: "org-hook",
      events: ["workflow-completed"],
      url: "https://example.com/hook",
      scopeId: "org-1",
      scopeType: "organization",
      signingSecret: "s",
      verifyTls: false,
    });

    const postCall = calls.find((c) => c.init?.method === "POST");
    const body = JSON.parse(postCall?.init?.body as string);
    expect(body.scope.type).toBe("organization");
    expect(body.verify_tls).toBe(false);
  });
});

// ── verifyCircleCIWebhook ──────────────────────────────────────────────────

describe("verifyCircleCIWebhook", () => {
  it("returns true for a valid signature", async () => {
    const { verifyCircleCIWebhook } = await import("../circleci.js");
    const secret = "test-signing-secret";
    const body = '{"type":"workflow-completed"}';
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyCircleCIWebhook(body, `v1=${sig}`, secret)).toBe(true);
  });

  it("returns false for a tampered body", async () => {
    const { verifyCircleCIWebhook } = await import("../circleci.js");
    const secret = "test-signing-secret";
    const body = '{"type":"workflow-completed"}';
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    // Tamper: change the body
    expect(
      verifyCircleCIWebhook('{"type":"tampered"}', `v1=${sig}`, secret),
    ).toBe(false);
  });

  it("returns false for a tampered signature", async () => {
    const { verifyCircleCIWebhook } = await import("../circleci.js");
    const secret = "test-signing-secret";
    const body = '{"type":"workflow-completed"}';
    expect(verifyCircleCIWebhook(body, "v1=deadbeefdeadbeef", secret)).toBe(
      false,
    );
  });

  it("returns false for empty/missing signature", async () => {
    const { verifyCircleCIWebhook } = await import("../circleci.js");
    expect(verifyCircleCIWebhook("body", "", "secret")).toBe(false);
  });

  it("returns false for missing signing secret", async () => {
    const { verifyCircleCIWebhook } = await import("../circleci.js");
    expect(verifyCircleCIWebhook("body", "v1=abc", "")).toBe(false);
  });

  it("accepts comma-separated v1 header and picks the first", async () => {
    const { verifyCircleCIWebhook } = await import("../circleci.js");
    const secret = "s3cr3t";
    const body = Buffer.from("hello");
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    // Multi-entry header (comma-separated)
    expect(verifyCircleCIWebhook(body, `v1=${sig},v1=otherstuff`, secret)).toBe(
      true,
    );
  });

  it("works with Buffer bodies", async () => {
    const { verifyCircleCIWebhook } = await import("../circleci.js");
    const secret = "buf-secret";
    const body = Buffer.from('{"event":"job-completed"}');
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyCircleCIWebhook(body, `v1=${sig}`, secret)).toBe(true);
  });
});

// ── handleCircleCIConnect ─────────────────────────────────────────────────

describe("handleCircleCIConnect", () => {
  it("returns 400 for missing apiToken", async () => {
    const { handleCircleCIConnect } = await import("../circleci.js");
    const result = await handleCircleCIConnect(JSON.stringify({}));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 for invalid JSON", async () => {
    const { handleCircleCIConnect } = await import("../circleci.js");
    const result = await handleCircleCIConnect("not-json");
    expect(result.status).toBe(400);
  });

  it("returns 401 when CircleCI rejects the token", async () => {
    installFetchMock(() => new Response(null, { status: 401 }));
    const { handleCircleCIConnect } = await import("../circleci.js");
    const result = await handleCircleCIConnect(
      JSON.stringify({ apiToken: "bad-token" }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("stores tokens and returns 200 on success", async () => {
    installFetchMock(() =>
      jsonResponse({ login: "testuser", name: "Test User" }),
    );
    const { handleCircleCIConnect, loadTokens } = await import(
      "../circleci.js"
    );
    const result = await handleCircleCIConnect(
      JSON.stringify({ apiToken: "valid-token" }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.login).toBe("testuser");

    // Verify token was persisted
    const stored = loadTokens();
    expect(stored?.apiToken).toBe("valid-token");
    expect(stored?.login).toBe("testuser");
  });
});

// ── handleCircleCITest ─────────────────────────────────────────────────────

describe("handleCircleCITest", () => {
  it("returns 400 when not connected", async () => {
    const { handleCircleCITest } = await import("../circleci.js");
    const result = await handleCircleCITest();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 when health check passes", async () => {
    process.env.CIRCLECI_API_TOKEN = "valid-token";
    installFetchMock(() => jsonResponse({ login: "user" }));
    const { handleCircleCITest } = await import("../circleci.js");
    const result = await handleCircleCITest();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});

// ── handleCircleCIDisconnect ───────────────────────────────────────────────

describe("handleCircleCIDisconnect", () => {
  it("returns 200 and clears tokens", async () => {
    process.env.CIRCLECI_API_TOKEN = "tok";
    const { handleCircleCIDisconnect, loadTokens, saveTokens } = await import(
      "../circleci.js"
    );
    // Save a file-based token first
    saveTokens({
      apiToken: "stored-tok",
      connected_at: new Date().toISOString(),
    });
    delete process.env.CIRCLECI_API_TOKEN;

    const result = handleCircleCIDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
    expect(loadTokens()).toBeNull();
  });
});

// ── registry ──────────────────────────────────────────────────────────────

describe("connectorRegistry", () => {
  it("includes circleci as a PAT connector", async () => {
    const { CONNECTORS } = await import("../connectorRegistry.js");
    const entry = CONNECTORS.find((c) => c.id === "circleci");
    expect(entry).toBeDefined();
    expect(entry?.authKind).toBe("pat");
    expect(entry?.supports.connect).toBe(true);
    expect(entry?.supports.test).toBe(true);
    expect(entry?.supports.delete).toBe(true);
  });
});
