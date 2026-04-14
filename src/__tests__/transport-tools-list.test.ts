/**
 * Tests for tools/list cursor pagination in McpTransport.
 *
 * Page size is 200 (TOOLS_LIST_PAGE_SIZE). Tests register 201+ tools
 * to exercise the cursor path without touching production constants.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";
import { send, waitFor } from "./wsHelpers.js";

const PAGE_SIZE = 200; // must match TOOLS_LIST_PAGE_SIZE in transport.ts

const logger = new Logger(false);
const servers: Server[] = [];
const clients: WebSocket[] = [];

let _counter = 0;

function padToken(t: string): string {
  return t.padEnd(32, "0");
}

async function setup(
  toolCount: number,
): Promise<{ ws: WebSocket; transport: McpTransport }> {
  const token = padToken(`tools-list-${++_counter}`);
  const server = new Server(token, logger);
  const transport = new McpTransport(logger);

  for (let i = 0; i < toolCount; i++) {
    transport.registerTool(
      {
        name: `tool_${i}`,
        description: `tool ${i}`,
        inputSchema: { type: "object", properties: {} },
      },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
  }

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

describe("McpTransport — tools/list pagination", () => {
  it("returns all tools on page 1 when count <= PAGE_SIZE", async () => {
    const { ws } = await setup(PAGE_SIZE);
    const waiter = waitFor(ws, (m) => m.id === 1);
    send(ws, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp = await waiter;
    expect(resp.result.tools).toHaveLength(PAGE_SIZE);
    expect(resp.result.nextCursor).toBeUndefined();
  });

  it("returns PAGE_SIZE tools and a nextCursor when count > PAGE_SIZE", async () => {
    const { ws } = await setup(PAGE_SIZE + 1);
    const waiter = waitFor(ws, (m) => m.id === 1);
    send(ws, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp = await waiter;
    expect(resp.result.tools).toHaveLength(PAGE_SIZE);
    expect(typeof resp.result.nextCursor).toBe("string");
  });

  it("fetching page 2 with nextCursor returns the remaining tools and no further cursor", async () => {
    const EXTRA = 5;
    const { ws } = await setup(PAGE_SIZE + EXTRA);

    // Page 1
    const w1 = waitFor(ws, (m) => m.id === 1);
    send(ws, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const page1 = await w1;
    const cursor = page1.result.nextCursor as string;
    expect(cursor).toBeDefined();

    // Page 2
    const w2 = waitFor(ws, (m) => m.id === 2);
    send(ws, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: { cursor },
    });
    const page2 = await w2;
    expect(page2.result.tools).toHaveLength(EXTRA);
    expect(page2.result.nextCursor).toBeUndefined();
  });

  it("all pages combined contain every registered tool exactly once", async () => {
    const TOTAL = PAGE_SIZE + 50;
    const { ws } = await setup(TOTAL);

    const allNames: string[] = [];
    let cursor: string | undefined;
    let page = 1;

    do {
      const waiter = waitFor(ws, (m) => m.id === page);
      send(ws, {
        jsonrpc: "2.0",
        id: page,
        method: "tools/list",
        params: cursor !== undefined ? { cursor } : {},
      });
      const resp = await waiter;
      for (const t of resp.result.tools) allNames.push(t.name);
      cursor = resp.result.nextCursor;
      page++;
    } while (cursor !== undefined);

    expect(allNames).toHaveLength(TOTAL);
    expect(new Set(allNames).size).toBe(TOTAL); // no duplicates
  });

  it("malformed cursor falls back to page 1 (not an error)", async () => {
    const { ws } = await setup(PAGE_SIZE + 1);
    const waiter = waitFor(ws, (m) => m.id === 1);
    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { cursor: "not-valid-base64!!!" },
    });
    const resp = await waiter;
    // Falls back to offset=0 — same as first page
    expect(resp.result.tools).toHaveLength(PAGE_SIZE);
    expect(resp.error).toBeUndefined();
  });

  it("cursor pointing beyond the last tool returns empty tools and no nextCursor", async () => {
    const { ws } = await setup(5);

    // Craft a cursor that points past the end (offset = 1000)
    const farCursor = Buffer.from("1000").toString("base64");
    const waiter = waitFor(ws, (m) => m.id === 1);
    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { cursor: farCursor },
    });
    const resp = await waiter;
    expect(resp.result.tools).toHaveLength(0);
    expect(resp.result.nextCursor).toBeUndefined();
  });
});

describe("McpTransport — cache_control passthrough in tools/list", () => {
  it("cache_control is present in tools/list output for annotated tools", async () => {
    const token = padToken(`cache-ctrl-${++_counter}`);
    const server = new Server(token, logger);
    const transport = new McpTransport(logger);

    transport.registerTool(
      {
        name: "annotated_tool",
        description: "has cache_control",
        inputSchema: { type: "object", properties: {} },
        cache_control: { type: "ephemeral" },
      },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    transport.registerTool(
      {
        name: "plain_tool",
        description: "no cache_control",
        inputSchema: { type: "object", properties: {} },
      },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    server.on("connection", (ws: WebSocket) => transport.attach(ws));
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

    const waiter = waitFor(ws, (m) => m.id === 1);
    send(ws, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp = await waiter;

    const tools = resp.result.tools as Array<Record<string, unknown>>;
    const annotated = tools.find((t) => t.name === "annotated_tool");
    const plain = tools.find((t) => t.name === "plain_tool");

    expect(annotated).toBeDefined();
    expect(annotated?.cache_control).toEqual({ type: "ephemeral" });

    expect(plain).toBeDefined();
    expect(plain?.cache_control).toBeUndefined();
  });

  it("extensionRequired and timeoutMs are stripped from wire output", async () => {
    const token = padToken(`strip-fields-${++_counter}`);
    const server = new Server(token, logger);
    const transport = new McpTransport(logger);

    transport.registerTool(
      {
        name: "internal_fields_tool",
        description: "has internal fields",
        inputSchema: { type: "object", properties: {} },
        extensionRequired: true,
        timeoutMs: 5000,
      },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    server.on("connection", (ws: WebSocket) => transport.attach(ws));
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

    const waiter = waitFor(ws, (m) => m.id === 1);
    send(ws, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp = await waiter;

    const tools = resp.result.tools as Array<Record<string, unknown>>;
    const tool = tools.find((t) => t.name === "internal_fields_tool");

    expect(tool).toBeDefined();
    expect(tool?.extensionRequired).toBeUndefined();
    expect(tool?.timeoutMs).toBeUndefined();
  });
});
