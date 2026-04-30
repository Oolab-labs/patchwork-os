/**
 * Tests for the MCP server-card discovery endpoint and the /mcp CORS
 * preflight handler. These ran with zero coverage before the extraction
 * to src/mcpRoutes.ts (slice 5 of the server.ts split) — the agent-driven
 * audit flagged the gap, and this file closes it.
 *
 * The card content is part of the public discovery surface (Claude.ai
 * probes it before connecting), so any change to its shape is a wire
 * break. CORS preflight is the gate that decides whether browsers can
 * POST to /mcp at all, so its origin-validation logic is security-
 * sensitive and worth pinning.
 */

import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
let server: Server | null = null;

afterEach(async () => {
  if (server) await server.close();
  server = null;
});

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("/.well-known/mcp/server-card.json (and /.well-known/mcp alias)", () => {
  it("returns a server-card JSON with required fields", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const res = await request(port, "/.well-known/mcp/server-card.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const card = JSON.parse(res.body) as Record<string, unknown>;
    expect(card.name).toBe("claude-ide-bridge");
    expect(typeof card.version).toBe("string");
    expect(typeof card.description).toBe("string");
    expect(card.transport).toEqual(["websocket", "stdio", "streamable-http"]);
    expect(card.capabilities).toMatchObject({
      tools: true,
      resources: true,
      prompts: true,
      elicitation: true,
    });
    expect(card.author).toBe("Oolab Labs");
    expect(typeof card.license).toBe("string");
  });

  it("aliased path /.well-known/mcp returns the same card", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const res = await request(port, "/.well-known/mcp");
    expect(res.status).toBe(200);
    const card = JSON.parse(res.body) as { name: string };
    expect(card.name).toBe("claude-ide-bridge");
  });

  it("sets Access-Control-Allow-Origin: * (public discovery)", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const res = await request(port, "/.well-known/mcp/server-card.json");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("does not require auth", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    // No Authorization header — must still return 200
    const res = await request(port, "/.well-known/mcp/server-card.json");
    expect(res.status).toBe(200);
  });
});

describe("OPTIONS /mcp — CORS preflight", () => {
  it("returns 204 and reflects loopback origin even without --cors-origin", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const res = await request(port, "/mcp", {
      method: "OPTIONS",
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      `http://127.0.0.1:${port}`,
    );
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
    expect(res.headers["access-control-allow-headers"]).toContain(
      "Authorization",
    );
    expect(res.headers["access-control-allow-headers"]).toContain(
      "Mcp-Session-Id",
    );
    expect(res.headers["access-control-expose-headers"]).toContain(
      "Mcp-Session-Id",
    );
  });

  it("reflects an explicitly-allowed origin from extraCorsOrigins", async () => {
    server = new Server("test-token", logger, ["https://claude.ai"]);
    const port = await server.findAndListen(null);

    const res = await request(port, "/mcp", {
      method: "OPTIONS",
      headers: { Origin: "https://claude.ai" },
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://claude.ai",
    );
  });

  it("does NOT reflect an untrusted non-loopback origin", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const res = await request(port, "/mcp", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(204);
    // The CORS escape: if this header is set to evil.example.com, browsers
    // will let evil.example.com POST to /mcp. Must remain unset/null.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns 204 with no Access-Control-Allow-Origin when Origin header is absent", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const res = await request(port, "/mcp", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
