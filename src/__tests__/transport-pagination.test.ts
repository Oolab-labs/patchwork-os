import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";
import { send, waitFor } from "./wsHelpers.js";

const logger = new Logger(false);
let server: Server | null = null;
let transport: McpTransport | null = null;
let wsClient: WebSocket | null = null;

async function setup(): Promise<{ ws: WebSocket }> {
  server = new Server("pagination-token", logger);
  transport = new McpTransport(logger);

  // Register 210 fake tools (PAGE_SIZE=200, so page 1 = 200, page 2 = 10)
  for (let i = 0; i < 210; i++) {
    const name = `fake_tool_${String(i).padStart(3, "0")}`;
    transport.registerTool(
      {
        name,
        description: `Fake tool ${i}`,
        inputSchema: { type: "object", properties: {} },
      },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
  }

  server.on("connection", (ws: WebSocket) => {
    transport?.attach(ws);
  });

  const port = await server.findAndListen(null);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { "x-claude-code-ide-authorization": "pagination-token" },
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  // MCP handshake
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

describe("tools/list pagination", () => {
  it("first page returns 200 tools and a nextCursor", async () => {
    const { ws } = await setup();

    send(ws, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp = await waitFor(ws, (m) => m.id === 1);

    expect(resp.error).toBeUndefined();
    const result = resp.result as { tools: unknown[]; nextCursor?: string };
    expect(result.tools).toHaveLength(200);
    expect(typeof result.nextCursor).toBe("string");
    expect(result.nextCursor!.length).toBeGreaterThan(0);
  });

  it("second page (using nextCursor) returns remaining 10 tools and no nextCursor", async () => {
    const { ws } = await setup();

    // Page 1
    send(ws, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const page1 = await waitFor(ws, (m) => m.id === 2);
    const cursor = (page1.result as { nextCursor: string }).nextCursor;

    // Page 2
    send(ws, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { cursor },
    });
    const page2 = await waitFor(ws, (m) => m.id === 3);

    expect(page2.error).toBeUndefined();
    const result = page2.result as {
      tools: unknown[];
      nextCursor?: string;
    };
    expect(result.tools).toHaveLength(10);
    expect(result.nextCursor).toBeUndefined();
  });

  it("malformed cursor falls back to first page (200 tools, no error)", async () => {
    const { ws } = await setup();

    send(ws, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
      params: { cursor: "!!!notbase64!!!" },
    });
    const resp = await waitFor(ws, (m) => m.id === 4);

    expect(resp.error).toBeUndefined();
    const result = resp.result as { tools: unknown[]; nextCursor?: string };
    expect(result.tools).toHaveLength(200);
    expect(typeof result.nextCursor).toBe("string");
  });
});
