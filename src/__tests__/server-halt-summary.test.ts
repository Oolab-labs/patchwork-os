/**
 * Integration test for GET /runs/halt-summary. PR1c of the Val-inspired
 * plan: dashboard widget that aggregates halt-reason categories across
 * recent runs so we can tell whether haltReason is surfacing real signal
 * or everything is landing in "unknown".
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-halt-summary-token-000000000";

let server: Server | null = null;
let port = 0;

async function startServer(
  fn?: (opts?: {
    sinceMs?: number;
    limit?: number;
  }) => import("../recipes/haltCategory.js").HaltSummary,
): Promise<void> {
  server = new Server(TOKEN, logger);
  if (fn) server.haltSummaryFn = fn;
  port = await server.findAndListen(null);
}

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${TOKEN}`,
    };
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

describe("GET /runs/halt-summary", () => {
  it("returns the summary payload from haltSummaryFn", async () => {
    await startServer(() => ({
      total: 3,
      byCategory: { tool_threw: 2, agent_silent_fail: 1 },
      recent: [
        {
          reason: 'Tool "a" in step "s" threw: x',
          category: "tool_threw",
          runSeq: 9,
        },
      ],
    }));
    const res = await get("/runs/halt-summary");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.total).toBe(3);
    expect(body.byCategory).toEqual({ tool_threw: 2, agent_silent_fail: 1 });
    expect(Array.isArray(body.recent)).toBe(true);
  });

  it("returns an empty summary when haltSummaryFn is not wired", async () => {
    await startServer();
    const res = await get("/runs/halt-summary");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.total).toBe(0);
    expect(body.byCategory).toEqual({});
    expect(body.recent).toEqual([]);
  });

  it("forwards sinceMs and limit query params to haltSummaryFn", async () => {
    let captured: { sinceMs?: number; limit?: number } | undefined;
    await startServer((opts) => {
      captured = opts;
      return { total: 0, byCategory: {}, recent: [] };
    });
    await get("/runs/halt-summary?sinceMs=3600000&limit=50");
    expect(captured).toEqual({ sinceMs: 3600000, limit: 50 });
  });
});
