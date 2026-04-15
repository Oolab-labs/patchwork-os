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

async function setup(
  rateLimit: number,
): Promise<{ ws: WebSocket; transport: McpTransport }> {
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
    expect(responses.every((r) => (r.error as any)?.code !== -32004)).toBe(
      true,
    );
  });

  it("rejects the (LIMIT+1)th call with RATE_LIMIT_EXCEEDED (-32004)", async () => {
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
    const rateLimitHit = responses.some(
      (r) => (r.error as any)?.code === -32004,
    );
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
    expect(responses.every((r) => (r.error as any)?.code !== -32004)).toBe(
      true,
    );
  });

  it("AJV validation failure does not consume a rate limit token", async () => {
    // With LIMIT=1: if AJV failures consumed tokens, the valid call that follows
    // would be rate-limited (-32004, RATE_LIMIT_EXCEEDED). It must succeed instead.
    const LIMIT = 1;
    const { ws, transport } = await setup(LIMIT);

    // Register a strict tool that requires a field
    transport.registerTool(
      {
        name: "strict_tool",
        description: "requires a label field",
        inputSchema: {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
          additionalProperties: false,
        },
      },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    // Call with missing required field — should fail AJV, NOT consume the token
    const invalidWaiter = waitFor(ws, (m) => m.id === 100);
    send(ws, {
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "strict_tool", arguments: {} },
    });
    const invalidResp = await invalidWaiter;
    expect((invalidResp.error as any)?.code).toBe(-32602); // INVALID_PARAMS, not rate limit

    // The token was not consumed, so this valid call must succeed
    const validWaiter = waitFor(ws, (m) => m.id === 101);
    send(ws, {
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: { name: "strict_tool", arguments: { label: "hello" } },
    });
    const validResp = await validWaiter;
    expect((validResp.error as any)?.code).not.toBe(-32004);
    expect(validResp.result).toBeDefined();
  });

  it("shared bucket drains across sessions — prevents bypass via session cycling", async () => {
    // Two independent transports sharing one bucket: after session 1 exhausts the
    // limit, session 2 must also be rate-limited (not start with a full bucket).
    const LIMIT = 2;
    const { ws: ws1, transport: t1 } = await setup(LIMIT);
    const { ws: ws2, transport: t2 } = await setup(LIMIT);

    // Wire both transports to the same bucket
    const sharedBucket = { tokens: LIMIT, lastRefill: Date.now() };
    t1.setSharedToolRateLimitBucket(sharedBucket);
    t2.setSharedToolRateLimitBucket(sharedBucket);

    // Session 1 consumes all LIMIT tokens
    const w1 = Array.from({ length: LIMIT }, (_, i) =>
      waitFor(ws1, (m) => m.id === i + 200),
    );
    for (let i = 0; i < LIMIT; i++) {
      send(ws1, {
        jsonrpc: "2.0",
        id: i + 200,
        method: "tools/call",
        params: { name: "ping_tool", arguments: {} },
      });
    }
    const r1 = await Promise.all(w1);
    expect(r1.every((r) => (r.error as any)?.code !== -32004)).toBe(true);

    // Session 2 must now be rate-limited because the shared bucket is empty
    const w2 = waitFor(ws2, (m) => m.id === 300);
    send(ws2, {
      jsonrpc: "2.0",
      id: 300,
      method: "tools/call",
      params: { name: "ping_tool", arguments: {} },
    });
    const r2 = await w2;
    expect((r2.error as any)?.code).toBe(-32004);
  });
});
