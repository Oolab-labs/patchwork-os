/**
 * audit P0-2 — end-to-end wiring of the content-aware in-process gate.
 *
 * Mirrors approvalGate.e2e.test.ts but drives the REAL gate logic
 * (evaluateInProcessGate, the same fn bridge.ts/streamableHttp.ts call) through
 * McpTransport → ApprovalQueue, proving:
 *   - a destructive command queues WITH its risk signals (was riskSignals: [])
 *   - a sub-high tool carrying a high-severity signal is escalated to the queue
 *   - a benign sub-high call still bypasses (handler runs)
 */

import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovalQueue,
  getApprovalQueue,
  resetApprovalQueueForTests,
} from "../approvalQueue.js";
import { Logger } from "../logger.js";
import { evaluateInProcessGate } from "../riskSignals.js";
import { McpTransport } from "../transport.js";

const WS = path.resolve("content-gate-test-ws");
const OUTSIDE = path.resolve(path.dirname(WS), "escapes.txt");
const INSIDE = path.join(WS, "ok.txt");

interface McpMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

class MockWs {
  readyState = 1;
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
  queue: ApprovalQueue;
  ran: Record<string, boolean>;
  send(msg: McpMessage): void;
  nextMatching(predicate: (m: McpMessage) => boolean): Promise<McpMessage>;
} {
  resetApprovalQueueForTests();
  const queue = getApprovalQueue();
  const transport = new McpTransport(new Logger(false));
  const ran: Record<string, boolean> = { runCommand: false, Read: false };

  for (const name of ["runCommand", "Read"] as const) {
    transport.registerTool(
      {
        name,
        description: `fake ${name}`,
        inputSchema: { type: "object", properties: {} },
      },
      async () => {
        ran[name] = true;
        return { content: [{ type: "text", text: `${name} ran` }] };
      },
    );
  }

  // The SAME logic bridge.ts/streamableHttp.ts run at gate "high".
  transport.setApprovalGate(
    async ({ toolName, params, sessionId, onPending }) => {
      const gate = evaluateInProcessGate({
        toolName,
        params,
        gate: "high",
        workspace: WS,
      });
      if (gate.decision === "bypass") return "bypass";
      const { promise, callId } = queue.request({
        toolName,
        params,
        tier: gate.tier,
        sessionId: sessionId ?? undefined,
        riskSignals: gate.riskSignals,
      });
      onPending?.(callId);
      return promise;
    },
  );

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
            if (predicate(parsed)) return resolve(parsed);
          } catch {
            // skip non-JSON frame
          }
        }
        if (Date.now() > deadline)
          return reject(new Error("Timed out waiting for message"));
        setTimeout(tick, 10);
      };
      tick();
    });

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

  return { queue, ran, send, nextMatching };
}

async function waitForQueue(queue: ApprovalQueue) {
  const deadline = Date.now() + 2000;
  while (queue.size() === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(() => {
  resetApprovalQueueForTests();
});

describe("content-aware in-process gate E2E (P0-2)", () => {
  it("queues a destructive command WITH its high-severity risk signal", async () => {
    const { queue, ran, send } = setup();
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "runCommand", arguments: { command: "rm -rf ./build" } },
    });
    await waitForQueue(queue);
    const pending = queue.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.riskSignals).toBeDefined();
    expect(
      pending[0]!.riskSignals?.some(
        (s) => s.severity === "high" && s.label === "rm with -rf flags",
      ),
    ).toBe(true);
    expect(ran.runCommand).toBe(false);
  });

  it("escalates a sub-high tool with a high-severity signal to the queue", async () => {
    const { queue, ran, send, nextMatching } = setup();
    // Read is 'medium' tier; a workspace-escaping path is a high signal →
    // pre-fix this bypassed and ran immediately. Now it must queue.
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "Read", arguments: { file_path: OUTSIDE } },
    });
    await waitForQueue(queue);
    const pending = queue.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.toolName).toBe("Read");
    expect(ran.Read).toBe(false);
    queue.approve(pending[0]!.callId);
    await nextMatching((m) => m.id === 2);
    expect(ran.Read).toBe(true);
  });

  it("bypasses a benign sub-high call (no high signal) — handler runs", async () => {
    const { queue, ran, send, nextMatching } = setup();
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "Read", arguments: { file_path: INSIDE } },
    });
    await nextMatching((m) => m.id === 3);
    expect(ran.Read).toBe(true);
    expect(queue.size()).toBe(0);
  });
});
