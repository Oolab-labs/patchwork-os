import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

describe("Server", () => {
  it("binds to port 0 and returns an assigned port", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it("binds to a preferred port when specified", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(18765);
    expect(port).toBe(18765);
  });

  it("rejects connections with no auth token", async () => {
    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => {}); // suppress error
    });
    // Connection should be rejected — either via HTTP 401 or close
    expect(closeCode).not.toBe(1000);
  });

  it("rejects connections with wrong auth token", async () => {
    server = new Server("correct-token", logger);
    const port = await server.findAndListen(null);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": "wrong-token" },
    });
    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => {});
    });
    expect(closeCode).not.toBe(1000);
  });

  it("accepts connections with correct auth token", async () => {
    server = new Server("correct-token", logger);
    const port = await server.findAndListen(null);

    const connected = new Promise<boolean>((resolve) => {
      server?.on("connection", () => resolve(true));
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": "correct-token" },
    });

    ws.on("error", () => {});

    const result = await connected;
    expect(result).toBe(true);
    ws.close();
  });

  it("uses timing-safe comparison (does not short-circuit on length)", async () => {
    // This is a behavioral test — we can't directly test timing, but we ensure
    // tokens of different lengths are rejected the same way
    server = new Server("abcdefgh", logger);
    const port = await server.findAndListen(null);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": "a" },
    });
    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => {});
    });
    expect(closeCode).not.toBe(1000);
  });
});
