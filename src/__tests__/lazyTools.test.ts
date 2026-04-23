/**
 * Tests for --lazy-tools mode and tools/schema endpoint in McpTransport.
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

let _counter = 0;

function padToken(t: string): string {
  return t.padEnd(32, "0");
}

interface SetupOpts {
  lazyTools?: boolean;
}

async function setup(
  opts: SetupOpts = {},
): Promise<{ ws: WebSocket; transport: McpTransport }> {
  const token = padToken(`lazy-tools-${++_counter}`);
  const server = new Server(token, logger);
  const transport = new McpTransport(logger);

  if (opts.lazyTools) transport.setLazyTools(true);

  // Register a sample tool with a non-trivial inputSchema
  transport.registerTool(
    {
      name: "myTool",
      description: "A test tool",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "A message" },
        },
        required: ["message"],
        additionalProperties: false,
      },
    },
    async (args) => ({
      content: [{ type: "text", text: `echo: ${args.message}` }],
    }),
  );

  // Second tool without outputSchema
  transport.registerTool(
    {
      name: "anotherTool",
      description: "Another test tool",
      inputSchema: {
        type: "object",
        properties: { count: { type: "number" } },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { result: { type: "number" } },
      },
    },
    async () => ({ content: [{ type: "text", text: "done" }] }),
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

describe("McpTransport — tools/list (lazyTools: false, default)", () => {
  it("includes inputSchema in tools/list response", async () => {
    const { ws } = await setup({ lazyTools: false });

    send(ws, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp = await waitFor(ws, (m) => m.id === 1);

    expect(resp.result.tools).toBeDefined();
    const myTool = resp.result.tools.find(
      (t: { name: string }) => t.name === "myTool",
    );
    expect(myTool).toBeDefined();
    expect(myTool.inputSchema).toBeDefined();
    expect(myTool.inputSchema.properties.message).toBeDefined();
  });
});

describe("McpTransport — tools/list (lazyTools: true)", () => {
  it("omits inputSchema from tools/list response", async () => {
    const { ws } = await setup({ lazyTools: true });

    send(ws, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp = await waitFor(ws, (m) => m.id === 1);

    expect(resp.result.tools).toBeDefined();
    const myTool = resp.result.tools.find(
      (t: { name: string }) => t.name === "myTool",
    );
    expect(myTool).toBeDefined();
    expect(myTool.name).toBe("myTool");
    expect(myTool.description).toBeDefined();
    // inputSchema must be absent in lazy mode
    expect(myTool.inputSchema).toBeUndefined();
  });

  it("still returns name and description in lazy mode", async () => {
    const { ws } = await setup({ lazyTools: true });

    send(ws, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const resp = await waitFor(ws, (m) => m.id === 2);

    for (const tool of resp.result.tools as Array<{
      name: string;
      description: string;
      inputSchema?: unknown;
    }>) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeUndefined();
    }
  });
});

describe("McpTransport — tools/schema endpoint", () => {
  it("returns full schema for a known tool (lazy mode off)", async () => {
    const { ws } = await setup({ lazyTools: false });

    send(ws, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/schema",
      params: { name: "myTool" },
    });
    const resp = await waitFor(ws, (m) => m.id === 10);

    expect(resp.result).toBeDefined();
    expect(resp.result.name).toBe("myTool");
    expect(resp.result.description).toBe("A test tool");
    expect(resp.result.inputSchema).toBeDefined();
    expect(resp.result.inputSchema.properties.message).toBeDefined();
    // outputSchema not declared on myTool
    expect(resp.result.outputSchema).toBeUndefined();
  });

  it("returns full schema for a known tool (lazy mode on)", async () => {
    const { ws } = await setup({ lazyTools: true });

    send(ws, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/schema",
      params: { name: "myTool" },
    });
    const resp = await waitFor(ws, (m) => m.id === 11);

    expect(resp.result).toBeDefined();
    expect(resp.result.name).toBe("myTool");
    expect(resp.result.inputSchema).toBeDefined();
  });

  it("returns outputSchema when declared", async () => {
    const { ws } = await setup({ lazyTools: false });

    send(ws, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/schema",
      params: { name: "anotherTool" },
    });
    const resp = await waitFor(ws, (m) => m.id === 12);

    expect(resp.result.outputSchema).toBeDefined();
    expect(resp.result.outputSchema.properties.result).toBeDefined();
  });

  it("returns METHOD_NOT_FOUND (-32601) for unknown tool name", async () => {
    const { ws } = await setup();

    send(ws, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/schema",
      params: { name: "nonExistentTool" },
    });
    const resp = await waitFor(ws, (m) => m.id === 20);

    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(-32601);
    expect(resp.error.message).toContain("nonExistentTool");
  });

  it("returns INVALID_PARAMS (-32602) when name is missing", async () => {
    const { ws } = await setup();

    send(ws, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/schema",
      params: {},
    });
    const resp = await waitFor(ws, (m) => m.id === 21);

    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(-32602);
  });
});

describe("McpTransport — tools/call validates args even in lazy mode", () => {
  it("rejects invalid args with INVALID_PARAMS when lazyTools is true", async () => {
    const { ws } = await setup({ lazyTools: true });

    // Call myTool without required 'message' field
    send(ws, {
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "myTool", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 30);

    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(-32602); // INVALID_PARAMS
  });

  it("executes tool with valid args even when lazyTools is true", async () => {
    const { ws } = await setup({ lazyTools: true });

    send(ws, {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "myTool", arguments: { message: "hello" } },
    });
    const resp = await waitFor(ws, (m) => m.id === 31);

    expect(resp.result).toBeDefined();
    expect(resp.result.content[0].text).toBe("echo: hello");
  });
});
