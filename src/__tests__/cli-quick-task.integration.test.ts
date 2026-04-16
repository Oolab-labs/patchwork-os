/**
 * Integration coverage for POST /launch-quick-task — the HTTP endpoint
 * backing `claude-ide-bridge quick-task <preset>` and `start-task`.
 *
 * The tool-level handler is already covered in launchQuickTask.test.ts;
 * here we lock in the HTTP auth/validation boundary that shipped in
 * v2.42.0 with no dedicated coverage.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const AUTH = "test-token-cli-quick-task";

type LaunchResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
};

let server: Server;
let port: number;
let fnCalls: { presetId: string; source: string }[];
let fnImpl: (presetId: string, source: string) => Promise<LaunchResult>;

async function post(
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
  return { status: res.status, body: await res.text() };
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${AUTH}`, ...extra };
}

beforeEach(async () => {
  fnCalls = [];
  fnImpl = async (presetId, source) => {
    fnCalls.push({ presetId, source });
    return { ok: true, result: { taskId: "t-1" } };
  };
  server = new Server(AUTH, new Logger(false));
  server.launchQuickTaskFn = (presetId, source) => fnImpl(presetId, source);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server.close();
});

describe("POST /launch-quick-task — HTTP boundary", () => {
  it("rejects requests with no Authorization header (401)", async () => {
    const r = await post(
      "/launch-quick-task",
      JSON.stringify({
        presetId: "fixErrors",
      }),
    );
    expect(r.status).toBe(401);
    expect(fnCalls).toHaveLength(0);
  });

  it("rejects requests with malformed bearer (401)", async () => {
    const r = await post(
      "/launch-quick-task",
      JSON.stringify({ presetId: "fixErrors" }),
      { Authorization: "Bearer not-the-token" },
    );
    expect(r.status).toBe(401);
    expect(fnCalls).toHaveLength(0);
  });

  it("rejects requests with stale-prefix (e.g. Basic) as non-Bearer (401)", async () => {
    const r = await post(
      "/launch-quick-task",
      JSON.stringify({ presetId: "fixErrors" }),
      { Authorization: `Basic ${AUTH}` },
    );
    expect(r.status).toBe(401);
  });

  it("returns 400 when presetId is missing", async () => {
    const r = await post("/launch-quick-task", JSON.stringify({}), authed());
    expect(r.status).toBe(400);
    const parsed = JSON.parse(r.body) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/presetId/);
    expect(fnCalls).toHaveLength(0);
  });

  it("returns 400 on invalid JSON body", async () => {
    const r = await post("/launch-quick-task", "{not-json", authed());
    expect(r.status).toBe(400);
    expect(fnCalls).toHaveLength(0);
  });

  it("returns 503 when launchQuickTaskFn is unset (driver not subprocess)", async () => {
    server.launchQuickTaskFn = null;
    const r = await post(
      "/launch-quick-task",
      JSON.stringify({ presetId: "fixErrors" }),
      authed(),
    );
    expect(r.status).toBe(503);
    const parsed = JSON.parse(r.body) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/subprocess/);
  });

  it("dispatches presetId + default source='cli' to the bridge fn on success", async () => {
    const r = await post(
      "/launch-quick-task",
      JSON.stringify({ presetId: "fixErrors" }),
      authed(),
    );
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body) as LaunchResult;
    expect(parsed.ok).toBe(true);
    expect(fnCalls).toEqual([{ presetId: "fixErrors", source: "cli" }]);
  });

  it("forwards explicit source field when provided", async () => {
    await post(
      "/launch-quick-task",
      JSON.stringify({ presetId: "runTests", source: "sidebar" }),
      authed(),
    );
    expect(fnCalls[0]).toEqual({ presetId: "runTests", source: "sidebar" });
  });

  it("maps bridge fn { ok:false } to HTTP 429 (cooldown surface)", async () => {
    fnImpl = async () => ({
      ok: false,
      error: "cooldown active",
      code: "COOLDOWN",
    });
    const r = await post(
      "/launch-quick-task",
      JSON.stringify({ presetId: "fixErrors" }),
      authed(),
    );
    expect(r.status).toBe(429);
    const parsed = JSON.parse(r.body) as LaunchResult;
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("COOLDOWN");
  });

  it("rapid-fire: each POST dispatches through to the bridge fn", async () => {
    // Cooldown enforcement lives in the tool/launchQuickTaskFn, NOT the HTTP
    // layer — this test verifies the HTTP layer doesn't silently drop or
    // coalesce requests, and that the fn is invoked once per request.
    const results = await Promise.all(
      Array.from({ length: 3 }).map(() =>
        post(
          "/launch-quick-task",
          JSON.stringify({ presetId: "fixErrors" }),
          authed(),
        ),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(fnCalls).toHaveLength(3);
  });
});
