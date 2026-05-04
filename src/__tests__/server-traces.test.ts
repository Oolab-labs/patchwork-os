/**
 * Integration tests for GET /traces — the HTTP surface that backs the
 * dashboard Traces page. Uses a stub tracesFn so the server logic is
 * tested independently of ctxQueryTraces internals (those have their
 * own unit tests).
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-traces-token-00000000000000";

let server: Server | null = null;
let port = 0;

async function startServer(
  tracesFn?: (q: {
    traceType?: string;
    key?: string;
    q?: string;
    since?: number;
    limit?: number;
  }) => Promise<Record<string, unknown>>,
): Promise<void> {
  server = new Server(TOKEN, logger);
  if (tracesFn) server.tracesFn = tracesFn;
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

describe("GET /traces", () => {
  it("returns empty default when tracesFn is not wired", async () => {
    await startServer();
    const { status, body } = await get("/traces");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.traces).toEqual([]);
    expect(parsed.count).toBe(0);
    expect(parsed.sources).toEqual({
      approval: false,
      enrichment: false,
      recipe_run: false,
    });
    expect(parsed.hint).toMatch(/not wired/i);
  });

  it("passes through query results from tracesFn", async () => {
    await startServer(async () => ({
      traces: [
        {
          traceType: "approval",
          ts: 1000,
          key: "s1:Bash",
          summary: "allow Bash",
          body: { toolName: "Bash" },
        },
      ],
      count: 1,
      sources: { approval: true, enrichment: false, recipe_run: false },
    }));
    const { status, body } = await get("/traces");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.count).toBe(1);
    expect(parsed.traces[0].key).toBe("s1:Bash");
  });

  it("parses query string into tracesFn args", async () => {
    const received: Array<Record<string, unknown>> = [];
    await startServer(async (q) => {
      received.push(q);
      return { traces: [], count: 0, sources: {} };
    });
    await get(
      "/traces?traceType=enrichment&key=abc&q=needle&since=1700000000000&limit=25",
    );
    expect(received[0]).toEqual({
      traceType: "enrichment",
      key: "abc",
      q: "needle",
      since: 1_700_000_000_000,
      limit: 25,
    });
  });

  it("ignores non-numeric since / limit values", async () => {
    const received: Array<Record<string, unknown>> = [];
    await startServer(async (q) => {
      received.push(q);
      return { traces: [], count: 0, sources: {} };
    });
    await get("/traces?since=abc&limit=xyz");
    expect(received[0]?.since).toBeUndefined();
    expect(received[0]?.limit).toBeUndefined();
  });

  it("returns 500 when tracesFn throws", async () => {
    await startServer(async () => {
      throw new Error("backend on fire");
    });
    const { status, body } = await get("/traces");
    expect(status).toBe(500);
    const parsed = JSON.parse(body);
    expect(parsed.error).toContain("backend on fire");
  });

  it("requires auth", async () => {
    await startServer(async () => ({ traces: [], count: 0, sources: {} }));
    const req = new Promise<number>((resolve, reject) => {
      const r = http.request(
        {
          hostname: "127.0.0.1",
          port,
          method: "GET",
          path: "/traces",
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      r.on("error", reject);
      r.end();
    });
    expect(await req).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /traces/export — passphrase header validation
// ---------------------------------------------------------------------------

function getExport(
  extraHeaders: Record<string, string> = {},
  qs = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: `/traces/export${qs}`,
        headers: { Authorization: `Bearer ${TOKEN}`, ...extraHeaders },
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

describe("GET /traces/export — passphrase validation", () => {
  it("rejects passphrase supplied as query string param", async () => {
    await startServer();
    const { status, body } = await getExport({}, "?passphrase=secretpassword");
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/header/i);
  });

  it("rejects passphrase shorter than 12 chars via header", async () => {
    await startServer();
    const { status, body } = await getExport({
      "x-trace-passphrase": "short",
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/too short/i);
  });

  it("rejects passphrase longer than 4096 chars via header", async () => {
    await startServer();
    const { status, body } = await getExport({
      "x-trace-passphrase": "a".repeat(4097),
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/too long/i);
  });
});
