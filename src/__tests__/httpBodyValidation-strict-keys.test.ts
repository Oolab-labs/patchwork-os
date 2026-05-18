/**
 * Strict body-key validation — endpoint regression suite.
 *
 * Pre-fix, `readJsonBody<T>()` was TS-erased at runtime: unknown top-level
 * keys (`enabledZ`, `targerName`, `bogus`) were silently dropped by the
 * handler's destructure and the request succeeded as a no-op. This file
 * proves every covered endpoint now returns 400 + lists the offending keys.
 *
 * Covers (one assertion per endpoint, fast):
 *   - POST   /recipes/:name/run
 *   - POST   /recipes/run
 *   - POST   /recipes/:name/promote
 *   - PATCH  /recipes/:name/trust
 *   - POST   /settings
 *   - POST   /telemetry-prefs
 *   - POST   /kill-switch
 *
 * Pure unit test for the helper itself is at the bottom — exercising the
 * `Object.hasOwn` short-circuit + the array/null/non-object pass-through.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  respondIfUnknownBodyKeys,
  validateAllowedBodyKeys,
} from "../httpBodyValidation.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

vi.mock("../patchwork.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../patchwork.js")>();
  return {
    ...actual,
    loadPatchworkConfig: vi.fn().mockReturnValue({
      dashboard: {
        port: 3000,
        requireApproval: ["high"],
        pushNotifications: false,
      },
      approvalGate: "high",
    }),
    savePatchworkConfig: vi.fn(),
    patchworkConfigPath: vi.fn().mockReturnValue("/tmp/patchwork-stub.json"),
  };
});

const logger = new Logger(false);
const TOKEN = "test-strict-keys-token-00000000000000000";
let server: Server | null = null;
let port = 0;

function request(
  options: http.RequestOptions,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, ...options },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
  };
}

beforeEach(async () => {
  server = new Server(TOKEN, logger);
  // Wire stub recipe-route deps so the routes proceed past the 503 path
  // when input is otherwise valid — but the strict-key check fires BEFORE
  // those deps, so even bare stubs are sufficient for these tests.
  server.runRecipeFn = async () => ({ ok: true });
  server.setRecipeTrustFn = () => ({ ok: true as const });
  server.promoteRecipeVariantFn = async () => ({ ok: true as const });
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
  vi.clearAllMocks();
});

describe("strict body-key validation — HTTP endpoints", () => {
  it("POST /recipes/:name/run rejects unknown key `bogus`", async () => {
    const res = await request(
      { method: "POST", path: "/recipes/foo/run", headers: authHeaders() },
      JSON.stringify({ vars: { ok: "x" }, bogus: 1 }),
    );
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body) as {
      error: string;
      unknownKeys: string[];
    };
    expect(parsed.error).toBe("Unknown body fields");
    expect(parsed.unknownKeys).toContain("bogus");
  });

  it("POST /recipes/run rejects unknown key `args`", async () => {
    const res = await request(
      { method: "POST", path: "/recipes/run", headers: authHeaders() },
      JSON.stringify({ name: "foo", args: { x: 1 } }),
    );
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body) as { unknownKeys: string[] };
    expect(parsed.unknownKeys).toContain("args");
  });

  it("POST /recipes/run accepts `inputs` (symmetry with :name/run)", async () => {
    const res = await request(
      { method: "POST", path: "/recipes/run", headers: authHeaders() },
      JSON.stringify({ name: "foo", inputs: { ok_key: "value" } }),
    );
    // 200 (runRecipeFn stub returns ok). The strict-key check would have
    // returned 400 if `inputs` weren't on the allow-list.
    expect(res.status).toBe(200);
  });

  it("POST /recipes/:name/promote rejects unknown key `targerName` (typo)", async () => {
    const res = await request(
      { method: "POST", path: "/recipes/foo/promote", headers: authHeaders() },
      JSON.stringify({ targetName: "bar", targerName: "baz" }),
    );
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body) as { unknownKeys: string[] };
    expect(parsed.unknownKeys).toContain("targerName");
  });

  it("PATCH /recipes/:name/trust rejects unknown key `levelZ`", async () => {
    const res = await request(
      { method: "PATCH", path: "/recipes/foo/trust", headers: authHeaders() },
      JSON.stringify({ level: "trusted", levelZ: "x" }),
    );
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body) as { unknownKeys: string[] };
    expect(parsed.unknownKeys).toContain("levelZ");
  });

  it("POST /settings rejects unknown key `bogus`", async () => {
    const res = await request(
      { method: "POST", path: "/settings", headers: authHeaders() },
      JSON.stringify({ approvalGate: "high", bogus: true }),
    );
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body) as { unknownKeys: string[] };
    expect(parsed.unknownKeys).toContain("bogus");
  });

  it("POST /telemetry-prefs rejects unknown key `enabledZ`", async () => {
    const res = await request(
      { method: "POST", path: "/telemetry-prefs", headers: authHeaders() },
      JSON.stringify({ crashReports: true, enabledZ: true }),
    );
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body) as { unknownKeys: string[] };
    expect(parsed.unknownKeys).toContain("enabledZ");
  });

  it("POST /kill-switch rejects unknown key `bogus`", async () => {
    const res = await request(
      { method: "POST", path: "/kill-switch", headers: authHeaders() },
      JSON.stringify({ engage: true, bogus: "x" }),
    );
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body) as { unknownKeys: string[] };
    expect(parsed.unknownKeys).toContain("bogus");
  });
});

describe("validateAllowedBodyKeys — unit", () => {
  it("accepts a body whose keys are all on the allow-list", () => {
    expect(validateAllowedBodyKeys({ a: 1, b: 2 }, ["a", "b"])).toEqual({
      ok: true,
    });
  });

  it("lists offending keys when extras are present", () => {
    const r = validateAllowedBodyKeys({ a: 1, b: 2, c: 3 }, ["a"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unknownKeys.sort()).toEqual(["b", "c"]);
  });

  it("short-circuits ok=true on non-object / null / array bodies", () => {
    expect(validateAllowedBodyKeys(null, ["a"])).toEqual({ ok: true });
    expect(validateAllowedBodyKeys([], ["a"])).toEqual({ ok: true });
    expect(validateAllowedBodyKeys("hi" as unknown, ["a"])).toEqual({
      ok: true,
    });
  });

  it("respondIfUnknownBodyKeys writes 400 + Unknown body fields on failure", () => {
    let status = 0;
    let payload = "";
    const fakeRes = {
      writeHead: (s: number) => {
        status = s;
      },
      end: (b: string) => {
        payload = b;
      },
    } as unknown as import("node:http").ServerResponse;
    const handled = respondIfUnknownBodyKeys(fakeRes, { x: 1 }, ["y"]);
    expect(handled).toBe(true);
    expect(status).toBe(400);
    expect(JSON.parse(payload)).toEqual({
      error: "Unknown body fields",
      unknownKeys: ["x"],
    });
  });

  it("respondIfUnknownBodyKeys returns false on success", () => {
    const fakeRes = {
      writeHead: () => {},
      end: () => {},
    } as unknown as import("node:http").ServerResponse;
    expect(respondIfUnknownBodyKeys(fakeRes, { y: 1 }, ["y"])).toBe(false);
  });
});
