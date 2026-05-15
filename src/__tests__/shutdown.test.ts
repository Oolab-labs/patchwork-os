import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);

describe("POST /shutdown endpoint", () => {
  let server: Server;
  let port: number;
  const authToken = "test-shutdown-token";

  beforeEach(async () => {
    server = new Server(authToken, logger);
    port = await server.findAndListen(null);
    // Prevent the default SIGTERM-to-self from firing during tests.
    server.shutdownFn = () => {};
  });

  afterEach(async () => {
    await server.close();
  });

  function makeRequest(
    method: string,
    path: string,
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: { Authorization: `Bearer ${authToken}` },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              const parsed = data ? JSON.parse(data) : {};
              resolve({ status: res.statusCode ?? 0, body: parsed });
            } catch {
              resolve({ status: res.statusCode ?? 0, body: data });
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("returns 202 when no work is in flight", async () => {
    server.restartCheckFn = () => ({
      totalSessions: 0,
      inFlightCalls: 0,
      busySessions: [],
    });

    const res = await makeRequest("POST", "/shutdown");
    expect(res.status).toBe(202);
    expect((res.body as { ok?: boolean }).ok).toBe(true);
  });

  it("returns 409 when tool calls are in flight", async () => {
    server.restartCheckFn = () => ({
      totalSessions: 1,
      inFlightCalls: 2,
      busySessions: ["abc12345 (2 tools: file.read, git.status)"],
    });

    const res = await makeRequest("POST", "/shutdown");
    expect(res.status).toBe(409);
    expect((res.body as { error?: string }).error).toBe("shutdown_blocked");
    expect((res.body as { inFlightCalls?: number }).inFlightCalls).toBe(2);
  });

  it("force=1 overrides the in-flight check", async () => {
    server.restartCheckFn = () => ({
      totalSessions: 1,
      inFlightCalls: 5,
      busySessions: ["abc"],
    });

    const res = await makeRequest("POST", "/shutdown?force=1");
    expect(res.status).toBe(202);
    expect((res.body as { ok?: boolean }).ok).toBe(true);
  });

  it("calls shutdownFn after responding", async () => {
    let called = false;
    server.shutdownFn = () => {
      called = true;
    };
    server.restartCheckFn = () => ({
      totalSessions: 0,
      inFlightCalls: 0,
      busySessions: [],
    });

    const res = await makeRequest("POST", "/shutdown");
    expect(res.status).toBe(202);
    // shutdownFn is invoked via setTimeout(100); wait it out.
    await new Promise((r) => setTimeout(r, 200));
    expect(called).toBe(true);
  });

  it("requires authentication", async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/shutdown",
          method: "POST",
        },
        (r) => {
          r.resume();
          resolve({ status: r.statusCode ?? 0 });
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(401);
  });
});
