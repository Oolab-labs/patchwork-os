import { randomUUID } from "node:crypto";
/**
 * Tests for the unauthenticated /ping endpoint.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const servers: Server[] = [];

async function setupServer(): Promise<{
  server: Server;
  port: number;
  authToken: string;
}> {
  const authToken = randomUUID();
  const logger = new Logger(false);
  const server = new Server(authToken, logger);
  const port = await server.findAndListen(null);
  servers.push(server);
  return { server, port, authToken };
}

function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
  });
}

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers.length = 0;
});

describe("/ping endpoint", () => {
  it("returns 200 with ok:true and version without auth", async () => {
    const { port } = await setupServer();
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/ping`);
    expect(status).toBe(200);
    const json = JSON.parse(body) as { ok: boolean; v: string };
    expect(json.ok).toBe(true);
    expect(typeof json.v).toBe("string");
    expect(json.v.length).toBeGreaterThan(0);
  });

  it("returns 200 even with a wrong auth token", async () => {
    const { port } = await setupServer();
    const { status } = await httpGet(`http://127.0.0.1:${port}/ping`, {
      Authorization: "Bearer wrong-token",
    });
    expect(status).toBe(200);
  });

  it("/health still requires auth — returns 401 without token", async () => {
    const { port } = await setupServer();
    const { status } = await httpGet(`http://127.0.0.1:${port}/health`);
    expect(status).toBe(401);
  });

  it("/health returns 200 with correct auth token", async () => {
    const { port, authToken } = await setupServer();
    const { status } = await httpGet(`http://127.0.0.1:${port}/health`, {
      Authorization: `Bearer ${authToken}`,
    });
    expect(status).toBe(200);
  });
});
