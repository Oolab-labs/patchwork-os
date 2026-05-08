/**
 * Per-IP rate limit on the unauthenticated phone-path approval endpoints
 * (`POST /approve/:callId` + `POST /reject/:callId` when `x-approval-token`
 * is present). The auth gate intentionally bypasses bearer auth for this
 * surface so a phone can dispatch without a bridge token; the limiter
 * defends against an attacker spraying garbage tokens to DoS the legit
 * approver via the per-callId failure cap.
 *
 * Follow-up to PR #380 (which bumped per-callId failure cap to 1000 to
 * close the cap-as-DoS loophole) per its commit-message commitment to
 * land HTTP-layer spray defense.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-token-approval-rl-1234567890ab";
const FAKE_APPROVAL_TOKEN = "deadbeef".repeat(8); // 64 hex chars

let server: Server | null = null;
let port: number;

beforeEach(async () => {
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
});

/** POST /approve/<callId> with x-approval-token header (the phone-path bypass). */
async function postApprove(
  p: number,
  callId: string,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: p,
        path: `/approve/${callId}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-approval-token": FAKE_APPROVAL_TOKEN,
        },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

/** POST /approve/<callId> WITH valid bearer (rate-limit must not gate this path). */
async function postApproveAsAuthed(
  p: number,
  callId: string,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: p,
        path: `/approve/${callId}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

describe("phone-path approval per-IP rate limit", () => {
  it("rejects with 429 after APPROVAL_IP_MAX wrong-token POSTs from one IP", async () => {
    // First MAX requests pass through the limiter. Without a queue dispatch
    // wired they'll 404 (no such callId) — that's fine; we're testing the
    // limiter, not the queue. The (MAX+1)th gets 429.
    const max = Server.APPROVAL_IP_MAX;
    let rejected429 = 0;
    let other = 0;
    for (let i = 0; i < max + 5; i++) {
      const res = await postApprove(port, `callid-${i}`);
      if (res.status === 429) rejected429++;
      else other++;
    }
    expect(rejected429).toBeGreaterThanOrEqual(5);
    expect(other).toBeLessThanOrEqual(max);
  });

  it("authenticated bearer requests are NOT rate-limited", async () => {
    // Sanity: the limiter only fires on the bypass surface. A caller with a
    // valid bearer should be unaffected.
    const max = Server.APPROVAL_IP_MAX;
    for (let i = 0; i < max + 10; i++) {
      const res = await postApproveAsAuthed(port, `callid-${i}`);
      // 404 (no such callId) is the expected dispatch outcome — what
      // matters is that NONE of them are 429.
      expect(res.status).not.toBe(429);
    }
  });

  it("does not gate non-approval paths even when phone-path bypass shape is otherwise present", async () => {
    // Sanity: a POST to /approve/* WITHOUT x-approval-token is NOT a
    // phone-path bypass — it falls back to bearer auth and 401s. The
    // limiter must not fire on that surface (would cause weird interactions
    // with the bearer path).
    const url = (i: number): http.RequestOptions => ({
      hostname: "127.0.0.1",
      port,
      path: `/approve/no-token-${i}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const post = (i: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = http.request(url(i), (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.end("{}");
      });
    // Spray > MAX without the x-approval-token header. None should be 429.
    for (let i = 0; i < Server.APPROVAL_IP_MAX + 5; i++) {
      const code = await post(i);
      expect(code).toBe(401);
    }
  });
});
