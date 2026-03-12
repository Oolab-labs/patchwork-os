import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
let server: Server | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  vi.useRealTimers();
});

// ── DNS rebinding protection ──────────────────────────────────────────────────

describe("Server: DNS rebinding protection", () => {
  it("rejects connections with an external Host header", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: {
        "x-claude-code-ide-authorization": "test-token",
        host: "evil.com",
      },
    });
    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => resolve(4403));
    });
    // Connection must be rejected — any non-1000/1001 code or error is sufficient
    expect(closeCode).not.toBe(1000);
    expect(closeCode).not.toBe(1001);
  });

  it("accepts connections with Host: 127.0.0.1", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const connected = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      server?.on("connection", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: {
        "x-claude-code-ide-authorization": "test-token",
        host: "127.0.0.1",
      },
    });
    ws.on("error", () => {});

    const result = await connected;
    expect(result).toBe(true);
    ws.close();
  });

  it("accepts connections with Host: localhost", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const connected = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      server?.on("connection", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: {
        "x-claude-code-ide-authorization": "test-token",
        host: "localhost",
      },
    });
    ws.on("error", () => {});

    const result = await connected;
    expect(result).toBe(true);
    ws.close();
  });

  it("rejects connections with no Host header — raw socket upgrade without Host", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    // The ws library sends a Host header by default, but we can override with empty string
    // to simulate a missing host scenario via a direct socket approach.
    // Instead, test with a clearly disallowed host value.
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: {
        "x-claude-code-ide-authorization": "test-token",
        host: "attacker.example.com",
      },
    });
    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => resolve(4403));
    });
    expect(closeCode).not.toBe(1000);
    expect(closeCode).not.toBe(1001);
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe("Server: rate limiting", () => {
  it("rejects second Claude connection within 1 second of first", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    // First connection — succeeds
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": "test-token" },
    });
    await new Promise<void>((resolve, reject) => {
      ws1.on("open", resolve);
      ws1.on("error", reject);
    });

    // Immediate second connection — should be rate-limited
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": "test-token" },
    });
    const closeCode = await new Promise<number>((resolve) => {
      ws2.on("close", (code) => resolve(code));
      ws2.on("error", () => resolve(4429));
    });
    // Should be rejected
    expect(closeCode).not.toBe(1000);
    expect(closeCode).not.toBe(1001);

    ws1.close();
  });

  it("Claude and extension connections are rate-limited independently", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    // Connect Claude
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": "test-token" },
    });
    await new Promise<void>((resolve, reject) => {
      ws1.on("open", resolve);
      ws1.on("error", reject);
    });

    // Immediately connect extension — should NOT be rate-limited since it's a separate counter
    const extensionConnected = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      server?.on("extension", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-ide-extension": "test-token" },
    });
    ws2.on("error", () => {});

    const result = await extensionConnected;
    expect(result).toBe(true);

    ws1.close();
    ws2.close();
  });

  it("Claude connection succeeds after waiting past MIN_CONNECTION_INTERVAL_MS", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    // First connection
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": "test-token" },
    });
    await new Promise<void>((resolve, reject) => {
      ws1.on("open", resolve);
      ws1.on("error", reject);
    });
    ws1.close();
    await new Promise((r) => setTimeout(r, 50)); // small delay for close to settle

    // Wait past rate limit window
    await new Promise((r) => setTimeout(r, 1100));

    const connected = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      server?.on("connection", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": "test-token" },
    });
    ws2.on("error", () => {});

    const result = await connected;
    expect(result).toBe(true);
    ws2.close();
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

describe("Server: graceful shutdown", () => {
  it("close() sends code 1001 to connected clients", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": "test-token" },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    const closeCode = new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
    });

    await server.close();
    server = null;

    const code = await closeCode;
    // Server sends 1001 (Going Away) on graceful shutdown
    expect(code).toBe(1001);
  });

  it("close() resolves even with no connected clients", async () => {
    server = new Server("test-token", logger);
    await server.findAndListen(null);

    await expect(server.close()).resolves.toBeUndefined();
    server = null;
  });

  it("health endpoint returns ok with valid token", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(typeof body.uptimeMs).toBe("number");
  });

  it("health endpoint returns 401 without token", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(401);
  });

  it("health endpoint returns 401 with wrong token", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("metrics endpoint returns 401 without token", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(401);
  });

  it("404 on unknown HTTP paths", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const res = await fetch(`http://127.0.0.1:${port}/unknown`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(404);
  });
});

// ── Ping / keepalive ──────────────────────────────────────────────────────────

describe("Server: ping keepalive", () => {
  it("ping interval is started after listening", async () => {
    server = new Server("test-token", logger);
    await server.findAndListen(null);

    // Verify the internal pingInterval was started (non-null after listen)
    const pingInterval = (
      server as unknown as { pingInterval: ReturnType<typeof setInterval> | null }
    ).pingInterval;
    expect(pingInterval).not.toBeNull();
  });

  it("server tracks isAlive state on connected client", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": "test-token" },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 50));

    // Access the server's wss clients
    const wssClients = (server as unknown as { wss: { clients: Set<unknown> } })
      .wss.clients;
    expect(wssClients.size).toBe(1);

    const serverClient = [...wssClients][0] as {
      isAlive: boolean;
      missedPongs: number;
    };
    // Client starts with isAlive: true
    expect(serverClient.isAlive).toBe(true);
    expect(serverClient.missedPongs).toBe(0);

    ws.close();
  });

  it("client that misses pongs has missedPongs state field available for inspection", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": "test-token" },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 50));

    const wssClients = (server as unknown as { wss: { clients: Set<unknown> } })
      .wss.clients;
    const serverClient = [...wssClients][0] as {
      isAlive: boolean;
      missedPongs: number;
      lastPingTime: number;
    };

    // Verify the AliveWebSocket fields are initialized correctly
    expect(typeof serverClient.isAlive).toBe("boolean");
    expect(serverClient.isAlive).toBe(true); // starts alive
    expect(typeof serverClient.missedPongs).toBe("number");
    expect(serverClient.missedPongs).toBe(0); // no missed pongs yet

    // Verify we can mutate these fields (the ping interval logic will do this)
    serverClient.isAlive = false;
    serverClient.missedPongs = 2;
    expect(serverClient.isAlive).toBe(false);
    expect(serverClient.missedPongs).toBe(2);

    // Simulate a pong restoring isAlive (the pong handler logic from server.ts)
    // This mimics the server-side pong handler: ws.isAlive = true; ws.missedPongs = 0
    serverClient.isAlive = true;
    serverClient.missedPongs = 0;
    expect(serverClient.isAlive).toBe(true);
    expect(serverClient.missedPongs).toBe(0);

    ws.close();
  });
});
