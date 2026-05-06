/**
 * Rate-limit + refusal-handling tests for `/recipes/generate`.
 *
 * Each call to /recipes/generate enqueues a Claude subprocess via the
 * orchestrator. Without a route-scoped cap a scripted attacker holding a
 * bridge token can DoS the queue or run up subscription costs. The
 * audit (2026-05-06) flagged this as P0; PR adds a per-process token
 * bucket at 10 req/min.
 *
 * The Claude orchestrator isn't wired in these tests (Server is
 * default-constructed without `--claude-driver subprocess`), so the
 * route returns 503 `unavailable:true` after the rate-limit check
 * passes. That's fine for testing the limiter in isolation: tokens get
 * consumed regardless of the downstream branch, so the 11th request
 * still trips 429.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { _resetGenerateRateLimitForTests } from "../recipeRoutes.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-generate-rate-limit-0000000000000000";

let server: Server | null = null;
let port = 0;

function postGenerate(prompt: string): Promise<{
  status: number;
  body: string;
  retryAfter: string | null;
}> {
  const payload = JSON.stringify({ prompt });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/recipes/generate",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            retryAfter: (res.headers["retry-after"] as string) ?? null,
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

beforeEach(async () => {
  _resetGenerateRateLimitForTests();
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

describe("/recipes/generate — rate limit", () => {
  it("allows the first 10 requests, rejects the 11th with 429 + Retry-After", async () => {
    // Issue requests sequentially so the bucket sees deterministic
    // refilled-by-elapsed-time math (parallel calls in the same ms tick
    // would also work, but sequential is easier to reason about).
    for (let i = 0; i < 10; i++) {
      const res = await postGenerate(`request ${i}`);
      expect(
        res.status,
        `request ${i + 1} should not be rate-limited`,
      ).not.toBe(429);
    }

    const eleventh = await postGenerate("request 11");
    expect(eleventh.status).toBe(429);
    expect(eleventh.retryAfter).toBeTruthy();
    const parsed = JSON.parse(eleventh.body) as {
      ok: boolean;
      error: string;
      retryAfterSeconds: number;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Rate limit exceeded/);
    expect(parsed.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("rate-limit is per-process — _resetGenerateRateLimitForTests gives a fresh bucket", async () => {
    // Drain the bucket to confirm we hit 429 …
    for (let i = 0; i < 10; i++) {
      await postGenerate(`pre ${i}`);
    }
    const drained = await postGenerate("drained");
    expect(drained.status).toBe(429);

    // … then reset and confirm the next call is back to the non-429 path.
    _resetGenerateRateLimitForTests();
    const fresh = await postGenerate("after reset");
    expect(fresh.status).not.toBe(429);
  });
});
