/**
 * Tests for HMAC-SHA256 webhook authentication at POST /hooks/*.
 *
 * When `webhookSecret` is configured, requests carrying the
 * `X-Hub-Signature-256: sha256=<hex>` header are authenticated via HMAC
 * over the raw request body, bypassing the bearer-token gate. Bearer
 * access continues to work — HMAC is additive, not a replacement.
 */
import { createHmac } from "node:crypto";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-hmac-bearer-token-000000000000";
const SECRET =
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; // 64 hex chars

let server: Server | null = null;
let port = 0;
let calls: Array<{ path: string; payload: unknown }>;

async function startServer(opts: { secret: string | null }): Promise<void> {
  calls = [];
  server = new Server(TOKEN, logger);
  server.webhookSecret = opts.secret;
  server.webhookFn = async (path, payload) => {
    calls.push({ path, payload });
    return { ok: true, name: "stub-recipe", taskId: "task-1" };
  };
  port = await server.findAndListen(null);
}

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function postHooks(
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/hooks/test-recipe",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body, "utf-8")),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("POST /hooks/* — HMAC-SHA256 webhook auth", () => {
  beforeEach(() => {
    calls = [];
  });

  it("accepts a valid X-Hub-Signature-256 (no bearer needed)", async () => {
    await startServer({ secret: SECRET });
    const body = JSON.stringify({ action: "opened", number: 42 });
    const { status } = await postHooks(body, {
      "X-Hub-Signature-256": sign(body, SECRET),
    });
    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/test-recipe");
    expect(calls[0].payload).toEqual({ action: "opened", number: 42 });
  });

  it("rejects an invalid signature with 401 invalid_signature", async () => {
    await startServer({ secret: SECRET });
    const body = JSON.stringify({ action: "opened" });
    const bogus = sign(body, "0".repeat(64));
    const { status, body: respBody } = await postHooks(body, {
      "X-Hub-Signature-256": bogus,
    });
    expect(status).toBe(401);
    expect(JSON.parse(respBody)).toEqual({ error: "invalid_signature" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a tampered signature (one char off) — constant-time compare", async () => {
    await startServer({ secret: SECRET });
    const body = JSON.stringify({ action: "opened" });
    const good = sign(body, SECRET);
    // Flip the final hex char to its neighbor — same length, off by one.
    const last = good[good.length - 1];
    const flipped = last === "0" ? "1" : "0";
    const tampered = good.slice(0, -1) + flipped;
    const { status } = await postHooks(body, {
      "X-Hub-Signature-256": tampered,
    });
    expect(status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("returns 401 webhook_secret_not_configured when signature presented but no secret set", async () => {
    await startServer({ secret: null });
    const body = JSON.stringify({ action: "opened" });
    // Use any valid-shaped signature — server has no secret to compare against
    const sig = sign(body, SECRET);
    // Need a bearer to pass the outer gate, otherwise we never reach the
    // /hooks handler. (No secret means no HMAC bypass.)
    const { status, body: respBody } = await postHooks(body, {
      "X-Hub-Signature-256": sig,
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(401);
    expect(JSON.parse(respBody)).toEqual({
      error: "webhook_secret_not_configured",
    });
    expect(calls).toHaveLength(0);
  });

  it("falls back to Bearer auth when no signature header (backwards compat)", async () => {
    await startServer({ secret: SECRET });
    const body = JSON.stringify({ source: "internal-automation" });
    const { status } = await postHooks(body, {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toEqual({ source: "internal-automation" });
  });

  it("returns 401 when neither signature nor Bearer is provided", async () => {
    await startServer({ secret: SECRET });
    const body = JSON.stringify({ action: "opened" });
    const { status } = await postHooks(body, {});
    expect(status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("accepts empty body with a valid signature (GitHub ping edge case)", async () => {
    await startServer({ secret: SECRET });
    const body = "";
    const { status } = await postHooks(body, {
      "X-Hub-Signature-256": sign(body, SECRET),
    });
    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    // Empty body — payload is undefined (no JSON parse attempted on empty input)
    expect(calls[0].payload).toBeUndefined();
  });
});
