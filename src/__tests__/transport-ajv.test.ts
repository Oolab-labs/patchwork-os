import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ErrorCodes } from "../errors.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";
import { send, waitFor } from "./wsHelpers.js";

const logger = new Logger(false);
let server: Server | null = null;
let transport: McpTransport | null = null;
let wsClient: WebSocket | null = null;

const strictSchema = {
  type: "object",
  properties: { x: { type: "number" } },
  additionalProperties: false,
  required: ["x"],
} as const;

async function setup(): Promise<{ ws: WebSocket }> {
  server = new Server("ajv-test-token", logger);
  transport = new McpTransport(logger);

  transport.registerTool(
    {
      name: "strict_tool",
      description: "A tool with strict schema validation",
      inputSchema: strictSchema,
    },
    async (args) => ({
      content: [{ type: "text", text: `x=${args.x}` }],
    }),
  );

  server.on("connection", (ws: WebSocket) => {
    transport?.attach(ws);
  });

  const port = await server.findAndListen(null);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { "x-claude-code-ide-authorization": "ajv-test-token" },
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  send(ws, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  await waitFor(ws, (m) => m.id === 0);
  send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((r) => setTimeout(r, 10));

  wsClient = ws;
  return { ws };
}

afterEach(async () => {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.close();
  }
  wsClient = null;
  await server?.close();
  server = null;
  transport = null;
});

describe("AJV structural schema validation in tools/call", () => {
  it("rejects extra properties (additionalProperties: false)", async () => {
    const { ws } = await setup();

    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "strict_tool", arguments: { x: 1, extra: "bad" } },
    });

    const resp = await waitFor(ws, (m) => m.id === 1);
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(resp.error.message).toMatch(/Invalid tool arguments/);
  });

  it("rejects wrong type for required property", async () => {
    const { ws } = await setup();

    send(ws, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "strict_tool", arguments: { x: "notanumber" } },
    });

    const resp = await waitFor(ws, (m) => m.id === 2);
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(resp.error.message).toMatch(/Invalid tool arguments/);
  });

  it("passes valid arguments through to the handler", async () => {
    const { ws } = await setup();

    send(ws, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "strict_tool", arguments: { x: 42 } },
    });

    const resp = await waitFor(ws, (m) => m.id === 3);
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("x=42");
  });
});

/**
 * Minimal stand-in for the Streamable HTTP adapter's WebSocket-shaped
 * interface (readyState/bufferedAmount/send/EventEmitter) — just enough for
 * McpTransport.attach()/safeSend() to work, without a real socket.
 */
class FakeWs extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

async function waitForSentCount(
  fakeWs: FakeWs,
  n: number,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (fakeWs.sent.length < n) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${n} sent messages`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("attach() message threading — pre-parsed object (Streamable HTTP path)", () => {
  it("still enforces the 1MB tool-argument size limit when fed an already-parsed object instead of a Buffer", async () => {
    const t = new McpTransport(logger);
    t.registerTool(
      {
        name: "echo_tool",
        description: "Echoes its arguments",
        inputSchema: { type: "object", additionalProperties: true },
      },
      async (args) => ({
        content: [{ type: "text", text: JSON.stringify(args) }],
      }),
    );

    const fakeWs = new FakeWs();
    t.attach(fakeWs as unknown as WebSocket);

    // Same handshake sequence real clients send, but delivered as parsed
    // objects (not Buffers) — exactly what streamableHttp.ts's HttpAdapter
    // now passes to this listener instead of re-encoding + re-parsing.
    fakeWs.emit("message", {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {},
    });
    await waitForSentCount(fakeWs, 1);
    fakeWs.emit("message", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const oversized = "x".repeat(1_100_000);
    fakeWs.emit("message", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo_tool", arguments: { big: oversized } },
    });
    await waitForSentCount(fakeWs, 2);

    const resp = JSON.parse(fakeWs.sent[fakeWs.sent.length - 1] ?? "{}");
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(resp.error.message).toMatch(/exceed 1 MB size limit/);
  });

  it("still allows normal-sized arguments through the same pre-parsed-object path", async () => {
    const t = new McpTransport(logger);
    t.registerTool(
      {
        name: "echo_tool",
        description: "Echoes its arguments",
        inputSchema: { type: "object", additionalProperties: true },
      },
      async (args) => ({
        content: [{ type: "text", text: JSON.stringify(args) }],
      }),
    );

    const fakeWs = new FakeWs();
    t.attach(fakeWs as unknown as WebSocket);

    fakeWs.emit("message", {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {},
    });
    await waitForSentCount(fakeWs, 1);
    fakeWs.emit("message", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    fakeWs.emit("message", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo_tool", arguments: { hello: "world" } },
    });
    await waitForSentCount(fakeWs, 2);

    const resp = JSON.parse(fakeWs.sent[fakeWs.sent.length - 1] ?? "{}");
    expect(resp.error).toBeUndefined();
    expect(resp.result?.content?.[0]?.text).toContain("world");
  });
});
