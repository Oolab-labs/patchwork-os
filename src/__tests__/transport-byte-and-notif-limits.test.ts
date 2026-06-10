/**
 * http-server-3: META_SIZE_HINT_THRESHOLD (50 KB) was compared against
 * item.text.length (UTF-16 code units), not byte length. For CJK/emoji a
 * result well over 50 KB of UTF-8 bytes failed to get the
 * `_meta["anthropic/maxResultSizeChars"]` persistence hint.
 *
 * http-server-4: the notification rate limiter dropped the Nth notification
 * (>= check after a pre-increment), so only N-1 passed per window instead of
 * the documented N (500).
 */

import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { McpTransport } from "../transport.js";

interface McpMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  _meta?: Record<string, unknown>;
}

class MockWs {
  readyState = 1; // OPEN
  sent: string[] = [];
  handlers: Record<string, (arg: unknown) => void> = {};
  on(event: string, fn: (arg: unknown) => void) {
    this.handlers[event] = fn;
    return this;
  }
  off(event: string, _fn: unknown) {
    delete this.handlers[event];
    return this;
  }
  removeListener(event: string, _fn: unknown) {
    delete this.handlers[event];
    return this;
  }
  send(data: string, cb?: (err?: Error) => void) {
    this.sent.push(data);
    if (cb) cb();
  }
  close() {
    this.readyState = 3;
  }
  ping() {}
  pong() {}
  addEventListener(event: string, fn: (arg: unknown) => void) {
    this.on(event, fn);
  }
  terminate() {
    this.close();
  }
}

class CapturingLogger extends Logger {
  warnings: string[] = [];
  constructor() {
    super(false);
  }
  override warn(msg: string): void {
    this.warnings.push(msg);
  }
}

function handshake(transport: McpTransport) {
  const ws = new MockWs();
  transport.attach(ws as unknown as import("ws").WebSocket);
  const send = (msg: McpMessage) =>
    ws.handlers.message?.(Buffer.from(JSON.stringify(msg)));
  send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { ws, send };
}

async function waitForReply(ws: MockWs, id: string | number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    for (const raw of ws.sent) {
      try {
        const parsed = JSON.parse(raw) as McpMessage;
        if (parsed.id === id) return parsed;
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for reply id=${id}`);
}

afterEach(() => {
  /* transports are GC'd; nothing to close (MockWs) */
});

describe("META size hint uses UTF-8 byte length (http-server-3)", () => {
  it("injects _meta for a result over 50 KB of UTF-8 bytes but under 50K UTF-16 chars", async () => {
    const transport = new McpTransport(new Logger(false));
    // 20,000 CJK chars: 20,000 UTF-16 code units (under the 50,000 threshold)
    // but 60,000 UTF-8 bytes (over it). Pre-fix `.length` saw 20,000 → no hint.
    const cjk = "中".repeat(20_000);
    expect(cjk.length).toBeLessThan(50_000);
    expect(Buffer.byteLength(cjk, "utf8")).toBeGreaterThan(50_000);

    transport.registerTool(
      {
        name: "bigCjk",
        description: "returns a big CJK string",
        inputSchema: { type: "object", properties: {} },
      },
      async () => ({ content: [{ type: "text", text: cjk }] }),
    );

    const { ws, send } = handshake(transport);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "bigCjk", arguments: {} },
    });
    const reply = await waitForReply(ws, 1);
    const result = reply.result as {
      _meta?: { "anthropic/maxResultSizeChars"?: number };
    };
    expect(result._meta?.["anthropic/maxResultSizeChars"]).toBe(
      Buffer.byteLength(cjk, "utf8"),
    );
  });

  it("does NOT inject _meta for a small ASCII result", async () => {
    const transport = new McpTransport(new Logger(false));
    transport.registerTool(
      {
        name: "smol",
        description: "small result",
        inputSchema: { type: "object", properties: {} },
      },
      async () => ({ content: [{ type: "text", text: "hello" }] }),
    );
    const { ws, send } = handshake(transport);
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "smol", arguments: {} },
    });
    const reply = await waitForReply(ws, 2);
    const result = reply.result as { _meta?: unknown };
    expect(result._meta).toBeUndefined();
  });
});

describe("notification rate limiter off-by-one (http-server-4)", () => {
  it("allows exactly NOTIFICATION_RATE_LIMIT (500) notifications per window", async () => {
    const logger = new CapturingLogger();
    const transport = new McpTransport(logger);
    const { send } = handshake(transport);

    // The handshake already sent one notification (notifications/initialized),
    // so reset the per-connection counters to measure a clean window.
    const internals = transport as unknown as {
      notifCount: number;
      notifWindowStart: number;
    };
    internals.notifCount = 0;
    internals.notifWindowStart = Date.now();
    logger.warnings.length = 0;

    // Send exactly 500 benign notifications. None should be dropped.
    for (let i = 0; i < 500; i++) {
      send({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} });
    }
    const rateWarnings = () =>
      logger.warnings.filter((w) => w.includes("rate limit exceeded"));
    expect(rateWarnings()).toHaveLength(0);

    // The 501st must be dropped (one rate-limit warning).
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} });
    expect(rateWarnings()).toHaveLength(1);
  });
});
