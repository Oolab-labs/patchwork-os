import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);

describe("POST /restart endpoint", () => {
  let server: Server;
  let port: number;
  const authToken = "test-restart-token";

  beforeEach(async () => {
    server = new Server(authToken, logger);
    port = await server.findAndListen(null);
  });

  afterEach(async () => {
    await server.close();
  });

  function makeRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            Authorization: `Bearer ${authToken}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
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
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  it("returns 503 when restartCheckFn is not configured", async () => {
    const res = await makeRequest("POST", "/restart");
    expect(res.status).toBe(503);
    expect((res.body as { error?: string }).error).toBe("restart_unavailable");
  });

  it("returns 202 when no sessions are active", async () => {
    server.restartKillFn = () => {}; // prevent SIGTERM during tests
    server.restartCheckFn = () => ({
      totalSessions: 0,
      inFlightCalls: 0,
      busySessions: [],
    });

    const res = await makeRequest("POST", "/restart");
    expect(res.status).toBe(202);
    expect((res.body as { ok?: boolean }).ok).toBe(true);
    expect((res.body as { message?: string }).message).toContain(
      "Restart initiated",
    );
  });

  it("returns 409 when tool calls are in flight", async () => {
    server.restartCheckFn = () => ({
      totalSessions: 2,
      inFlightCalls: 3,
      busySessions: [
        "abc12345 (2 tools: file.read, git.status)",
        "def67890 (1 tool: file.write)",
      ],
    });

    const res = await makeRequest("POST", "/restart");
    expect(res.status).toBe(409);
    expect((res.body as { error?: string }).error).toBe("restart_blocked");
    expect((res.body as { reason?: string }).reason).toContain(
      "3 tool calls in progress",
    );
    expect((res.body as { inFlightCalls?: number }).inFlightCalls).toBe(3);
    expect((res.body as { busySessions?: string[] }).busySessions).toHaveLength(
      2,
    );
  });

  it("returns 202 when sessions exist but no tool calls are active", async () => {
    server.restartKillFn = () => {}; // prevent SIGTERM during tests
    server.restartCheckFn = () => ({
      totalSessions: 3,
      inFlightCalls: 0,
      busySessions: [],
    });

    const res = await makeRequest("POST", "/restart");
    expect(res.status).toBe(202);
    expect((res.body as { ok?: boolean }).ok).toBe(true);
    expect((res.body as { activeSessions?: number }).activeSessions).toBe(3);
  });

  it("requires authentication", async () => {
    server.restartCheckFn = () => ({
      totalSessions: 0,
      inFlightCalls: 0,
      busySessions: [],
    });

    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/restart",
          method: "POST",
          // deliberately omit Authorization header
        },
        (res) => {
          res.resume(); // drain so socket closes cleanly
          resolve({ status: res.statusCode ?? 0 });
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(401);
  });
});
