/**
 * Tests for the per-session tool call rate limiter in McpTransport.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";
import { send, waitFor } from "./wsHelpers.js";

const logger = new Logger(false);
const servers: Server[] = [];
const clients: WebSocket[] = [];

function padToken(t: string): string {
  return t.padEnd(32, "0");
}

let _tokenCounter = 0;

async function setup(rateLimit: number): Promise<{ ws: WebSocket; transport: McpTransport }> {
  const token = padToken(`rate-limit-${++_tokenCounter}`);
  const server = new Server(token, logger);
  const transport = new McpTransport(logger);
  transport.setToolRateLimit(rateLimit);

  // Register a trivial no-op tool for testing
  transport.registerTool(
    {
      name: "ping_tool",
      description: "no-op",
      inputSchema: { type: "object", properties: {} },
    },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );

  server.on("connection", (ws: WebSocket) => {
    transport.attach(ws);
  });

  const port = await server.findAndListen(null);
  servers.push(server);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { "x-claude-code-ide-authorization": token },
  });
  clients.push(ws);

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  // MCP handshake
  send(ws, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  await waitFor(ws, (m) => m.id === 0);
  send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((r) => setTimeout(r, 10));

  return { ws, transport };
}

afterEach(async () => {
  for (const c of clients) {
    if (c.readyState === c.OPEN) c.close();
  }
  clients.length = 0;
  await Promise.all(servers.map((s) => s.close()));
  servers.length = 0;
});

describe("McpTransport — tool call rate limiter", () => {
  it("allows calls up to the rate limit", async () => {
    const LIMIT = 3;
    const { ws } = await setup(LIMIT);

    // Set up waitFor promises BEFORE sending to avoid missing messages
    const waiters = Array.from({ length: LIMIT }, (_, i) =>
      waitFor(ws, (m) => m.id === i + 1),
    );

    for (let i = 1; i <= LIMIT; i++) {
      send(ws, {
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "ping_tool", arguments: {} },
      });
    }

    const responses = await Promise.all(waiters);
    expect(responses.every((r) => r.error?.code !== -32029)).toBe(true);
  });

  it("rejects the (LIMIT+1)th call with error code -32029", async () => {
    const LIMIT = 3;
    const { ws } = await setup(LIMIT);
    const N = LIMIT + 1;

    const waiters = Array.from({ length: N }, (_, i) =>
      waitFor(ws, (m) => m.id === i + 1),
    );

    for (let i = 1; i <= N; i++) {
      send(ws, {
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "ping_tool", arguments: {} },
      });
    }

    const responses = await Promise.all(waiters);
    const rateLimitHit = responses.some((r) => (r.error as any)?.code === -32029);
    expect(rateLimitHit).toBe(true);
  });

  it("rate limit of 0 disables limiting (all calls pass)", async () => {
    const { ws } = await setup(0);
    const N = 10;

    const waiters = Array.from({ length: N }, (_, i) =>
      waitFor(ws, (m) => m.id === i + 1),
    );

    for (let i = 1; i <= N; i++) {
      send(ws, {
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "ping_tool", arguments: {} },
      });
    }

    const responses = await Promise.all(waiters);
    expect(responses.every((r) => (r.error as any)?.code !== -32029)).toBe(true);
  });
});
