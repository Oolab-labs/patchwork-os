/**
 * Integration tests for GET /activity — the HTTP surface that seeds the
 * dashboard Activity page with history before the SSE stream takes over.
 * Uses a stub activityFn so server logic is tested independently of the
 * activityLog implementation.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-activity-token-00000000000000";

let server: Server | null = null;
let port = 0;

async function startServer(
  activityFn?: (last: number) => Record<string, unknown>[],
): Promise<void> {
  server = new Server(TOKEN, logger);
  if (activityFn) server.activityFn = activityFn;
  port = await server.findAndListen(null);
}

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path,
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
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

describe("GET /activity", () => {
  it("returns empty when activityFn is not wired", async () => {
    await startServer();
    const { status, body } = await get("/activity");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.events).toEqual([]);
    expect(parsed.count).toBe(0);
  });

  it("passes through events from activityFn", async () => {
    await startServer(() => [
      {
        kind: "tool",
        id: 1,
        timestamp: "2026-04-18T12:00:00Z",
        tool: "Read",
        durationMs: 5,
        status: "success",
      },
      {
        kind: "lifecycle",
        id: 2,
        timestamp: "2026-04-18T12:00:01Z",
        event: "approval_decision",
        metadata: { toolName: "Bash", decision: "allow" },
      },
    ]);
    const { status, body } = await get("/activity");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.count).toBe(2);
    expect(parsed.events[0].tool).toBe("Read");
    expect(parsed.events[1].event).toBe("approval_decision");
  });

  it("parses and caps `last` query param", async () => {
    const received: number[] = [];
    await startServer((last) => {
      received.push(last);
      return [];
    });
    await get("/activity?last=50");
    await get("/activity?last=9999"); // should clamp to 500
    await get("/activity"); // default 100
    await get("/activity?last=abc"); // non-numeric → default
    expect(received).toEqual([50, 500, 100, 100]);
  });

  it("returns 500 when activityFn throws", async () => {
    await startServer(() => {
      throw new Error("log on fire");
    });
    const { status, body } = await get("/activity");
    expect(status).toBe(500);
    const parsed = JSON.parse(body);
    expect(parsed.error).toContain("log on fire");
  });

  it("requires auth", async () => {
    await startServer(() => []);
    const req = new Promise<number>((resolve, reject) => {
      const r = http.request(
        { hostname: "127.0.0.1", port, method: "GET", path: "/activity" },
        (res) => resolve(res.statusCode ?? 0),
      );
      r.on("error", reject);
      r.end();
    });
    expect(await req).toBe(401);
  });
});
