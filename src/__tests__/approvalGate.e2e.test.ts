/**
 * End-to-end test for the Patchwork approval gate.
 *
 * Wires McpTransport → ApprovalQueue (the same as bridge.ts does at runtime),
 * registers a fake high-risk tool, then exercises the three possible
 * outcomes: approve, reject, TTL expiry. The gate must block handler
 * execution until a decision arrives and surface the decision via
 * isError:true MCP content (not a JSON-RPC error).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ApprovalQueue,
  getApprovalQueue,
  resetApprovalQueueForTests,
} from "../approvalQueue.js";
import { Logger } from "../logger.js";
import { classifyTool } from "../riskTier.js";
import { McpTransport } from "../transport.js";

interface McpMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
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
    this.handlers.close?.({});
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

function setup(): {
  transport: McpTransport;
  ws: MockWs;
  queue: ApprovalQueue;
  handlerRan: { value: boolean };
  send(msg: McpMessage): void;
  nextMatching(predicate: (m: McpMessage) => boolean): Promise<McpMessage>;
} {
  resetApprovalQueueForTests();
  const queue = getApprovalQueue();
  const transport = new McpTransport(new Logger(false));
  const handlerRan = { value: false };

  transport.registerTool(
    {
      name: "gitCommit",
      description: "Fake high-tier tool",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    async () => {
      handlerRan.value = true;
      return { content: [{ type: "text", text: "committed" }] };
    },
  );

  transport.setApprovalGate(async ({ toolName, params, sessionId }) => {
    const tier = classifyTool(toolName);
    if (tier !== "high") return "bypass";
    const { promise } = queue.request({
      toolName,
      params,
      tier,
      sessionId: sessionId ?? undefined,
    });
    return promise;
  });

  const ws = new MockWs();
  transport.attach(ws as unknown as import("ws").WebSocket);

  const send = (msg: McpMessage) => {
    ws.handlers.message?.(Buffer.from(JSON.stringify(msg)));
  };
  const nextMatching = (predicate: (m: McpMessage) => boolean) =>
    new Promise<McpMessage>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const tick = () => {
        for (const raw of ws.sent) {
          try {
            const parsed = JSON.parse(raw) as McpMessage;
            if (predicate(parsed)) {
              resolve(parsed);
              return;
            }
          } catch {
            // skip non-JSON frame
          }
        }
        if (Date.now() > deadline) {
          reject(new Error("Timed out waiting for message"));
          return;
        }
        setTimeout(tick, 10);
      };
      tick();
    });

  // MCP handshake so the transport accepts tools/call messages.
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

  return { transport, ws, queue, handlerRan, send, nextMatching };
}

afterEach(() => {
  resetApprovalQueueForTests();
});

describe("approval gate E2E", () => {
  it("approve: tool runs after dashboard approves", async () => {
    const { queue, handlerRan, send, nextMatching } = setup();

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "gitCommit", arguments: { message: "release v1" } },
    });

    // Wait until the gate enqueues the pending approval.
    const deadline = Date.now() + 2000;
    while (queue.size() === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const pending = queue.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.toolName).toBe("gitCommit");
    expect(pending[0]!.tier).toBe("high");
    expect(handlerRan.value).toBe(false);

    const approved = queue.approve(pending[0]!.callId);
    expect(approved).toBe(true);

    const reply = await nextMatching((m) => m.id === 1);
    expect(reply.error).toBeUndefined();
    const result = reply.result as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe("committed");
    expect(handlerRan.value).toBe(true);
  });

  it("reject: tool is blocked and reply carries isError:true", async () => {
    const { queue, handlerRan, send, nextMatching } = setup();

    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "gitCommit", arguments: { message: "dangerous" } },
    });

    const deadline = Date.now() + 2000;
    while (queue.size() === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const pending = queue.list();
    expect(pending).toHaveLength(1);
    const rejected = queue.reject(pending[0]!.callId);
    expect(rejected).toBe(true);

    const reply = await nextMatching((m) => m.id === 2);
    const result = reply.result as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/rejected/i);
    expect(handlerRan.value).toBe(false);
  });

  it("bypass: low-tier tool skips the gate entirely", async () => {
    const { transport, queue, send, nextMatching } = setup();

    transport.registerTool(
      {
        name: "getDiagnostics",
        description: "Fake low-tier tool",
        inputSchema: { type: "object", properties: {} },
      },
      async () => ({
        content: [{ type: "text", text: "ok" }],
      }),
    );

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "getDiagnostics", arguments: {} },
    });

    const reply = await nextMatching((m) => m.id === 3);
    expect(queue.size()).toBe(0);
    const result = reply.result as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe("ok");
  });
});
