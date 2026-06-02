import crypto from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeFakeTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "task1",
    content: "Buy milk",
    description: "",
    project_id: "proj1",
    section_id: null,
    parent_id: null,
    order: 1,
    priority: 1,
    due: null,
    labels: [],
    is_completed: false,
    created_at: "2026-01-01T00:00:00Z",
    url: "https://todoist.com/task/task1",
    comment_count: 0,
    creator_id: "user1",
    ...overrides,
  };
}

function mockFetch(
  ok: boolean,
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
) {
  return vi.fn().mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
    headers: { get: (k: string) => headers[k] ?? null },
  }) as unknown as typeof fetch;
}

// ── token helpers ─────────────────────────────────────────────────────────────

describe("todoist token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-todoist-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.TODOIST_API_KEY;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns env var without reading storage", async () => {
    process.env.TODOIST_API_KEY = "tok-abc123";
    const { loadTokens } = await import("../todoist.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.apiToken).toBe("tok-abc123");
  });

  it("loadTokens returns null when no env and no stored token", async () => {
    const { loadTokens } = await import("../todoist.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../todoist.js");
    const tokens = {
      apiToken: "mytoken",
      email: "user@example.com",
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      apiToken: "mytoken",
      email: "user@example.com",
    });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../todoist.js");
    expect(() => clearTokens()).not.toThrow();
  });
});

// ── TodoistConnector.getTasks ─────────────────────────────────────────────────

describe("TodoistConnector.getTasks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TODOIST_API_KEY;
    vi.resetModules();
  });

  it("returns tasks array on success", async () => {
    process.env.TODOIST_API_KEY = "test-token";
    const tasks = [
      makeFakeTask(),
      makeFakeTask({ id: "task2", content: "Walk dog" }),
    ];

    global.fetch = mockFetch(true, 200, tasks);

    vi.resetModules();
    const { TodoistConnector } = await import("../todoist.js");
    const conn = new TodoistConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "test-token" });

    const result = await conn.getTasks();
    expect(result).toHaveLength(2);
    expect(result[0]!.content).toBe("Buy milk");
  });

  it("passes projectId as query param", async () => {
    process.env.TODOIST_API_KEY = "test-token";
    global.fetch = mockFetch(true, 200, [makeFakeTask()]);

    vi.resetModules();
    const { TodoistConnector } = await import("../todoist.js");
    const conn = new TodoistConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "test-token" });

    await conn.getTasks("proj99");
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(url).toContain("project_id=proj99");
  });

  it("throws on 401", async () => {
    process.env.TODOIST_API_KEY = "bad-token";
    global.fetch = mockFetch(false, 401);

    vi.resetModules();
    const { TodoistConnector } = await import("../todoist.js");
    const conn = new TodoistConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "bad-token" });

    await expect(conn.getTasks()).rejects.toThrow();
  });
});

// ── TodoistConnector.createTask ───────────────────────────────────────────────

describe("TodoistConnector.createTask", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TODOIST_API_KEY;
    vi.resetModules();
  });

  it("POSTs to /tasks and returns created task", async () => {
    process.env.TODOIST_API_KEY = "test-token";
    const created = makeFakeTask({ content: "New task", priority: 2 });
    global.fetch = mockFetch(true, 200, created);

    vi.resetModules();
    const { TodoistConnector } = await import("../todoist.js");
    const conn = new TodoistConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "test-token" });

    const result = await conn.createTask(
      "New task",
      undefined,
      undefined,
      undefined,
      2,
    );
    expect(result.content).toBe("New task");
    expect(result.priority).toBe(2);

    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toContain("/tasks");
    expect(call?.[1]?.method).toBe("POST");
  });

  it("includes optional fields in body", async () => {
    process.env.TODOIST_API_KEY = "test-token";
    global.fetch = mockFetch(true, 200, makeFakeTask());

    vi.resetModules();
    const { TodoistConnector } = await import("../todoist.js");
    const conn = new TodoistConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "test-token" });

    await conn.createTask("Task", "proj1", "desc", "tomorrow", 3, ["work"]);
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body.project_id).toBe("proj1");
    expect(body.description).toBe("desc");
    expect(body.due_string).toBe("tomorrow");
    expect(body.labels).toEqual(["work"]);
  });
});

// ── TodoistConnector.closeTask ────────────────────────────────────────────────

describe("TodoistConnector.closeTask", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TODOIST_API_KEY;
    vi.resetModules();
  });

  it("POSTs to /tasks/{id}/close and resolves without error", async () => {
    process.env.TODOIST_API_KEY = "test-token";
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => null,
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { TodoistConnector } = await import("../todoist.js");
    const conn = new TodoistConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "test-token" });

    await expect(conn.closeTask("task1")).resolves.toBeUndefined();
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(url).toContain("/tasks/task1/close");
  });

  it("throws when API returns 404", async () => {
    process.env.TODOIST_API_KEY = "test-token";
    global.fetch = mockFetch(false, 404);

    vi.resetModules();
    const { TodoistConnector } = await import("../todoist.js");
    const conn = new TodoistConnector();
    vi.spyOn(
      conn as unknown as { authenticate: () => Promise<{ token: string }> },
      "authenticate",
    ).mockResolvedValue({ token: "test-token" });

    await expect(conn.closeTask("nonexistent")).rejects.toThrow();
  });
});

// ── verifyTodoistWebhook ──────────────────────────────────────────────────────

describe("verifyTodoistWebhook", () => {
  it("returns true for a valid signature", async () => {
    vi.resetModules();
    const { verifyTodoistWebhook } = await import("../todoist.js");

    const secret = "my-client-secret";
    const body = JSON.stringify({ event_name: "item:added", user_id: "123" });
    const validSig = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("base64");

    expect(verifyTodoistWebhook(body, validSig, secret)).toBe(true);
  });

  it("returns false for a tampered signature", async () => {
    vi.resetModules();
    const { verifyTodoistWebhook } = await import("../todoist.js");

    const secret = "my-client-secret";
    const body = JSON.stringify({ event_name: "item:added" });
    const tamperedSig = Buffer.from("tampered-signature").toString("base64");

    expect(verifyTodoistWebhook(body, tamperedSig, secret)).toBe(false);
  });

  it("returns false when signature has different length", async () => {
    vi.resetModules();
    const { verifyTodoistWebhook } = await import("../todoist.js");

    const secret = "my-client-secret";
    const body = "payload";
    expect(verifyTodoistWebhook(body, "tooshort", secret)).toBe(false);
  });

  it("works with Buffer rawBody", async () => {
    vi.resetModules();
    const { verifyTodoistWebhook } = await import("../todoist.js");

    const secret = "webhook-secret";
    const body = Buffer.from('{"event":"test"}');
    const validSig = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("base64");

    expect(verifyTodoistWebhook(body, validSig, secret)).toBe(true);
  });
});

// ── handleTodoistConnect ──────────────────────────────────────────────────────

describe("handleTodoistConnect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TODOIST_API_KEY;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  });

  it("returns 400 when apiToken missing", async () => {
    vi.resetModules();
    const { handleTodoistConnect } = await import("../todoist.js");
    const result = await handleTodoistConnect(JSON.stringify({}));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 on invalid JSON", async () => {
    vi.resetModules();
    const { handleTodoistConnect } = await import("../todoist.js");
    const result = await handleTodoistConnect("not-json");
    expect(result.status).toBe(400);
  });

  it("returns 401 when Todoist rejects token", async () => {
    global.fetch = mockFetch(false, 401);

    vi.resetModules();
    const { handleTodoistConnect } = await import("../todoist.js");
    const result = await handleTodoistConnect(
      JSON.stringify({ apiToken: "bad-token" }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 and stores tokens on success", async () => {
    const tmpDir2 = join(
      os.tmpdir(),
      `patchwork-todoist-connect-${Date.now()}`,
    );
    const pHome = join(tmpDir2, ".patchwork");
    mkdirSync(join(pHome, "tokens"), { recursive: true });
    process.env.PATCHWORK_HOME = pHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    global.fetch = mockFetch(true, 200, []);

    vi.resetModules();
    const { handleTodoistConnect, loadTokens } = await import("../todoist.js");
    const result = await handleTodoistConnect(
      JSON.stringify({ apiToken: "good-token" }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as {
      ok: boolean;
      connectedAt: string;
    };
    expect(body.ok).toBe(true);
    expect(body.connectedAt).toBeTruthy();

    const stored = loadTokens();
    expect(stored?.apiToken).toBe("good-token");

    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

// ── handleTodoistTest ─────────────────────────────────────────────────────────

describe("handleTodoistTest", () => {
  it("returns 400 when not connected", async () => {
    vi.resetModules();
    const { handleTodoistTest } = await import("../todoist.js");
    const result = await handleTodoistTest();
    expect(result.status).toBe(400);
  });
});

// ── handleTodoistDisconnect ───────────────────────────────────────────────────

describe("handleTodoistDisconnect", () => {
  it("returns 200 always", async () => {
    vi.resetModules();
    const { handleTodoistDisconnect } = await import("../todoist.js");
    const result = handleTodoistDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});

// ── normalizeError ────────────────────────────────────────────────────────────

describe("TodoistConnector.normalizeError", () => {
  it("maps 401 → auth_expired", async () => {
    vi.resetModules();
    const { TodoistConnector } = await import("../todoist.js");
    const conn = new TodoistConnector();
    const err = conn.normalizeError({ status: 401 });
    expect(err.code).toBe("auth_expired");
    expect(err.retryable).toBe(false);
  });

  it("maps 429 → rate_limited", async () => {
    vi.resetModules();
    const { TodoistConnector } = await import("../todoist.js");
    const conn = new TodoistConnector();
    const err = conn.normalizeError({ status: 429 });
    expect(err.code).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });

  it("maps 403 → permission_denied", async () => {
    vi.resetModules();
    const { TodoistConnector } = await import("../todoist.js");
    const conn = new TodoistConnector();
    const err = conn.normalizeError({ status: 403 });
    expect(err.code).toBe("permission_denied");
  });

  it("maps 404 → not_found", async () => {
    vi.resetModules();
    const { TodoistConnector } = await import("../todoist.js");
    const conn = new TodoistConnector();
    const err = conn.normalizeError({ status: 404 });
    expect(err.code).toBe("not_found");
  });

  it("maps network errors → network_error", async () => {
    vi.resetModules();
    const { TodoistConnector } = await import("../todoist.js");
    const conn = new TodoistConnector();
    const err = conn.normalizeError(new Error("ENOTFOUND api.todoist.com"));
    expect(err.code).toBe("network_error");
    expect(err.retryable).toBe(true);
  });
});
