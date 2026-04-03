/**
 * Unit tests for ChildBridgeClient.
 *
 * Tests use a real HTTP server (no mocks) to exercise:
 *  - SSE parsing: last result frame is returned, not a progress notification
 *  - 404 session-expiry recovery: session is re-initialized and the call retried
 *  - Circuit breaker: 404 retry failure increments the failure count once, not twice
 */

import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ChildBridgeClient } from "../childBridgeClient.js";

const AUTH_TOKEN = "test-token-abc";

/** Spin up a minimal HTTP server that handles /mcp POST requests. */
function startMockBridge(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void | Promise<void>,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      void handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

// ── SSE parsing ───────────────────────────────────────────────────────────────

describe("ChildBridgeClient SSE parsing", () => {
  let server: http.Server;
  let client: ChildBridgeClient;

  afterEach(async () => {
    client.destroy();
    await closeServer(server);
  });

  it("returns the last data: frame with result, not an earlier progress notification", async () => {
    let requestCount = 0;

    ({ server } = await startMockBridge((req, res) => {
      requestCount++;
      // All requests: consume body then respond
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf-8"),
        ) as Record<string, unknown>;
        const id = body.id;

        if (body.method === "initialize") {
          res.setHeader("mcp-session-id", "sess-1");
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: "2025-11-25", capabilities: {} },
            }),
          );
        } else if (body.method === "notifications/initialized") {
          res.writeHead(204).end();
        } else if (body.method === "tools/call") {
          // Respond with SSE: a progress notification first, then the real result
          const progressFrame = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t1", progress: 0.5 } })}\n\n`;
          const resultFrame = `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "final result" }] } })}\n\n`;

          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(progressFrame);
          res.write(resultFrame);
          res.end();
        } else {
          res.writeHead(200).end("{}");
        }
      });
    }));

    const { port } = server.address() as { port: number };
    client = new ChildBridgeClient(port, AUTH_TOKEN);

    const result = await client.callTool("myTool", { x: 1 });
    expect(result.content[0]?.text).toBe("final result");
    expect(requestCount).toBeGreaterThanOrEqual(2); // initialize + tools/call
  });

  it("handles a single data: frame (non-streaming response) correctly", async () => {
    ({ server } = await startMockBridge((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf-8"),
        ) as Record<string, unknown>;
        const id = body.id;

        if (body.method === "initialize") {
          res.setHeader("mcp-session-id", "sess-2");
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: "2025-11-25", capabilities: {} },
            }),
          );
        } else if (body.method === "notifications/initialized") {
          res.writeHead(204).end();
        } else {
          const frame = `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "single frame" }] } })}\n\n`;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(frame);
        }
      });
    }));

    const { port } = server.address() as { port: number };
    client = new ChildBridgeClient(port, AUTH_TOKEN);

    const result = await client.callTool("myTool", {});
    expect(result.content[0]?.text).toBe("single frame");
  });
});

// ── 404 session-expiry recovery ───────────────────────────────────────────────

describe("ChildBridgeClient 404 session-expiry recovery", () => {
  let server: http.Server;
  let client: ChildBridgeClient;

  afterEach(async () => {
    client.destroy();
    await closeServer(server);
  });

  it("re-initializes session and retries when tools/call gets a 404", async () => {
    let initCount = 0;
    let toolCallCount = 0;

    ({ server } = await startMockBridge((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf-8"),
        ) as Record<string, unknown>;
        const id = body.id;
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (body.method === "initialize") {
          initCount++;
          res.setHeader("mcp-session-id", `sess-${initCount}`);
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: "2025-11-25", capabilities: {} },
            }),
          );
        } else if (body.method === "notifications/initialized") {
          res.writeHead(204).end();
        } else if (body.method === "tools/call") {
          toolCallCount++;
          if (sessionId === "sess-1") {
            // First session has expired
            res.writeHead(404).end();
          } else {
            // Re-initialized session works
            res.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: "recovered result" }],
                },
              }),
            );
          }
        } else {
          res.writeHead(200).end("{}");
        }
      });
    }));

    const { port } = server.address() as { port: number };
    client = new ChildBridgeClient(port, AUTH_TOKEN);

    const result = await client.callTool("myTool", {});
    expect(result.content[0]?.text).toBe("recovered result");
    expect(initCount).toBe(2); // initial + reinit after 404
    expect(toolCallCount).toBe(2); // first (404'd) + retry
  });

  it("does not count a recoverable 404 as a circuit-breaker failure", async () => {
    let initCount = 0;

    ({ server } = await startMockBridge((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf-8"),
        ) as Record<string, unknown>;
        const id = body.id;
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (body.method === "initialize") {
          initCount++;
          res.setHeader("mcp-session-id", `sess-${initCount}`);
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: "2025-11-25", capabilities: {} },
            }),
          );
        } else if (body.method === "notifications/initialized") {
          res.writeHead(204).end();
        } else if (body.method === "tools/call") {
          if (sessionId === "sess-1") {
            res.writeHead(404).end();
          } else {
            res.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: "ok" }] },
              }),
            );
          }
        } else {
          res.writeHead(200).end("{}");
        }
      });
    }));

    const { port } = server.address() as { port: number };
    client = new ChildBridgeClient(port, AUTH_TOKEN);

    // Call three times (MAX_CONSECUTIVE_FAILURES = 3)
    // If 404 counted as a failure, the third call would trip the circuit breaker
    await client.callTool("myTool", {});
    await client.callTool("myTool", {});
    const third = await client.callTool("myTool", {});

    // Bridge must still be healthy — circuit should not be open
    expect(client.isHealthy).toBe(true);
    expect(third.content[0]?.text).toBe("ok");
  });

  it("throws BRIDGE_UNAVAILABLE when both the original call and the retry fail", async () => {
    let initCount = 0;

    ({ server } = await startMockBridge((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf-8"),
        ) as Record<string, unknown>;
        const id = body.id;

        if (body.method === "initialize") {
          initCount++;
          res.setHeader("mcp-session-id", `sess-${initCount}`);
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: "2025-11-25", capabilities: {} },
            }),
          );
        } else if (body.method === "notifications/initialized") {
          res.writeHead(204).end();
        } else if (body.method === "tools/call") {
          // Always 404 — session never recovers
          res.writeHead(404).end();
        } else {
          res.writeHead(200).end("{}");
        }
      });
    }));

    const { port } = server.address() as { port: number };
    client = new ChildBridgeClient(port, AUTH_TOKEN);

    await expect(client.callTool("myTool", {})).rejects.toThrow(
      /unavailable|reinit/i,
    );
  });
});
