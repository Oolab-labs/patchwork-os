/**
 * Tests for audit 2026-06-03 LOW bugs #30, #33, #34, #35, #36
 * in src/recipeRoutes.ts.
 *
 * #30 — VARS_VALUE_RE allows ".." despite documented ban
 * #33 — readBodyWithCap 'data' listener not removed after too_large
 * #34 — PATCH /recipes/:name uses 256 KB cap for a boolean payload
 * #35 — Temp file orphaned when writeFileSync throws
 * #36 — GET /runs/:seq/plan: unsafe cast of run.recipeName crashes on undefined
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// (vi is used in afterEach via vi.restoreAllMocks)
import { Logger } from "../logger.js";
import { readBodyWithCap, validateRecipeVars } from "../recipeRoutes.js";
import { Server } from "../server.js";

// ---------------------------------------------------------------------------
// #30 — VARS_VALUE_RE: ".." must be rejected
// ---------------------------------------------------------------------------
describe("LOW #30 — validateRecipeVars rejects '..' (double-dot) values", () => {
  it("rejects a value that is exactly '..'", () => {
    const err = validateRecipeVars({ target: ".." });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("value");
    expect(err?.offendingKey).toBe("target");
  });

  it("rejects a value containing '..' as a path traversal segment", () => {
    const err = validateRecipeVars({ path: "foo/../bar" });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("value");
  });

  it("rejects '../etc' (double-dot at start)", () => {
    const err = validateRecipeVars({ key: "../etc" });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("value");
  });

  it("still accepts a single dot in a value (e.g. version '1.0.0')", () => {
    const err = validateRecipeVars({ version: "1.0.0" });
    expect(err).toBeNull();
  });

  it("still accepts a single trailing dot in a value", () => {
    // A single dot is allowed; only consecutive ".." is banned.
    const err = validateRecipeVars({ host: "example." });
    expect(err).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #33 — readBodyWithCap data listener not removed after too_large
// ---------------------------------------------------------------------------
class FakeReq extends EventEmitter {
  resume(): this {
    return this;
  }
}

describe("LOW #33 — readBodyWithCap removes 'data' listener after too_large", () => {
  it("has 0 data listeners on the stream after resolving too_large", async () => {
    const req = new FakeReq();
    const promise = readBodyWithCap(req as unknown as IncomingMessage, 4);

    // Emit chunks asynchronously after the helper attaches its listener.
    queueMicrotask(() => {
      // First chunk overflows — helper should resolve too_large and remove listener.
      req.emit("data", Buffer.from("12345678"));
      // Second chunk: if listener wasn't removed it would keep accumulating.
      req.emit("data", Buffer.from("morechunks"));
      req.emit("end");
    });

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("too_large");

    // After resolution the 'data' listener must have been removed.
    expect(req.listenerCount("data")).toBe(0);
  });

  it("data listener count stays 0 across repeated too_large calls on same stream", async () => {
    const req = new FakeReq();

    // First call — overflows
    const p1 = readBodyWithCap(req as unknown as IncomingMessage, 2);
    queueMicrotask(() => {
      req.emit("data", Buffer.from("toolong"));
      req.emit("end");
    });
    await p1;

    // No leftover data listeners from first call.
    expect(req.listenerCount("data")).toBe(0);

    // Second call — normal read
    const p2 = readBodyWithCap(req as unknown as IncomingMessage, 100);
    queueMicrotask(() => {
      req.emit("data", Buffer.from("hi"));
      req.emit("end");
    });
    const r2 = await p2;
    expect(r2.ok).toBe(true);

    // After the second call finishes normally, data listener should also be gone.
    expect(req.listenerCount("data")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #34 — PATCH /recipes/:name body cap should be small (≤ 1 KB)
// #36 — GET /runs/:seq/plan: undefined recipeName → 404, not TypeError 500
// #35 — Temp file cleanup when writeFileSync throws
// ---------------------------------------------------------------------------

const LOGGER = new Logger(false);
const TOKEN = "test-audit-low-token-0000000000000000";

let server: Server | null = null;
let port = 0;

function makeRequest(
  options: http.RequestOptions & { method: string; path: string },
  body = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let captured = { status: 0, body: "" };
    const finish = (status: number, data: string) => {
      if (resolved) return;
      resolved = true;
      captured = { status, body: data };
      resolve(captured);
    };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        ...options,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => finish(res.statusCode ?? 0, data));
        res.on("error", () => finish(res.statusCode ?? 0, data));
        res.on("close", () => finish(res.statusCode ?? 0, data));
      },
    );
    req.on("error", (err) => {
      if (resolved) return;
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

beforeEach(async () => {
  server = new Server(TOKEN, LOGGER);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
  vi.restoreAllMocks();
});

describe("LOW #34 — PATCH /recipes/:name uses a tight body cap", () => {
  it("returns 413 when body exceeds 1 KB (was allowed with 256 KB cap)", async () => {
    // 2 KB body — should be rejected with the new tight cap.
    const bigBody = JSON.stringify({
      enabled: true,
      padding: "x".repeat(2048),
    });
    const { status } = await makeRequest(
      { method: "PATCH", path: "/recipes/my-recipe" },
      bigBody,
    );
    // Must be 413 (too large), NOT 200 or 400.
    expect(status).toBe(413);
  });

  it("still accepts the minimal boolean payload", async () => {
    // Wire up a setRecipeEnabledFn so the route proceeds past the cap check.
    server!.setRecipeEnabledFn = (_name: string, _enabled: boolean) => ({
      ok: true,
    });
    const { status } = await makeRequest(
      { method: "PATCH", path: "/recipes/my-recipe" },
      JSON.stringify({ enabled: true }),
    );
    expect(status).toBe(200);
  });
});

describe("LOW #36 — GET /runs/:seq/plan: undefined recipeName → 404 not 500", () => {
  const RUN_WITH_NO_RECIPE_NAME = {
    seq: 42,
    taskId: "yaml:orphan-run:123",
    // recipeName intentionally omitted / undefined
    trigger: "recipe",
    status: "done",
    createdAt: 1714000000000,
    startedAt: 1714000000000,
    doneAt: 1714000005000,
    durationMs: 5000,
  };

  it("returns 404 (not 500 TypeError) when run.recipeName is undefined", async () => {
    server!.runDetailFn = (seq) =>
      seq === 42
        ? (RUN_WITH_NO_RECIPE_NAME as unknown as Record<string, unknown>)
        : null;
    server!.runPlanFn = async (name: string) => ({ recipe: name, steps: [] });

    const { status, body } = await makeRequest({
      method: "GET",
      path: "/runs/42/plan",
    });

    // Must NOT be 500 (TypeError crash). Should be 404 or similar safe code.
    expect(status).not.toBe(500);
    expect([404, 400]).toContain(status);
    const parsed = JSON.parse(body) as { error?: string };
    expect(parsed.error).toBeTruthy();
  });
});

// LOW #35 — temp file cleanup is tested in recipeRoutes-install-cleanup.test.ts
// (separate file needed for vi.mock hoisting to intercept node:fs ESM exports).
