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
  EnvLockedFlagError,
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

describe("POST /kill-switch — audit emit (step 5)", () => {
  it("calls recordKillSwitchTraceFn with engage event on state transition", async () => {
    const events: Array<{
      engaged: boolean;
      reason: string | undefined;
      ts: number;
    }> = [];
    server!.recordKillSwitchTraceFn = (e) => events.push(e);

    const { status } = await request(
      "POST",
      JSON.stringify({ engage: true, reason: "runaway recipe loop" }),
    );
    expect(status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.engaged).toBe(true);
    expect(events[0]?.reason).toBe("runaway recipe loop");
    expect(typeof events[0]?.ts).toBe("number");
  });

  it("does NOT emit audit on no-op (already-engaged) transitions", async () => {
    // Engage first so the second call is a no-op.
    setFlag(KILL_SWITCH_WRITES, true, false);
    const events: Array<unknown> = [];
    server!.recordKillSwitchTraceFn = (e) => events.push(e);

    const { status, body } = await request(
      "POST",
      JSON.stringify({ engage: true }),
    );
    expect(status).toBe(200);
    expect(JSON.parse(body).changed).toBe(false);
    // Audit log should remain empty — no real state change happened.
    expect(events).toHaveLength(0);
  });

  it("emits release with reason undefined when no reason is supplied", async () => {
    setFlag(KILL_SWITCH_WRITES, true, false);
    const events: Array<{
      engaged: boolean;
      reason: string | undefined;
    }> = [];
    server!.recordKillSwitchTraceFn = (e) => events.push(e);

    await request("POST", JSON.stringify({ engage: false }));
    expect(events).toHaveLength(1);
    expect(events[0]?.engaged).toBe(false);
    expect(events[0]?.reason).toBeUndefined();
  });

  it("does NOT emit audit when env-locked (409 path)", async () => {
    process.env[KILL_SWITCH_ENV] = "1";
    lockKillSwitchEnv();
    const events: Array<unknown> = [];
    server!.recordKillSwitchTraceFn = (e) => events.push(e);

    const { status } = await request("POST", JSON.stringify({ engage: false }));
    expect(status).toBe(409);
    expect(events).toHaveLength(0);
  });

  it("trims reason to 500 chars before emit", async () => {
    const events: Array<{
      reason: string | undefined;
    }> = [];
    server!.recordKillSwitchTraceFn = (e) => events.push(e);

    // 600-char reason fits inside the 1 KB body cap but exceeds the
    // 500-char trim. After trim, reason should be exactly 500.
    const reason = "a".repeat(600);
    await request("POST", JSON.stringify({ engage: true, reason }));
    expect(events).toHaveLength(1);
    expect(events[0]?.reason?.length).toBe(500);
  });

  it("does not throw when recordKillSwitchTraceFn is unset (logger-only path)", async () => {
    server!.recordKillSwitchTraceFn = null;
    const { status } = await request("POST", JSON.stringify({ engage: true }));
    expect(status).toBe(200);
    // No assertion on side effect — verifying the optional-callback
    // pattern doesn't crash the handler.
  });
});

describe("POST /kill-switch — SSE broadcast (v2-I8)", () => {
  it("calls broadcastKillSwitchEventFn with engaged:true on engage", async () => {
    const broadcasts: Array<{ engaged: boolean; reason?: string }> = [];
    server!.broadcastKillSwitchEventFn = (engaged, reason) =>
      broadcasts.push({ engaged, reason });

    const { status } = await request(
      "POST",
      JSON.stringify({ engage: true, reason: "test-broadcast" }),
    );
    expect(status).toBe(200);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.engaged).toBe(true);
    expect(broadcasts[0]?.reason).toBe("test-broadcast");
  });

  it("calls broadcastKillSwitchEventFn with engaged:false on release", async () => {
    setFlag(KILL_SWITCH_WRITES, true, false);
    const broadcasts: Array<{ engaged: boolean }> = [];
    server!.broadcastKillSwitchEventFn = (engaged) =>
      broadcasts.push({ engaged });

    await request("POST", JSON.stringify({ engage: false }));
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.engaged).toBe(false);
  });

  it("does NOT call broadcastKillSwitchEventFn on no-op (already-engaged)", async () => {
    setFlag(KILL_SWITCH_WRITES, true, false);
    const broadcasts: Array<unknown> = [];
    server!.broadcastKillSwitchEventFn = (engaged) => broadcasts.push(engaged);

    const { body } = await request("POST", JSON.stringify({ engage: true }));
    expect(JSON.parse(body).changed).toBe(false);
    expect(broadcasts).toHaveLength(0);
  });

  it("does NOT call broadcastKillSwitchEventFn on 409 env-locked", async () => {
    process.env[KILL_SWITCH_ENV] = "1";
    lockKillSwitchEnv();
    const broadcasts: Array<unknown> = [];
    server!.broadcastKillSwitchEventFn = (engaged) => broadcasts.push(engaged);

    const { status } = await request("POST", JSON.stringify({ engage: false }));
    expect(status).toBe(409);
    expect(broadcasts).toHaveLength(0);
  });

  it("does not throw when broadcastKillSwitchEventFn is unset", async () => {
    server!.broadcastKillSwitchEventFn = null;
    const { status } = await request("POST", JSON.stringify({ engage: true }));
    expect(status).toBe(200);
  });
});

describe("EnvLockedFlagError — setFlag throws when env-locked (v2-I9)", () => {
  it("setFlag throws EnvLockedFlagError when kill-switch flag is env-locked to true", () => {
    process.env[KILL_SWITCH_ENV] = "1";
    lockKillSwitchEnv();

    expect(() => setFlag(KILL_SWITCH_WRITES, false)).toThrow(
      EnvLockedFlagError,
    );
  });

  it("setFlag throws EnvLockedFlagError when kill-switch flag is env-locked to false", () => {
    process.env[KILL_SWITCH_ENV] = "0";
    lockKillSwitchEnv();

    expect(() => setFlag(KILL_SWITCH_WRITES, true)).toThrow(EnvLockedFlagError);
  });

  it("EnvLockedFlagError carries correct frozenValue when locked to true", () => {
    process.env[KILL_SWITCH_ENV] = "1";
    lockKillSwitchEnv();

    let err: EnvLockedFlagError | null = null;
    try {
      setFlag(KILL_SWITCH_WRITES, false);
    } catch (e) {
      err = e as EnvLockedFlagError;
    }
    expect(err).toBeInstanceOf(EnvLockedFlagError);
    expect(err?.frozenValue).toBe(true);
    expect(err?.flagId).toBe(KILL_SWITCH_WRITES);
    expect(err?.name).toBe("EnvLockedFlagError");
  });

  it("EnvLockedFlagError carries correct frozenValue when locked to false", () => {
    process.env[KILL_SWITCH_ENV] = "0";
    lockKillSwitchEnv();

    let err: EnvLockedFlagError | null = null;
    try {
      setFlag(KILL_SWITCH_WRITES, true);
    } catch (e) {
      err = e as EnvLockedFlagError;
    }
    expect(err?.frozenValue).toBe(false);
  });

  it("setFlag does NOT throw when env var is absent (env lock exists but no freeze)", () => {
    // lockKillSwitchEnv with no env var → FROZEN_KILL_SWITCH_ENV.get() returns
    // undefined → isEnvLockedFor returns false → no throw.
    lockKillSwitchEnv();
    expect(() => setFlag(KILL_SWITCH_WRITES, true)).not.toThrow();
  });
});
