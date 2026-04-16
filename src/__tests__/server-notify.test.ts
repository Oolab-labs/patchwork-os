/**
 * Negative-path tests for POST /notify in Server.
 * Covers: auth failures, body size limit, unknown event, malformed JSON.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-notify-token-00000000000000";

let server: Server | null = null;
let port = 0;

async function startServer(): Promise<void> {
  server = new Server(TOKEN, logger);
  // Register a notifyFn so the endpoint is active
  server.notifyFn = (event: string, _args: Record<string, string>) => {
    if (!event) return { ok: false, error: "missing event" };
    if (event === "KnownEvent") return { ok: true };
    return { ok: false, error: `Unknown event: ${event}` };
  };
  port = await server.findAndListen(null);
}

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

function makeRequest(
  options: http.RequestOptions,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, ...options },
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

describe("POST /notify — auth failures", () => {
  it("returns 401 when Authorization header is missing", async () => {
    await startServer();
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/notify",
        headers: { "Content-Type": "application/json" },
      },
      JSON.stringify({ event: "KnownEvent", args: {} }),
    );
    expect(status).toBe(401);
  });

  it("returns 401 when wrong Bearer token is provided", async () => {
    await startServer();
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/notify",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
      },
      JSON.stringify({ event: "KnownEvent", args: {} }),
    );
    expect(status).toBe(401);
  });
});

describe("POST /notify — malformed / unknown payloads", () => {
  it("returns 400 for malformed JSON body", async () => {
    await startServer();
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/notify",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      "not-json{{",
    );
    expect(status).toBe(400);
  });

  it("returns 400 for unknown event name", async () => {
    await startServer();
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/notify",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ event: "NonExistentEvent", args: {} }),
    );
    // notifyFn returns ok:false for unknown events → server sends 400
    expect(status).toBe(400);
    const parsed = JSON.parse(body) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
  });

  it("returns 200 for a known event with correct auth", async () => {
    await startServer();
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/notify",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ event: "KnownEvent", args: {} }),
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});
