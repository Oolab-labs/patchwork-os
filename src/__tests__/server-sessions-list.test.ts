/**
 * Integration test for GET /sessions list endpoint.
 *
 * Live-mode investigation (post-#271) found the dashboard /sessions page
 * showed "No active sessions" even with bridge running because the
 * server's `sessionsFn` was declared in `server.ts` but never assigned
 * anywhere in the codebase. The route handler returned 404 forever.
 * `tasksFn`, `metricsFn`, and other sibling Fns are wired in `bridge.ts`;
 * `sessionsFn` was missed.
 *
 * Test exercises the route against a Server with `sessionsFn` stubbed
 * to a static list, mirroring the per-session card shape the dashboard
 * renders. Pre-fix: route returned 404. Post-fix: returns the list.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server, type SessionSummary } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-sessions-list-token-0000000";

let server: Server | null = null;
let port = 0;

async function startServer(fn?: () => SessionSummary[]): Promise<void> {
  server = new Server(TOKEN, logger);
  if (fn) server.sessionsFn = fn;
  port = await server.findAndListen(null);
}

function request(): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: "/sessions",
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

describe("GET /sessions", () => {
  it("returns 404 when sessionsFn is not wired (pre-fix behavior, regression guard)", async () => {
    await startServer(); // no fn
    const { status, body } = await request();
    expect(status).toBe(404);
    expect(JSON.parse(body)).toEqual({ error: "sessions not available" });
  });

  it("returns an empty array when no sessions are connected", async () => {
    await startServer(() => []);
    const { status, body } = await request();
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual([]);
  });

  it("returns wired session summaries", async () => {
    const summaries: SessionSummary[] = [
      {
        id: "abc12345",
        connectedAt: new Date(Date.now() - 60_000).toISOString(),
        openedFileCount: 3,
        pendingApprovals: 1,
        firstTool: "getGitStatus",
        remoteAddr: "127.0.0.1",
      },
      {
        id: "def98765",
        connectedAt: new Date(Date.now() - 30_000).toISOString(),
        openedFileCount: 0,
        pendingApprovals: 0,
      },
    ];
    await startServer(() => summaries);
    const { status, body } = await request();
    expect(status).toBe(200);
    const data = JSON.parse(body) as SessionSummary[];
    expect(data).toHaveLength(2);
    expect(data[0]?.id).toBe("abc12345");
    expect(data[0]?.openedFileCount).toBe(3);
    expect(data[0]?.pendingApprovals).toBe(1);
    expect(data[0]?.remoteAddr).toBe("127.0.0.1");
    expect(data[1]?.remoteAddr).toBeUndefined();
  });
});
