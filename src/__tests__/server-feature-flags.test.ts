/**
 * Tests for `POST /feature-flags` — the scoped endpoint that lets the
 * dashboard toggle user-opt-in UI flags (the recipe-editor "Enable &
 * retry" affordance for `recipe.repair-ai`).
 *
 * Verifies:
 *   - POST {id, value:true} enables the flag + returns changed
 *   - POST is idempotent (changed:false when already in that state)
 *   - POST on an unknown flag → 404
 *   - POST on a non-toggleable flag (kill-switch) → 403
 *   - POST that an env var pins → 409 env_override (write won't take effect)
 *   - malformed bodies → 400; oversized body → 413
 */

import http from "node:http";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetEnvLockForTesting,
  FLAG_REPAIR_AI,
  isEnabled,
  KILL_SWITCH_WRITES,
  setFlag,
} from "../featureFlags.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const TOKEN = "test-feature-flags-token-0000000000000";
const REPAIR_ENV = "PATCHWORK_FLAG_RECIPE_REPAIR_AI";

vi.mock("../patchworkConfig.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../patchworkConfig.js")>();
  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({
      dashboard: {
        port: 3000,
        requireApproval: ["high"],
        pushNotifications: false,
      },
      approvalGate: "high",
    }),
    saveConfig: vi.fn(),
    defaultConfigPath: vi
      .fn()
      .mockReturnValue(join(os.tmpdir(), "patchwork-stub.json")),
  };
});

const logger = new Logger(false);
let server: Server | null = null;
let port = 0;

function request(
  method: "POST",
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: "127.0.0.1",
        port,
        path: "/feature-flags",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk;
        });
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

beforeEach(async () => {
  delete process.env[REPAIR_ENV];
  _resetEnvLockForTesting();
  // Reset repair flag to its default (off) so each test starts clean.
  if (isEnabled(FLAG_REPAIR_AI)) setFlag(FLAG_REPAIR_AI, false, false);
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
  delete process.env[REPAIR_ENV];
  _resetEnvLockForTesting();
  if (isEnabled(FLAG_REPAIR_AI)) setFlag(FLAG_REPAIR_AI, false, false);
  vi.clearAllMocks();
});

describe("POST /feature-flags", () => {
  it("enables recipe.repair-ai; returns changed:true and takes effect", async () => {
    const { status, body } = await request(
      "POST",
      JSON.stringify({ id: FLAG_REPAIR_AI, value: true }),
    );
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      id: FLAG_REPAIR_AI,
      value: true,
      changed: true,
    });
    expect(isEnabled(FLAG_REPAIR_AI)).toBe(true);
  });

  it("is idempotent: enabling an already-on flag returns changed:false", async () => {
    setFlag(FLAG_REPAIR_AI, true, false);
    const { status, body } = await request(
      "POST",
      JSON.stringify({ id: FLAG_REPAIR_AI, value: true }),
    );
    expect(status).toBe(200);
    expect(JSON.parse(body).changed).toBe(false);
  });

  it("returns 404 for an unknown flag", async () => {
    const { status, body } = await request(
      "POST",
      JSON.stringify({ id: "no.such.flag", value: true }),
    );
    expect(status).toBe(404);
    expect(JSON.parse(body).error).toBe("unknown_flag");
  });

  it("returns 403 when targeting a non-toggleable flag (kill-switch)", async () => {
    const { status, body } = await request(
      "POST",
      JSON.stringify({ id: KILL_SWITCH_WRITES, value: true }),
    );
    expect(status).toBe(403);
    expect(JSON.parse(body).error).toBe("not_user_toggleable");
  });

  it("returns 409 env_override when PATCHWORK_FLAG_* pins the value off", async () => {
    process.env[REPAIR_ENV] = "0";
    const { status, body } = await request(
      "POST",
      JSON.stringify({ id: FLAG_REPAIR_AI, value: true }),
    );
    expect(status).toBe(409);
    const parsed = JSON.parse(body);
    expect(parsed.error).toBe("env_override");
    expect(parsed.envVar).toBe(REPAIR_ENV);
    expect(parsed.effectiveValue).toBe(false);
  });

  it("returns 400 when id is missing", async () => {
    const { status, body } = await request(
      "POST",
      JSON.stringify({ value: true }),
    );
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toBe("invalid_request");
  });

  it("returns 400 when value is not a boolean", async () => {
    const { status } = await request(
      "POST",
      JSON.stringify({ id: FLAG_REPAIR_AI, value: "yes" }),
    );
    expect(status).toBe(400);
  });

  it("returns 400 on unknown body keys", async () => {
    const { status } = await request(
      "POST",
      JSON.stringify({ id: FLAG_REPAIR_AI, value: true, extra: 1 }),
    );
    expect(status).toBe(400);
  });

  it("returns 413 when body exceeds the 1 KB cap", async () => {
    const { status } = await request(
      "POST",
      JSON.stringify({
        id: FLAG_REPAIR_AI,
        value: true,
        pad: "x".repeat(2000),
      }),
    );
    expect(status).toBe(413);
  });
});
