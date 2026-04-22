/**
 * E2E: mobile oversight — full queue → mock-relay → token-approve flow.
 *
 * Scenario:
 *   1. Start a lightweight HTTP server acting as the push relay mock.
 *   2. Bridge side: POST /approvals with pushServiceUrl pointing to mock.
 *   3. Assert mock received push payload with correct fields + approvalToken.
 *   4. POST /approve/:callId with x-approval-token header (phone path).
 *   5. Assert approval resolves "approved" and queue is empty.
 *   6. Assert mock received exactly one push (no double-notify).
 */

import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeApprovalRequest } from "../approvalHttp.js";
import { ApprovalQueue, resetApprovalQueueForTests } from "../approvalQueue.js";

// Mock dns so push.mock-relay.local resolves to a public IP (passes SSRF check)
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue({ address: "93.184.216.34", family: 4 }),
}));

// ── Mock relay server ─────────────────────────────────────────────────────

interface RelayCall {
  method: string;
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

function _startMockRelay(): Promise<{
  url: string;
  calls: RelayCall[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const calls: RelayCall[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          /* empty body */
        }
        calls.push({
          method: req.method ?? "",
          path: req.url ?? "",
          body,
          headers: req.headers as Record<string, string | string[] | undefined>,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `https://push.mock-relay.local:${addr.port}`,
        calls,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
    server.on("error", reject);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("mobile oversight E2E", () => {
  beforeEach(() => {
    resetApprovalQueueForTests();
  });

  afterEach(() => {
    resetApprovalQueueForTests();
  });

  it("full flow: POST /approvals → push relay receives payload → phone-path approve resolves", async () => {
    // We can't bind a real HTTPS server in tests, so mock fetch for the push call
    // while still testing the full routeApprovalRequest → validateToken → approve path.
    const pushCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      pushCalls.push({
        url,
        body: JSON.parse((init?.body as string) ?? "{}") as Record<
          string,
          unknown
        >,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      const queue = new ApprovalQueue({ ttlMs: 30_000 });

      // Step 1: Bridge receives a high-risk tool call → queues for approval
      const approvalPromise = routeApprovalRequest(
        {
          method: "POST",
          path: "/approvals",
          body: {
            toolName: "gitPush",
            params: { remote: "origin", branch: "main" },
            summary: "Push 3 commits to main",
          },
        },
        {
          queue,
          workspace: "/tmp/workspace",
          ccLoader: () => ({ allow: [], ask: [], deny: [] }),
          approvalGate: "high",
          pushServiceUrl: "https://push.mock-relay.local",
          pushServiceToken: "relay-bearer-token",
          pushServiceBaseUrl: "https://bridge.example.com",
        },
      );

      // Step 2: Wait for async push dispatch (fire-and-forget)
      await new Promise((r) => setTimeout(r, 30));

      // Step 3: Assert push relay received the payload
      expect(pushCalls.length).toBeGreaterThanOrEqual(1);
      const pushCall = pushCalls.find(
        (c) => c.url === "https://push.mock-relay.local/push",
      );
      expect(pushCall).toBeDefined();

      const pushBody = pushCall!.body;
      expect(pushBody.toolName).toBe("gitPush");
      expect(pushBody.tier).toBe("high");
      expect(typeof pushBody.approvalToken).toBe("string");
      expect((pushBody.approvalToken as string).length).toBe(64); // 32 bytes hex
      expect(pushBody.bridgeCallbackBase).toBe("https://bridge.example.com");

      const { callId, approvalToken } = pushBody as {
        callId: string;
        approvalToken: string;
      };
      expect(callId).toBeTruthy();

      // Step 4: Phone-path approve with token (simulates tap on push notification)
      const approveResult = await routeApprovalRequest(
        {
          method: "POST",
          path: `/approve/${callId}`,
          approvalToken,
        },
        {
          queue,
          workspace: "/tmp/workspace",
          ccLoader: () => ({ allow: [], ask: [], deny: [] }),
        },
      );
      expect(approveResult.status).toBe(200);
      expect((approveResult.body as Record<string, unknown>).decision).toBe(
        "allow",
      );

      // Step 5: Original approval promise resolves
      const outcome = await approvalPromise;
      expect(outcome.status).toBe(200);
      expect((outcome.body as Record<string, unknown>).decision).toBe("allow");
      expect((outcome.body as Record<string, unknown>).reason).toBe("approved");

      // Step 6: Queue is empty
      expect(queue.size()).toBe(0);

      // Step 7: No duplicate push notification
      const pushToRelay = pushCalls.filter(
        (c) => c.url === "https://push.mock-relay.local/push",
      );
      expect(pushToRelay.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("phone-path reject resolves queue as rejected", async () => {
    const originalFetch = globalThis.fetch;
    let capturedApprovalToken: string | undefined;
    let capturedCallId: string | undefined;

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<
        string,
        unknown
      >;
      capturedApprovalToken = body.approvalToken as string;
      capturedCallId = body.callId as string;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      const queue = new ApprovalQueue({ ttlMs: 30_000 });
      const approvalPromise = routeApprovalRequest(
        { method: "POST", path: "/approvals", body: { toolName: "gitPush" } },
        {
          queue,
          workspace: "/tmp",
          ccLoader: () => ({ allow: [], ask: [], deny: [] }),
          approvalGate: "high",
          pushServiceUrl: "https://push.mock-relay.local",
          pushServiceToken: "tok",
        },
      );

      await new Promise((r) => setTimeout(r, 30));
      expect(capturedCallId).toBeTruthy();
      expect(capturedApprovalToken).toBeTruthy();

      const rejectResult = await routeApprovalRequest(
        {
          method: "POST",
          path: `/reject/${capturedCallId}`,
          approvalToken: capturedApprovalToken,
        },
        {
          queue,
          workspace: "/tmp",
          ccLoader: () => ({ allow: [], ask: [], deny: [] }),
        },
      );
      expect(rejectResult.status).toBe(200);

      const outcome = await approvalPromise;
      expect((outcome.body as Record<string, unknown>).decision).toBe("deny");
      expect((outcome.body as Record<string, unknown>).reason).toBe("rejected");
      expect(queue.size()).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("expired / wrong token is rejected with 401 — does not unblock queue", async () => {
    const originalFetch = globalThis.fetch;
    let capturedCallId: string | undefined;

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<
        string,
        unknown
      >;
      capturedCallId = body.callId as string;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      const queue = new ApprovalQueue({ ttlMs: 30_000 });
      const approvalPromise = routeApprovalRequest(
        { method: "POST", path: "/approvals", body: { toolName: "gitPush" } },
        {
          queue,
          workspace: "/tmp",
          ccLoader: () => ({ allow: [], ask: [], deny: [] }),
          approvalGate: "high",
          pushServiceUrl: "https://push.mock-relay.local",
          pushServiceToken: "tok",
        },
      );

      await new Promise((r) => setTimeout(r, 30));

      const badResult = await routeApprovalRequest(
        {
          method: "POST",
          path: `/approve/${capturedCallId}`,
          approvalToken: "wrong-token",
        },
        {
          queue,
          workspace: "/tmp",
          ccLoader: () => ({ allow: [], ask: [], deny: [] }),
        },
      );
      expect(badResult.status).toBe(401);

      // Queue entry still present — wrong token should not consume it
      expect(queue.size()).toBe(1);

      // Clean up
      queue.clear();
      await approvalPromise.catch(() => {});
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
