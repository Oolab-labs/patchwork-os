/**
 * Body-cap smoke test for connector token-paste routes.
 *
 * Pre-fix the 8 `/connections/<vendor>/connect` POST handlers each
 * accumulated `req.on("data", ...)` chunks unbounded — an authenticated
 * caller could stream a multi-GB body and burn bridge heap. This test
 * asserts oversized bodies hit 413 before the connector module even
 * loads.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-connector-body-cap-token-0000";

let server: Server | null = null;
let port = 0;

function postBytes(
  path: string,
  body: string,
): Promise<{ status: number; body: string }> {
  const payload = Buffer.from(body, "utf-8");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.byteLength,
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

beforeEach(async () => {
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

describe("/connections/<vendor>/connect — body cap", () => {
  it("rejects a 32 KB body to /connections/notion/connect with 413 (security audit, 2026-05-07)", async () => {
    // Cap is 16 KB. 32 KB body should hit 413 before the notion module
    // even loads — handler never invoked, no token validation, no
    // network call.
    const huge = JSON.stringify({ token: "x".repeat(32 * 1024) });
    const { status, body } = await postBytes(
      "/connections/notion/connect",
      huge,
    );
    expect(status).toBe(413);
    const parsed = JSON.parse(body);
    expect(parsed.code).toBe("body_too_large");
  });

  it("rejects a 32 KB body to /connections/stripe/connect with 413", async () => {
    // Stripe handler used a different `body += chunk.toString()` shape
    // pre-fix; verify the unified dispatcher caps it the same way.
    const huge = JSON.stringify({ token: "x".repeat(32 * 1024) });
    const { status } = await postBytes("/connections/stripe/connect", huge);
    expect(status).toBe(413);
  });
});
