/**
 * Integration tests for GET /sessions/:id — per-session detail view
 * backing the dashboard session drill-down. Uses a stub sessionDetailFn
 * so server routing is tested independently of bridge state.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server, type SessionSummary } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-session-detail-token-0000000";

let server: Server | null = null;
let port = 0;

async function startServer(
  detailFn?: (id: string) => {
    summary: SessionSummary | null;
    lifecycle: Record<string, unknown>[];
    tools: Record<string, unknown>[];
    approvals: Record<string, unknown>[];
  },
): Promise<void> {
  server = new Server(TOKEN, logger);
  if (detailFn) server.sessionDetailFn = detailFn;
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

describe("GET /sessions/:id", () => {
  it("404s when detailFn is not wired", async () => {
    await startServer();
    const { status } = await get("/sessions/abc");
    expect(status).toBe(404);
  });

  it("404s when session is unknown (summary null)", async () => {
    await startServer(() => ({
      summary: null,
      lifecycle: [],
      tools: [],
      approvals: [],
    }));
    const { status, body } = await get("/sessions/unknown");
    expect(status).toBe(404);
    expect(JSON.parse(body).error).toBe("unknown sessionId");
  });

  it("returns full detail when session exists", async () => {
    await startServer((id) => ({
      summary: {
        id,
        connectedAt: "2026-04-18T12:00:00Z",
        openedFileCount: 3,
        pendingApprovals: 1,
      },
      lifecycle: [
        {
          id: 1,
          timestamp: "2026-04-18T12:00:00Z",
          event: "claude_connected",
          metadata: { sessionId: id },
        },
      ],
      tools: [
        {
          id: 2,
          timestamp: "2026-04-18T12:00:01Z",
          tool: "getBridgeStatus",
          durationMs: 42,
          status: "success",
          sessionId: id,
        },
      ],
      approvals: [
        {
          callId: "call-1",
          toolName: "Bash",
          tier: "high",
          requestedAt: 1700000000000,
        },
      ],
    }));
    const { status, body } = await get("/sessions/sess-a");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.summary.id).toBe("sess-a");
    expect(parsed.lifecycle).toHaveLength(1);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].tool).toBe("getBridgeStatus");
    expect(parsed.tools[0].sessionId).toBe("sess-a");
    expect(parsed.approvals[0].callId).toBe("call-1");
  });

  it("returns 500 when detailFn throws", async () => {
    await startServer(() => {
      throw new Error("oh no");
    });
    const { status, body } = await get("/sessions/boom");
    expect(status).toBe(500);
    expect(JSON.parse(body).error).toContain("oh no");
  });

  it("requires auth", async () => {
    await startServer(() => ({
      summary: null,
      lifecycle: [],
      tools: [],
      approvals: [],
    }));
    const { status } = await get("/sessions/any", false);
    expect(status).toBe(401);
  });

  it("does not shadow the /sessions list endpoint", async () => {
    // Detail handler must only match /sessions/:id, not /sessions.
    // Stub detailFn to fail loudly if /sessions hits it.
    await startServer(() => {
      throw new Error("detailFn must not be called for /sessions");
    });
    const { status } = await get("/sessions");
    // sessionsFn isn't wired in this test → returns 404 from list handler,
    // not from detail handler. The throw above would have produced 500.
    expect([200, 404]).toContain(status);
  });
});
