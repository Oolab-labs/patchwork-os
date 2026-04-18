/**
 * Integration tests for GET /approvals/:callId — single-approval detail lookup
 * backing the dashboard approval detail view. Uses a stub approvalDetailFn so
 * we test the server routing + serialization independently of ActivityLog +
 * ApprovalQueue wiring (covered by unit tests).
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-approval-detail-token-000000";

let server: Server | null = null;
let port = 0;

async function startServer(
  detailFn?: (callId: string) => {
    pending: Record<string, unknown> | null;
    decision: Record<string, unknown> | null;
    nearby: Record<string, unknown>[];
  },
): Promise<void> {
  server = new Server(TOKEN, logger);
  if (detailFn) server.approvalDetailFn = detailFn;
  port = await server.findAndListen(null);
}

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

function get(
  path: string,
  auth = true,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = `Bearer ${TOKEN}`;
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "GET", path, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /approvals/:callId", () => {
  it("404s when detailFn is not wired", async () => {
    await startServer();
    const { status } = await get("/approvals/abc-123");
    expect(status).toBe(404);
  });

  it("404s when callId is unknown (both pending + decision null)", async () => {
    await startServer(() => ({ pending: null, decision: null, nearby: [] }));
    const { status, body } = await get("/approvals/unknown-id");
    expect(status).toBe(404);
    expect(JSON.parse(body).error).toBe("unknown callId");
  });

  it("returns pending record when approval is in-flight", async () => {
    await startServer((callId) => ({
      pending: {
        callId,
        toolName: "Bash",
        tier: "high",
        requestedAt: 1_700_000_000_000,
        params: { command: "rm -rf /tmp/x" },
      },
      decision: null,
      nearby: [],
    }));
    const { status, body } = await get("/approvals/pending-1");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.pending.callId).toBe("pending-1");
    expect(parsed.pending.toolName).toBe("Bash");
    expect(parsed.decision).toBeNull();
  });

  it("returns decided record with nearby activity", async () => {
    await startServer((callId) => ({
      pending: null,
      decision: {
        id: 42,
        timestamp: "2026-04-18T12:00:00Z",
        event: "approval_decision",
        metadata: {
          callId,
          toolName: "Bash",
          decision: "allow",
          reason: "user_approved",
          sessionId: "sess-abc",
        },
      },
      nearby: [
        {
          kind: "tool",
          id: 43,
          timestamp: "2026-04-18T12:00:05Z",
          tool: "Bash",
          durationMs: 120,
          status: "success",
        },
      ],
    }));
    const { status, body } = await get("/approvals/decided-1");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.pending).toBeNull();
    expect(parsed.decision.metadata.decision).toBe("allow");
    expect(parsed.nearby).toHaveLength(1);
    expect(parsed.nearby[0].tool).toBe("Bash");
  });

  it("returns 500 when detailFn throws", async () => {
    await startServer(() => {
      throw new Error("log on fire");
    });
    const { status, body } = await get("/approvals/boom");
    expect(status).toBe(500);
    expect(JSON.parse(body).error).toContain("log on fire");
  });

  it("requires auth", async () => {
    await startServer(() => ({
      pending: null,
      decision: null,
      nearby: [],
    }));
    const { status } = await get("/approvals/any", false);
    expect(status).toBe(401);
  });

  it("does not collide with /approvals list endpoint", async () => {
    // /approvals (no trailing id) must still hit the list handler, which
    // doesn't use approvalDetailFn. Stub detailFn to fail loudly if hit.
    await startServer(() => {
      throw new Error("detailFn must not be called for /approvals");
    });
    const { status } = await get("/approvals");
    expect(status).toBe(200);
  });
});
