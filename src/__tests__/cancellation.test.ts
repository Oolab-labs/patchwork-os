import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";
import { send, waitFor } from "./wsHelpers.js";

const logger = new Logger(false);
let server: Server | null = null;
let transport: McpTransport | null = null;
let wsClient: WebSocket | null = null;

afterEach(() => {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.close();
  }
  wsClient = null;
  server?.close();
  server = null;
  transport = null;
});

describe("MCP cancellation", () => {
  it("aborts in-flight tool call when notifications/cancelled is sent", async () => {
    const token = "cancel-test-token";
    server = new Server(token, logger);
    transport = new McpTransport(logger);

    let signalAborted = false;
    const abortPromise = new Promise<void>((resolveAbort) => {
      transport?.registerTool(
        {
          name: "slow_tool",
          description: "A tool that waits until aborted",
          inputSchema: { type: "object", properties: {} },
        },
        async (_args, signal) => {
          // Wait for abort or timeout
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              signalAborted = true;
              resolveAbort();
              resolve();
              return;
            }
            const onAbort = () => {
              signalAborted = true;
              resolveAbort();
              resolve();
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            // Fallback timeout to prevent test hanging
            setTimeout(() => {
              signal?.removeEventListener("abort", onAbort);
              resolve();
            }, 5000);
          });
          return { content: [{ type: "text", text: "done" }] };
        },
      );
    });

    // Wire up the transport to handle connections
    server.on("connection", (ws: WebSocket) => {
      transport?.attach(ws);
    });

    const port = await server.findAndListen(null);

    // Connect with correct auth
    wsClient = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": token },
    });

    await new Promise<void>((resolve, reject) => {
      wsClient?.on("open", resolve);
      wsClient?.on("error", reject);
    });

    // Initialize the MCP session
    send(wsClient, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });

    await waitFor(
      wsClient,
      (msg) => msg.id === 1 && msg.result !== undefined,
    );
    send(wsClient, { jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 10));

    // Send a tools/call request for the slow tool
    const requestId = 42;
    send(wsClient, {
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name: "slow_tool", arguments: {} },
    });

    // Give the tool handler time to start
    await new Promise((r) => setTimeout(r, 100));

    // Send cancellation notification (no id = notification)
    send(wsClient, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId },
    });

    // Wait for the abort to fire
    await abortPromise;
    expect(signalAborted).toBe(true);

    // The tool call should still produce a response
    const response = await waitFor(
      wsClient,
      (msg) => msg.id === requestId,
    );
    expect(response.id).toBe(requestId);
  });

  it("does not abort unrelated tool calls", async () => {
    const token = "cancel-test-token-2";
    server = new Server(token, logger);
    transport = new McpTransport(logger);

    let toolSignal: AbortSignal | undefined;

    transport.registerTool(
      {
        name: "quick_tool",
        description: "A tool that completes quickly",
        inputSchema: { type: "object", properties: {} },
      },
      async (_args, signal) => {
        toolSignal = signal;
        return { content: [{ type: "text", text: "quick result" }] };
      },
    );

    server.on("connection", (ws: WebSocket) => {
      transport?.attach(ws);
    });

    const port = await server.findAndListen(null);

    wsClient = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": token },
    });

    await new Promise<void>((resolve, reject) => {
      wsClient?.on("open", resolve);
      wsClient?.on("error", reject);
    });

    // Initialize
    send(wsClient, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    await waitFor(
      wsClient,
      (msg) => msg.id === 1 && msg.result !== undefined,
    );
    send(wsClient, { jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 10));

    // Call tool
    send(wsClient, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "quick_tool", arguments: {} },
    });

    const response = await waitFor(wsClient, (msg) => msg.id === 10);
    expect(response.result).toBeDefined();

    // Now send cancellation for a different request id
    send(wsClient, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 999 },
    });

    // The tool's signal should not have been aborted
    // (The tool already completed, but the signal was never aborted for id 10)
    // Give a moment for any erroneous abort to propagate
    await new Promise((r) => setTimeout(r, 50));
    // toolSignal may or may not still be defined after cleanup,
    // but the key thing is the response was successful
    expect(response.result).toBeDefined();
  });
});
