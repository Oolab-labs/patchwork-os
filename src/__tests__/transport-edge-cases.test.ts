import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";
import { assertNoMessage, send, waitFor } from "./wsHelpers.js";

const logger = new Logger(false);
let server: Server | null = null;
let transport: McpTransport | null = null;
let wsClient: WebSocket | null = null;

async function setup(
  token: string,
  registerTools?: (t: McpTransport) => void,
): Promise<{ port: number; ws: WebSocket }> {
  server = new Server(token, logger);
  transport = new McpTransport(logger);
  registerTools?.(transport);

  server.on("connection", (ws: WebSocket) => {
    transport?.attach(ws);
  });

  const port = await server.findAndListen(null);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { "x-claude-code-ide-authorization": token },
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  // Perform the MCP initialization handshake
  send(ws, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  await waitFor(ws, (m) => m.id === 0);
  send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((r) => setTimeout(r, 10));

  wsClient = ws;
  return { port, ws };
}

afterEach(async () => {
  vi.useRealTimers();
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.close();
  }
  wsClient = null;
  await server?.close();
  server = null;
  transport = null;
});

// ── Generation guard: stale ws1 does not respond after ws2 attaches ───────────

describe("McpTransport: generation guard", () => {
  it("ws1 receives no response after ws2 attaches (new generation)", async () => {
    const token = "gen-guard-test";
    server = new Server(token, logger);
    transport = new McpTransport(logger);

    // Register a slow tool that never resolves during this test
    transport.registerTool(
      {
        name: "slowTool",
        description: "Never resolves during test",
        inputSchema: { type: "object", properties: {} },
      },
      async (_args, signal) =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );

    // Attach each new connection
    server.on("connection", (ws: WebSocket) => {
      transport?.attach(ws);
    });

    const port = await server.findAndListen(null);

    // Connect ws1 and initialize
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": token },
    });
    await new Promise<void>((resolve, reject) => {
      ws1.on("open", resolve);
      ws1.on("error", reject);
    });
    send(ws1, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    await waitFor(ws1, (m) => m.id === 0);
    send(ws1, { jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 10));

    // Start the slow tool on ws1 — it will never respond during this test
    send(ws1, {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "slowTool", arguments: {} },
    });
    // Give handler time to start
    await new Promise((r) => setTimeout(r, 50));

    // Wait past rate limit window
    await new Promise((r) => setTimeout(r, 1100));

    // Connect ws2 — this increments generation, making ws1 stale
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": token },
    });
    await new Promise<void>((resolve, reject) => {
      ws2.on("open", resolve);
      ws2.on("error", reject);
    });
    wsClient = ws2;

    // ws1 should receive NO response for its tool call (generation mismatch)
    await assertNoMessage(ws1, (m) => m.id === 42, 500);

    // ws2 can do a fresh initialize + tools/list successfully
    send(ws2, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    await waitFor(ws2, (m) => m.id === 0);
    send(ws2, { jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 10));

    send(ws2, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp = await waitFor(ws2, (m) => m.id === 1);
    expect(resp.error).toBeUndefined();

    ws1.close();
  });
});

// ── Zombie tool: completes after timeout, triggers logger.warn ────────────────

describe("McpTransport: zombie tool", () => {
  it("logs a warning when a timed-out tool resolves late", async () => {
    let resolveZombie!: () => void;
    const zombieGate = new Promise<void>((r) => {
      resolveZombie = r;
    });

    const { ws } = await setup("zombie-tool-test", (t) => {
      t.registerTool(
        {
          name: "zombie",
          description: "Ignores abort, resolves late",
          inputSchema: { type: "object", properties: {} },
        },
        async () => {
          // Wait until explicitly released — ignores signal / abort
          await zombieGate;
          return { content: [{ type: "text", text: "I am a zombie" }] };
        },
        100, // 100ms timeout — will time out quickly
      );
    });

    // Spy on logger warn
    const warnSpy = vi.spyOn(logger, "warn");

    // Call the tool — it will time out
    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "zombie", arguments: {} },
    });

    // Wait for timeout error response
    const resp = await waitFor(ws, (m) => m.id === 1, 3000);
    const result = resp.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/timed out/i);

    // Now release the zombie — it will complete after timeout
    resolveZombie();

    // Wait for the zombie to complete and logger.warn to be called
    await new Promise((r) => setTimeout(r, 200));

    // The zombie's late completion should have triggered a warn log
    const zombieWarnCalled = warnSpy.mock.calls.some(([msg]) =>
      typeof msg === "string" && msg.toLowerCase().includes("zombie"),
    );
    expect(zombieWarnCalled).toBe(true);

    warnSpy.mockRestore();
  });
});

// ── Abort signal via notifications/cancelled ──────────────────────────────────

describe("McpTransport: abort signal", () => {
  it("abort signal fires when notifications/cancelled is sent", async () => {
    let signalAborted = false;
    let resolveAbort!: () => void;
    const abortPromise = new Promise<void>((r) => {
      resolveAbort = r;
    });

    const { ws } = await setup("abort-signal-test", (t) => {
      t.registerTool(
        {
          name: "cancellable",
          description: "Waits for cancellation",
          inputSchema: { type: "object", properties: {} },
        },
        async (_args, signal) => {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              signalAborted = true;
              resolveAbort();
              resolve();
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                signalAborted = true;
                resolveAbort();
                resolve();
              },
              { once: true },
            );
            // Safety: also resolve after 5s so we don't hang
            setTimeout(resolve, 5000);
          });
          return { content: [{ type: "text", text: "done" }] };
        },
      );
    });

    // Start the tool
    send(ws, {
      jsonrpc: "2.0",
      id: 77,
      method: "tools/call",
      params: { name: "cancellable", arguments: {} },
    });

    // Give the handler time to start waiting
    await new Promise((r) => setTimeout(r, 50));

    // Send cancellation notification (no id — it's a notification)
    send(ws, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 77 },
    });

    await abortPromise;
    expect(signalAborted).toBe(true);
  });
});

// ── Double detach ──────────────────────────────────────────────────────────────

describe("McpTransport: double detach", () => {
  it("detach() twice does not throw", () => {
    const t = new McpTransport(new Logger(false));
    expect(() => {
      t.detach();
      t.detach();
    }).not.toThrow();
  });

  it("detach() on fresh transport (never attached) does not throw", () => {
    const t = new McpTransport(new Logger(false));
    expect(() => t.detach()).not.toThrow();
  });

  it("detach() after attach + detach does not throw", async () => {
    const { ws } = await setup("double-detach-after-attach");
    transport?.detach();
    expect(() => transport?.detach()).not.toThrow();
    void ws;
  });
});

// ── Tools call before initialize ──────────────────────────────────────────────

describe("McpTransport: uninitialized guard", () => {
  it("tools/call before initialize returns INVALID_REQUEST", async () => {
    const token = "uninit-guard-test";
    server = new Server(token, logger);
    transport = new McpTransport(logger);
    transport.registerTool(
      {
        name: "testTool",
        description: "test",
        inputSchema: { type: "object", properties: {} },
      },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    server.on("connection", (ws: WebSocket) => {
      transport?.attach(ws);
    });

    const port = await server.findAndListen(null);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": token },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    wsClient = ws;

    // Send tools/call WITHOUT initializing first
    send(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "testTool", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 1, 3000);

    expect(resp.result).toBeUndefined();
    const err = resp.error as { code: number; message: string };
    expect(err.code).toBeDefined();
    expect(err.message).toMatch(/not initialized/i);
  });
});
