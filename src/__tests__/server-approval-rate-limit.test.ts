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
  extraHeaders: Record<string, string> = {},
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
          ...extraHeaders,
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

  it("ignores X-Forwarded-For by default (untrusted proxy header is spoofable)", async () => {
    // Without an explicit trustedProxies allowlist, X-Forwarded-For must
    // NOT influence the bucket key — otherwise any sprayer rotates the
    // header to bypass the limit. Spray > MAX from one socket-IP with
    // distinct XFF values; at least 5 must 429.
    const max = Server.APPROVAL_IP_MAX;
    let rejected429 = 0;
    for (let i = 0; i < max + 5; i++) {
      const res = await postApprove(port, `callid-${i}`, {
        "X-Forwarded-For": `10.${i & 0xff}.${(i >> 8) & 0xff}.1`,
      });
      if (res.status === 429) rejected429++;
    }
    expect(rejected429).toBeGreaterThanOrEqual(5);
  });

  it("honors X-Forwarded-For when the socket peer is a trusted proxy", async () => {
    // Behind nginx/Caddy/Cloudflare every request's socket peer is the
    // proxy itself — without this logic, a single sprayer DoSes the legit
    // approver. With trustedProxies=["127.0.0.1"], distinct XFF clients get
    // distinct buckets.
    await server?.close();
    server = new Server(TOKEN, logger, [], 30_000, ["127.0.0.1"]);
    port = await server.findAndListen(null);

    const max = Server.APPROVAL_IP_MAX;

    // Spray MAX requests from "1.1.1.1" — should fill its bucket (some 429s
    // expected on overflow if we go further, but at MAX exactly we should
    // still be under the cap).
    for (let i = 0; i < max; i++) {
      const res = await postApprove(port, `a-${i}`, {
        "X-Forwarded-For": "1.1.1.1",
      });
      expect(res.status).not.toBe(429);
    }

    // Now MAX requests from a different XFF — must be on an independent
    // bucket. ZERO 429s expected.
    for (let i = 0; i < max; i++) {
      const res = await postApprove(port, `b-${i}`, {
        "X-Forwarded-For": "2.2.2.2",
      });
      expect(res.status).not.toBe(429);
    }
  });

  it("with trustedProxies set, rightmost untrusted XFF entry is the client", async () => {
    // Multi-hop: client → trusted-proxy-A → trusted-proxy-B → bridge.
    // XFF reads "client, proxy-A" (each hop appends to the right).
    // We trust 127.0.0.1 (the immediate peer in tests). The rightmost
    // entry NOT in trustedProxies is the client.
    await server?.close();
    server = new Server(TOKEN, logger, [], 30_000, ["127.0.0.1", "10.0.0.1"]);
    port = await server.findAndListen(null);

    const max = Server.APPROVAL_IP_MAX;

    // Spray MAX from "client-A" via the proxy chain; should fill that
    // single bucket if buckets are correctly keyed on client-A.
    for (let i = 0; i < max; i++) {
      await postApprove(port, `m-${i}`, {
        "X-Forwarded-For": "203.0.113.5, 10.0.0.1",
      });
    }
    // (max+1)th from same client → 429.
    const overflow = await postApprove(port, "m-overflow", {
      "X-Forwarded-For": "203.0.113.5, 10.0.0.1",
    });
    expect(overflow.status).toBe(429);

    // But a different client through the same proxy chain → fresh bucket.
    const fresh = await postApprove(port, "n-1", {
      "X-Forwarded-For": "203.0.113.6, 10.0.0.1",
    });
    expect(fresh.status).not.toBe(429);
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
