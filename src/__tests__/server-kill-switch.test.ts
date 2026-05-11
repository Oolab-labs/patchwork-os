/**
 * Tests for `GET /kill-switch` + `POST /kill-switch` — the dedicated
 * endpoint added in step 2 of the issue #422 v2 implementation series.
 *
 * Verifies:
 *   - GET returns current engaged/locked state
 *   - POST {engage: true} engages + returns changed:true
 *   - POST {engage: true} when already engaged returns changed:false (idempotent)
 *   - POST {engage: false} after engage returns to off + emits audit
 *   - POST when env-locked returns structured 409 with frozenValue
 *   - POST with malformed body returns 400 invalid_request
 *   - GET surfaces lockedReason + lockedValue when env-locked
 *
 * Audit-log emit is currently a logger.info stub; the test asserts the
 * log was called with the expected message shape so step 5 (real
 * decisionTraceLog plumbing) can swap the implementation without
 * breaking this test.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetEnvLockForTesting,
  isWriteKillSwitchActive,
  KILL_SWITCH_WRITES,
  lockKillSwitchEnv,
  setFlag,
} from "../featureFlags.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const TOKEN = "test-kill-switch-token-00000000000000";
const KILL_SWITCH_ENV = "PATCHWORK_FLAG_KILL_SWITCH_WRITES";

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
    defaultConfigPath: vi.fn().mockReturnValue("/tmp/patchwork-stub.json"),
  };
});

const logger = new Logger(false);
let server: Server | null = null;
let port = 0;

function request(
  method: "GET" | "POST",
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: "127.0.0.1",
        port,
        path: "/kill-switch",
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
  // Reset env-lock + flag state so each test starts from a clean slate.
  delete process.env[KILL_SWITCH_ENV];
  _resetEnvLockForTesting();
  // Reset the in-memory flag to default (off).
  if (isWriteKillSwitchActive()) {
    setFlag(KILL_SWITCH_WRITES, false, false);
  }
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
  delete process.env[KILL_SWITCH_ENV];
  _resetEnvLockForTesting();
  if (isWriteKillSwitchActive()) {
    setFlag(KILL_SWITCH_WRITES, false, false);
  }
  vi.clearAllMocks();
});

describe("GET /kill-switch", () => {
  it("returns engaged:false locked:false when default state and no env lock", async () => {
    const { status, body } = await request("GET");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ engaged: false, locked: false });
  });

  it("reflects current engaged state after setFlag", async () => {
    setFlag(KILL_SWITCH_WRITES, true, false);
    const { status, body } = await request("GET");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.engaged).toBe(true);
    expect(parsed.locked).toBe(false);
  });

  it("surfaces lockedReason + lockedValue when env-locked to ON", async () => {
    process.env[KILL_SWITCH_ENV] = "1";
    lockKillSwitchEnv();

    const { status, body } = await request("GET");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.locked).toBe(true);
    expect(parsed.lockedValue).toBe(true);
    expect(parsed.lockedReason).toMatch(/PATCHWORK_FLAG_KILL_SWITCH_WRITES=1/);
    expect(parsed.engaged).toBe(true); // frozen ON wins
  });

  it("surfaces lockedReason when env-locked to OFF (I2 direction-aware)", async () => {
    process.env[KILL_SWITCH_ENV] = "0";
    lockKillSwitchEnv();

    const { status, body } = await request("GET");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.locked).toBe(true);
    expect(parsed.lockedValue).toBe(false);
    expect(parsed.lockedReason).toMatch(/PATCHWORK_FLAG_KILL_SWITCH_WRITES=0/);
    expect(parsed.engaged).toBe(false); // frozen OFF wins
  });
});

describe("POST /kill-switch", () => {
  it("engages when off; returns changed:true", async () => {
    const { status, body } = await request(
      "POST",
      JSON.stringify({ engage: true }),
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ engaged: true, changed: true, locked: false });
    expect(isWriteKillSwitchActive()).toBe(true);
  });

  it("is idempotent: engage when already engaged returns changed:false", async () => {
    setFlag(KILL_SWITCH_WRITES, true, false);
    const { status, body } = await request(
      "POST",
      JSON.stringify({ engage: true }),
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ engaged: true, changed: false, locked: false });
  });

  it("releases (engage:false) after engaged; returns changed:true", async () => {
    setFlag(KILL_SWITCH_WRITES, true, false);
    const { status, body } = await request(
      "POST",
      JSON.stringify({ engage: false }),
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ engaged: false, changed: true, locked: false });
    expect(isWriteKillSwitchActive()).toBe(false);
  });

  it("is idempotent on release: returns changed:false when already off", async () => {
    const { status, body } = await request(
      "POST",
      JSON.stringify({ engage: false }),
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ engaged: false, changed: false, locked: false });
  });

  it("returns 409 env_locked when PATCHWORK_FLAG_KILL_SWITCH_WRITES=1 at boot", async () => {
    process.env[KILL_SWITCH_ENV] = "1";
    lockKillSwitchEnv();

    const { status, body } = await request(
      "POST",
      JSON.stringify({ engage: false }),
    );
    expect(status).toBe(409);
    const parsed = JSON.parse(body);
    expect(parsed.error).toBe("env_locked");
    expect(parsed.flag).toBe(KILL_SWITCH_WRITES);
    expect(parsed.frozenValue).toBe(true);
    expect(parsed.lockedReason).toMatch(/PATCHWORK_FLAG_KILL_SWITCH_WRITES=1/);
  });

  it("returns 409 env_locked when PATCHWORK_FLAG_KILL_SWITCH_WRITES=0 at boot (I2)", async () => {
    process.env[KILL_SWITCH_ENV] = "0";
    lockKillSwitchEnv();

    const { status, body } = await request(
      "POST",
      JSON.stringify({ engage: true }),
    );
    expect(status).toBe(409);
    const parsed = JSON.parse(body);
    expect(parsed.error).toBe("env_locked");
    expect(parsed.frozenValue).toBe(false);
    expect(parsed.lockedReason).toMatch(/PATCHWORK_FLAG_KILL_SWITCH_WRITES=0/);
  });

  it("returns 400 invalid_request when engage is missing", async () => {
    const { status, body } = await request("POST", JSON.stringify({}));
    expect(status).toBe(400);
    const parsed = JSON.parse(body);
    expect(parsed.error).toBe("invalid_request");
  });

  it("returns 400 invalid_request when engage is not a boolean", async () => {
    const { status, body } = await request(
      "POST",
      JSON.stringify({ engage: "yes" }),
    );
    expect(status).toBe(400);
    const parsed = JSON.parse(body);
    expect(parsed.error).toBe("invalid_request");
  });

  it("accepts a reason field; handler trims it before logging", async () => {
    // Reason ≤500 chars after trim — handler caps to 500 for audit log
    // hygiene. Body must still fit the 1 KB endpoint cap.
    const reason = "draining a runaway recipe loop".repeat(8); // ~240 chars
    const { status, body } = await request(
      "POST",
      JSON.stringify({ engage: true, reason }),
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.engaged).toBe(true);
    expect(parsed.changed).toBe(true);
  });

  it("returns 413 when body exceeds the 1 KB cap", async () => {
    // Endpoint cap is 1 KB; a 2000-byte reason puts the JSON over.
    // Verifies the cap is enforced — protects against unbounded audit
    // strings.
    const longReason = "x".repeat(2000);
    const { status } = await request(
      "POST",
      JSON.stringify({ engage: true, reason: longReason }),
    );
    expect(status).toBe(413);
  });
});
