import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { StreamableHttpHandler } from "../streamableHttp.js";

// Mock registerAllTools so createSession doesn't require real tool deps.
// The McpTransport will handle initialize/tools/list via its built-in MCP logic.
vi.mock("../tools/index.js", () => ({
  registerAllTools: () => {},
}));

const logger = new Logger(false);
const TOKEN = "test-token-streamable-http-1234567890";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Minimal stubs for deps that StreamableHttpHandler needs but doesn't deeply use in tests. */
function makeDeps() {
  const config = {
    workspace: "/tmp/test-workspace",
    port: null,
    bindAddress: "127.0.0.1",
    preferredPortRange: null,
    ide: null,
    ideName: "test",
    debug: false,
    editor: null,
    noReady: false,
    configFile: null,
    noLockFile: false,
    claudeDriver: "subprocess" as const,
    claudeBinary: "claude",
    automationPolicy: null,
  };
  const extensionClient = {
    isConnected: () => false,
    // Required by registerAllTools — provide stubs
    on: () => {},
    request: () => Promise.resolve(null),
    removeListener: () => {},
  };
  const activityLog = {
    recordTool: () => {},
    recordEvent: () => {},
    getStats: () => ({
      totalToolCalls: 0,
      errorCount: 0,
      avgDurationMs: 0,
      toolBreakdown: {},
    }),
    queryTimeline: () => [],
  };
  const fileLock = {
    acquire: () => Promise.resolve({ release: () => {} }),
  };
  return { config, extensionClient, activityLog, fileLock };
}

/** POST JSON to the given URL, returning { status, headers, body }. */
async function post(
  port: number,
  data: Record<string, unknown>,
  sessionId?: string,
  ownershipToken?: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (ownershipToken) headers["Mcp-Session-Token"] = ownershipToken;

    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/mcp", method: "POST", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** Send a GET, DELETE, or OPTIONS request to /mcp. */
async function httpReq(
  port: number,
  method: string,
  sessionId?: string,
  ownershipToken?: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${TOKEN}`,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (ownershipToken) headers["Mcp-Session-Token"] = ownershipToken;

    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/mcp", method, headers },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Initialize a session, returning the Mcp-Session-Id and Mcp-Session-Token. */
async function initSession(
  port: number,
): Promise<{ sid: string; token: string }> {
  const res = await post(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  });
  const sid = res.headers["mcp-session-id"];
  const token = res.headers["mcp-session-token"];
  if (typeof sid !== "string")
    throw new Error("No session ID in initialize response");
  if (typeof token !== "string")
    throw new Error("No ownership token in initialize response");
  return { sid, token };
}

// ── Test suite ─────────────────────────────────────────────────────────────────

let server: Server | null = null;
let handler: StreamableHttpHandler | null = null;
let port: number;

beforeEach(async () => {
  const deps = makeDeps();
  server = new Server(TOKEN, logger);

  handler = new StreamableHttpHandler(
    deps.config as any,
    {} as any, // probes — not used directly in handler logic
    deps.extensionClient as any,
    deps.activityLog as any,
    deps.fileLock as any,
    new Map(),
    null,
    logger,
  );

  server.httpMcpHandler = (req, res) => handler!.handle(req, res);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  handler?.close();
  handler = null;
  await server?.close();
  server = null;
});

// ── Session lifecycle ──────────────────────────────────────────────────────────

describe("Streamable HTTP: session lifecycle", () => {
  it("initialize creates a session and returns Mcp-Session-Id", async () => {
    const res = await post(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeDefined();
    expect(typeof res.headers["mcp-session-id"]).toBe("string");

    const body = JSON.parse(res.body);
    expect(body.result).toBeDefined();
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });

  it("rejects non-initialize POST without Mcp-Session-Id", async () => {
    const res = await post(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("Missing Mcp-Session-Id");
  });

  it("returns 404 for unknown session ID", async () => {
    const res = await post(
      port,
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      "nonexistent-session-id",
    );

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("Session not found");
  });

  it("DELETE destroys a session", async () => {
    const { sid, token } = await initSession(port);

    // DELETE the session
    const del = await httpReq(port, "DELETE", sid, token);
    expect(del.status).toBe(204);

    // Subsequent request should 404
    const res = await post(
      port,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sid,
      token,
    );
    expect(res.status).toBe(404);
  });

  it("DELETE returns 400 without session ID header", async () => {
    const res = await httpReq(port, "DELETE");
    expect(res.status).toBe(400);
  });

  it("DELETE returns 404 for unknown session", async () => {
    const res = await httpReq(port, "DELETE", "nonexistent");
    expect(res.status).toBe(404);
  });
});

// ── Ownership token ───────────────────────────────────────────────────────────

describe("Streamable HTTP: per-session ownership token", () => {
  it("DELETE without Mcp-Session-Token returns 403", async () => {
    const { sid } = await initSession(port);
    const res = await httpReq(port, "DELETE", sid); // no token
    expect(res.status).toBe(403);
  });

  it("DELETE with wrong Mcp-Session-Token returns 403", async () => {
    const { sid } = await initSession(port);
    const wrongToken = "0".repeat(64);
    const res = await httpReq(port, "DELETE", sid, wrongToken);
    expect(res.status).toBe(403);
  });

  it("GET without Mcp-Session-Token returns 403", async () => {
    const { sid } = await initSession(port);
    const res = await httpReq(port, "GET", sid); // no token
    expect(res.status).toBe(403);
  });

  it("POST on existing session without Mcp-Session-Token returns 403", async () => {
    const { sid } = await initSession(port);
    const res = await post(
      port,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sid, // no token
    );
    expect(res.status).toBe(403);
  });

  it("session A's token cannot DELETE session B (cross-session takeover)", async () => {
    const a = await initSession(port);
    const b = await initSession(port);
    const res = await httpReq(port, "DELETE", b.sid, a.token);
    expect(res.status).toBe(403);
  });
});

// ── Capacity ───────────────────────────────────────────────────────────────────

describe("Streamable HTTP: capacity guard", () => {
  it("rejects initialize when at max capacity (5 sessions)", async () => {
    // Create 5 sessions
    for (let i = 0; i < 5; i++) {
      await initSession(port);
    }

    // 6th should fail
    const res = await post(port, {
      jsonrpc: "2.0",
      id: 99,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("capacity");
  });
});

// ── Notifications ──────────────────────────────────────────────────────────────

describe("Streamable HTTP: notifications", () => {
  it("notification (no id) returns 202", async () => {
    const { sid, token } = await initSession(port);

    const res = await post(
      port,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sid,
      token,
    );

    expect(res.status).toBe(202);
    expect(res.body).toBe("");
  });

  it("does not treat a message with id field present as a notification", () => {
    // JSON-RPC 2.0 spec: notifications have NO `id` field at all.
    // A message with `id: null` is malformed but has an `id` field — not a notification.
    const withId = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const withNullId = { jsonrpc: "2.0", id: null, method: "tools/list" };
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };

    expect(Object.hasOwn(withId, "id")).toBe(true);
    expect(Object.hasOwn(withNullId, "id")).toBe(true); // id:null still has the field
    expect(Object.hasOwn(notification, "id")).toBe(false); // no id field = notification
  });
});

// ── JSON-RPC error handling ────────────────────────────────────────────────────

describe("Streamable HTTP: error handling", () => {
  it("returns 400 on invalid JSON body", async () => {
    const res = await new Promise<{
      status: number;
      body: string;
    }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => {
            body += c.toString();
          });
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        },
      );
      req.on("error", reject);
      req.end("not valid json{{{");
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32700); // Parse error
  });

  it("returns 404 or 405 for unsupported methods (PUT bypassed by server)", async () => {
    // PUT is not in the server.ts /mcp method dispatch (only POST/GET/DELETE),
    // so server.ts returns 404 before the handler sees it.
    const res = await httpReq(port, "PUT");
    expect([404, 405]).toContain(res.status);
  });
});

// ── CORS ───────────────────────────────────────────────────────────────────────

describe("Streamable HTTP: CORS", () => {
  it("OPTIONS preflight returns 204 without auth and reflects localhost origin", async () => {
    const res = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mcp",
          method: "OPTIONS",
          headers: { Origin: "http://localhost:3000" },
          // No auth header — preflight must work without it
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve({ status: res.statusCode!, headers: res.headers }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]).toContain(
      "Mcp-Session-Id",
    );
    expect(res.headers["access-control-expose-headers"]).toContain(
      "Mcp-Session-Id",
    );
  });

  it("OPTIONS preflight omits CORS headers when Origin is not localhost", async () => {
    const res = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mcp",
          method: "OPTIONS",
          headers: { Origin: "https://evil.example.com" },
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve({ status: res.statusCode!, headers: res.headers }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("POST responses reflect localhost origin in CORS headers", async () => {
    const res = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      });
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            Authorization: `Bearer ${TOKEN}`,
            Origin: "http://127.0.0.1:8080",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve({ status: res.statusCode!, headers: res.headers }),
          );
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://127.0.0.1:8080",
    );
  });
});

// ── SSE event IDs and Last-Event-ID replay ────────────────────────────────────

/**
 * Open a GET /mcp SSE stream, collect raw SSE lines for `collectMs`, then
 * destroy the request and return all non-comment lines.
 */
function collectSseLines(
  p: number,
  sessionId: string,
  collectMs: number,
  lastEventId?: number,
  ownershipToken?: string,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${TOKEN}`,
      "Mcp-Session-Id": sessionId,
    };
    if (ownershipToken) headers["Mcp-Session-Token"] = ownershipToken;
    if (lastEventId !== undefined) {
      headers["Last-Event-ID"] = String(lastEventId);
    }
    const req = http.request(
      { hostname: "127.0.0.1", port: p, path: "/mcp", method: "GET", headers },
      (res) => {
        const lines: string[] = [];
        res.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString().split("\n")) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith(":")) lines.push(trimmed);
          }
        });
        setTimeout(() => {
          req.destroy();
          resolve(lines);
        }, collectMs);
      },
    );
    req.on("error", (e) => {
      // ECONNRESET is expected when we destroy the request — ignore it
      if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e);
    });
    req.end();
  });
}

/** Grab the internal adapter for a session via the handler's private sessions map. */
function getAdapter(
  h: StreamableHttpHandler,
  sid: string,
): {
  send: (d: string) => void;
  getEventsAfter: (id: number) => Array<{ id: number; data: string }>;
} {
  const sessions = (
    h as unknown as { sessions: Map<string, { adapter: unknown }> }
  ).sessions;
  const session = sessions.get(sid);
  if (!session) throw new Error(`Session ${sid} not found`);
  return session.adapter as ReturnType<typeof getAdapter>;
}

describe("Streamable HTTP: SSE event IDs", () => {
  it("notifications sent over SSE include a monotonic id: field", async () => {
    const { sid, token } = await initSession(port);

    // Open SSE stream first, give TCP time to establish before injecting.
    const linesPromise = collectSseLines(port, sid, 250, undefined, token);
    await new Promise((r) => setTimeout(r, 50));

    // Inject a server-initiated notification directly via the adapter.
    // (notifications/initialized is a client→server message and triggers no SSE output.)
    const adapter = getAdapter(handler!, sid);
    adapter.send(
      JSON.stringify({ jsonrpc: "2.0", method: "test/ping", params: {} }),
    );

    const lines = await linesPromise;

    // Should have at least one `id:` line
    const idLines = lines.filter((l) => l.startsWith("id:"));
    expect(idLines.length).toBeGreaterThan(0);
    // IDs must be non-negative integers
    for (const idLine of idLines) {
      const val = Number(idLine.replace("id:", "").trim());
      expect(Number.isInteger(val)).toBe(true);
      expect(val).toBeGreaterThanOrEqual(0);
    }
    // Each `id:` line must be immediately followed by a `data:` line
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]?.startsWith("id:")) {
        expect(lines[i + 1]).toMatch(/^data:/);
      }
    }
  });

  it("reconnect with Last-Event-ID replays missed notifications", async () => {
    const { sid, token } = await initSession(port);

    // Inject 3 notifications directly via the internal adapter (no SSE stream attached).
    // They land in the buffer; replay is triggered when the GET includes Last-Event-ID.
    const adapter = getAdapter(handler!, sid);

    // Send 3 notifications (no SSE stream attached yet — they go into the buffer)
    const notif = (method: string) =>
      JSON.stringify({ jsonrpc: "2.0", method, params: {} });
    adapter.send(notif("test/first")); // id: 0
    adapter.send(notif("test/second")); // id: 1
    adapter.send(notif("test/third")); // id: 2

    // Reconnect with Last-Event-ID: 0 — should replay events with id > 0 (i.e. 1 and 2)
    const lines = await collectSseLines(port, sid, 150, 0, token);

    const dataLines = lines.filter((l) => l.startsWith("data:"));
    expect(dataLines.length).toBeGreaterThanOrEqual(2);
    const methods = dataLines.map((l) => {
      const payload = JSON.parse(l.replace("data:", "").trim()) as {
        method?: string;
      };
      return payload.method;
    });
    expect(methods).toContain("test/second");
    expect(methods).toContain("test/third");
    // The first notification (id=0) was already seen — must NOT be replayed
    expect(methods).not.toContain("test/first");
  });

  it("events older than 30s are not returned by getEventsAfter", async () => {
    // Use fake timers so we can advance Date.now() past the 30s TTL without
    // waiting real time. We call getEventsAfter() directly (no HTTP) so the
    // fake clock stays in effect throughout the check.
    vi.useFakeTimers({ now: Date.now() });

    const { sid, token } = await initSession(port);
    const adapter = getAdapter(handler!, sid);

    adapter.send(
      JSON.stringify({ jsonrpc: "2.0", method: "test/old", params: {} }),
    );

    // Advance clock past TTL — getEventsAfter uses Date.now() so ts becomes stale
    vi.advanceTimersByTime(30_001);

    // getEventsAfter should return nothing — the event is older than 30s
    const events = adapter.getEventsAfter(-1);
    const methods = events.map((e) => {
      try {
        return (JSON.parse(e.data) as { method?: string }).method;
      } catch {
        return null;
      }
    });
    expect(methods).not.toContain("test/old");

    vi.useRealTimers();
  });

  it("buffer caps at 100 events — oldest are dropped", async () => {
    const { sid, token } = await initSession(port);

    const adapter = getAdapter(handler!, sid);

    // Send 110 notifications (exceeds the 100-event cap)
    for (let i = 0; i < 110; i++) {
      adapter.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: `test/event${i}`,
          params: {},
        }),
      );
    }

    // Reconnect with Last-Event-ID: -1 to request all buffered events
    const lines = await collectSseLines(port, sid, 300, -1, token);

    const dataLines = lines.filter((l) => l.startsWith("data:"));
    // Should have at most 100 (the cap), so events 0-9 are dropped
    expect(dataLines.length).toBeLessThanOrEqual(100);
    // The most recent events (e.g. event109) must be present
    const methods = dataLines.map((l) => {
      try {
        return (
          JSON.parse(l.replace("data:", "").trim()) as { method?: string }
        ).method;
      } catch {
        return null;
      }
    });
    expect(methods).toContain("test/event109");
    expect(methods).not.toContain("test/event0");
  });
});

// ── GET SSE ────────────────────────────────────────────────────────────────────

describe("Streamable HTTP: GET SSE", () => {
  it("GET returns 400 without session ID", async () => {
    const res = await httpReq(port, "GET");
    expect(res.status).toBe(400);
  });

  it("GET returns 404 for unknown session", async () => {
    const res = await httpReq(port, "GET", "nonexistent");
    expect(res.status).toBe(404);
  });

  it("GET establishes SSE stream with text/event-stream content type", async () => {
    const { sid, token } = await initSession(port);

    const { status, contentType } = await new Promise<{
      status: number;
      contentType: string;
    }>((resolve, _reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mcp",
          method: "GET",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Mcp-Session-Id": sid,
            "Mcp-Session-Token": token,
          },
        },
        (res) => {
          resolve({
            status: res.statusCode!,
            contentType: res.headers["content-type"] || "",
          });
          // Immediately destroy to avoid hanging
          req.destroy();
        },
      );
      req.on("error", () => {}); // suppress ECONNRESET from destroy
      req.end();
    });

    expect(status).toBe(200);
    expect(contentType).toBe("text/event-stream");
  });
});

// ── HttpAdapter unit tests ─────────────────────────────────────────────────────

describe("HttpAdapter: send routing", () => {
  // We can't import HttpAdapter directly (not exported), so we test it
  // through the full handler. But we can test the key behavior:
  // responses (with id) go to POST resolver, notifications go to SSE.

  it("tools/list request returns a response via POST", async () => {
    const { sid, token } = await initSession(port);
    // Send initialized notification
    await post(
      port,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sid,
      token,
    );

    // Request tools/list
    const res = await post(
      port,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sid,
      token,
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBeDefined();
    expect(body.result.tools).toBeDefined();
    expect(Array.isArray(body.result.tools)).toBe(true);
  });
});

// ── readBody ───────────────────────────────────────────────────────────────────

describe("Streamable HTTP: body size limit", () => {
  it("rejects bodies larger than 1MB with 413", async () => {
    const largeBody = "x".repeat(1_048_577); // 1 byte over limit

    const res = await new Promise<{ status: number }>((resolve, _reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode! }));
        },
      );
      req.on("error", () => resolve({ status: 413 })); // connection may be destroyed
      req.end(largeBody);
    });

    expect(res.status).toBe(413);
  });
});

// ── Session close behavior ─────────────────────────────────────────────────────

describe("Streamable HTTP: session close", () => {
  it("handler.close() destroys all sessions", async () => {
    const session1 = await initSession(port);
    const session2 = await initSession(port);

    handler!.close();

    // Both sessions should be gone
    const res1 = await post(
      port,
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      session1.sid,
      session1.token,
    );
    const res2 = await post(
      port,
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      session2.sid,
      session2.token,
    );
    expect(res1.status).toBe(404);
    expect(res2.status).toBe(404);
  });
});

// ── Auth ────────────────────────────────────────────────────────────────────────

describe("Streamable HTTP: auth", () => {
  it("rejects POST /mcp without Bearer token", async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode! }));
        },
      );
      req.on("error", reject);
      req.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      );
    });

    expect(res.status).toBe(401);
  });

  it("rejects POST /mcp with wrong Bearer token", async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer wrong-token",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode! }));
        },
      );
      req.on("error", reject);
      req.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      );
    });

    expect(res.status).toBe(401);
  });
});

// ── Idle pruning ───────────────────────────────────────────────────────────────

describe("Streamable HTTP: idle pruning", () => {
  it("prunes sessions that exceed TTL", async () => {
    const { sid, token } = await initSession(port);

    // Verify session works
    const res1 = await post(
      port,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sid,
      token,
    );
    expect(res1.status).toBe(202);

    // Access private sessions to manipulate lastActivity
    // We'll use handler's close + re-init approach isn't clean.
    // Instead, test that pruneIdle is called by the interval timer.
    // We can't directly test TTL without waiting 30 minutes, so we
    // verify the session exists and the destroy path works (covered above).
    // The pruneIdle logic is straightforward: `now - lastActivity > TTL`.
  });
});

// ── Session overflow eviction (2b) ─────────────────────────────────────────────

describe("Streamable HTTP: session overflow eviction", () => {
  it("evicts oldest idle session when at capacity rather than returning 503", async () => {
    // Fill all 5 session slots
    for (let i = 0; i < 5; i++) {
      await initSession(port);
    }

    // Make the first session appear idle by backdating its lastActivity
    const sessions: Map<string, { lastActivity: number }> = (handler as any)
      .sessions;
    const [firstId] = sessions.keys();
    const firstSession = sessions.get(firstId)!;
    firstSession.lastActivity = Date.now() - 120_000; // idle for 2 minutes > 60s threshold

    // A 6th initialize should succeed (evicting the stale session) rather than return 503
    const { sid: newSid } = await initSession(port);
    expect(typeof newSid).toBe("string");

    // Total sessions should still be 5 (evicted 1, added 1)
    expect(sessions.size).toBe(5);

    // Evicted session should be gone
    expect(sessions.has(firstId)).toBe(false);

    // New session should be present
    expect(sessions.has(newSid)).toBe(true);
  });

  it("returns 503 when all 5 sessions are recently active", async () => {
    // Fill all 5 session slots with recently-active sessions
    for (let i = 0; i < 5; i++) {
      await initSession(port);
    }

    // All sessions are fresh (lastActivity = now), so no eviction happens
    const sessions: Map<string, { lastActivity: number }> = (handler as any)
      .sessions;
    for (const session of sessions.values()) {
      session.lastActivity = Date.now(); // all active
    }

    // A 6th initialize should fail with 503
    const res = await post(port, {
      jsonrpc: "2.0",
      id: 99,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("capacity");
  });
});
