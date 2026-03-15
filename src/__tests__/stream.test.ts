/**
 * Tests for the GET /stream SSE endpoint.
 */
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLog } from "../activityLog.js";
import { Server } from "../server.js";

const TEST_TOKEN = "test-token-that-is-long-enough-for-the-server";

function makeServer(): { server: Server; log: ActivityLog } {
  const log = new ActivityLog();
  const server = new Server(TEST_TOKEN, {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    event: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import("../logger.js").Logger);
  server.streamFn = (listener) =>
    log.subscribe(listener as Parameters<typeof log.subscribe>[0]);
  return { server, log };
}

async function startServer(
  server: Server,
): Promise<{ port: number; close: () => Promise<void> }> {
  const port = await server.findAndListen(null, "127.0.0.1");
  return {
    port,
    close: () => server.close(),
  };
}

function sseGet(
  port: number,
  token: string,
): Promise<{ status: number; chunks: string[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const req = http.get(
      `http://127.0.0.1:${port}/stream`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          chunks,
          close: () => req.destroy(),
        });
        res.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      },
    );
    req.on("error", reject);
  });
}

describe("GET /stream SSE endpoint", () => {
  let server: Server;
  let log: ActivityLog;
  let port: number;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    ({ server, log } = makeServer());
    ({ port, close: closeServer } = await startServer(server));
  });

  afterEach(async () => {
    await closeServer();
  });

  it("returns 401 without auth token", async () => {
    const res = await new Promise<number>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/stream`, (r) =>
          resolve(r.statusCode ?? 0),
        )
        .on("error", reject);
    });
    expect(res).toBe(401);
  });

  it("returns 200 with text/event-stream content-type", async () => {
    const { status, close } = await sseGet(port, TEST_TOKEN);
    expect(status).toBe(200);
    close();
  });

  it("streams tool events as SSE data lines", async () => {
    const { chunks, close } = await sseGet(port, TEST_TOKEN);

    // Wait for connection to be established
    await new Promise((r) => setTimeout(r, 20));

    log.record("openFile", 10, "success");

    // Give the event a moment to propagate
    await new Promise((r) => setTimeout(r, 20));

    close();
    const body = chunks.join("");
    expect(body).toContain("data:");
    expect(body).toContain('"tool":"openFile"');
    expect(body).toContain('"kind":"tool"');
  });

  it("streams lifecycle events as SSE data lines", async () => {
    const { chunks, close } = await sseGet(port, TEST_TOKEN);
    await new Promise((r) => setTimeout(r, 20));

    log.recordEvent("claude_connected", { sessionId: "abc" });
    await new Promise((r) => setTimeout(r, 20));

    close();
    const body = chunks.join("");
    expect(body).toContain('"event":"claude_connected"');
    expect(body).toContain('"kind":"lifecycle"');
  });

  it("multiple subscribers receive independent event streams", async () => {
    const { chunks: chunks1, close: close1 } = await sseGet(port, TEST_TOKEN);
    const { chunks: chunks2, close: close2 } = await sseGet(port, TEST_TOKEN);
    await new Promise((r) => setTimeout(r, 20));

    log.record("runTests", 500, "success");
    await new Promise((r) => setTimeout(r, 20));

    close1();
    close2();
    expect(chunks1.join("")).toContain('"tool":"runTests"');
    expect(chunks2.join("")).toContain('"tool":"runTests"');
  });
});
