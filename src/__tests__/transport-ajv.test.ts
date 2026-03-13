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
