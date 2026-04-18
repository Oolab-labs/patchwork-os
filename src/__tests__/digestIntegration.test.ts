/**
 * Integration regression: the Phase 3 session-start digest must appear in
 * the `initialize` response's `instructions` field, and must reflect traces
 * recorded AFTER the StreamableHttpHandler was constructed.
 *
 * Two bugs this test pins down (both shipped in PR #34):
 *   1. WebSocket path called refreshRecentTracesDigest() fire-and-forget,
 *      then setInstructions() on the next sync line — first session saw an
 *      empty cache.
 *   2. HTTP path captured instructions as a fixed string at handler
 *      construction — the digest was frozen at bridge-boot time.
 *
 * Both bugs would cause the `instructions` field to be missing the
 * `RECENT DECISIONS` block. This test asserts the block is present AND
 * contains a trace recorded between handler creation and session init.
 */

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionTraceLog } from "../decisionTraceLog.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { StreamableHttpHandler } from "../streamableHttp.js";
import { buildRecentTracesDigest } from "../tools/recentTracesDigest.js";

vi.mock("../tools/index.js", () => ({
  registerAllTools: () => {},
}));

const logger = new Logger(false);
const TOKEN = "test-token-digest-integration-0000";

function makeDeps() {
  return {
    config: {
      workspace: "/tmp/digest-integration",
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
    },
    extensionClient: {
      isConnected: () => false,
      on: () => {},
      request: () => Promise.resolve(null),
      removeListener: () => {},
    },
    activityLog: {
      recordTool: () => {},
      recordEvent: () => {},
      getStats: () => ({
        totalToolCalls: 0,
        errorCount: 0,
        avgDurationMs: 0,
        toolBreakdown: {},
      }),
      queryTimeline: () => [],
    },
    fileLock: {
      acquire: () => Promise.resolve({ release: () => {} }),
    },
  };
}

async function post(port: number, data: Record<string, unknown>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = JSON.stringify(data);
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
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("session-start digest: HTTP initialize response", () => {
  let server: Server | null = null;
  let handler: StreamableHttpHandler | null = null;
  let port: number;
  let dir: string;
  let decisionTraceLog: DecisionTraceLog;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "digest-integration-"));
    decisionTraceLog = new DecisionTraceLog({ dir });
    const deps = makeDeps();
    server = new Server(TOKEN, logger);

    handler = new StreamableHttpHandler(
      deps.config as never,
      {} as never,
      deps.extensionClient as never,
      deps.activityLog as never,
      deps.fileLock as never,
      new Map(),
      null,
      logger,
      () => [],
      () => null,
      null,
      // Provider mirrors what bridge.ts wires in production: refresh digest
      // (from a log that may have been written to SINCE handler construction)
      // then return an instructions string containing the digest block.
      async () => {
        const lines = await buildRecentTracesDigest({ decisionTraceLog });
        return lines.length > 0
          ? `claude-ide-bridge test\n\n${lines.join("\n")}\n`
          : "claude-ide-bridge test\n";
      },
    );

    server.httpMcpHandler = (req, res) => handler!.handle(req, res);
    port = await server.findAndListen(null);
  });

  afterEach(async () => {
    handler?.close();
    handler = null;
    await server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders a trace recorded BEFORE initialize in the instructions block", async () => {
    decisionTraceLog.record({
      ref: "PR-pre",
      problem: "pre-init problem",
      solution: "pre-init solution",
      workspace: "/tmp/ws",
    });

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
    const body = JSON.parse(res.body);
    const instructions = body.result?.instructions;
    expect(typeof instructions).toBe("string");
    expect(instructions).toContain("RECENT DECISIONS (last 12h):");
    expect(instructions).toContain("PR-pre");
  });

  it("reflects a trace recorded AFTER handler construction but before init", async () => {
    // Handler is already constructed (in beforeEach). Now write a trace.
    // The HTTP bug was that instructions were captured at construction —
    // if that regressed, this trace would not appear.
    decisionTraceLog.record({
      ref: "PR-post-construct",
      problem: "written between handler construct and session init",
      solution: "must still appear in digest via instructionsProvider",
      workspace: "/tmp/ws",
      tags: ["regression", "phase-3"],
    });

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
    const body = JSON.parse(res.body);
    const instructions = body.result?.instructions;
    expect(typeof instructions).toBe("string");
    expect(instructions).toContain("RECENT DECISIONS (last 12h):");
    expect(instructions).toContain("PR-post-construct");
  });

  it("second session sees traces written between the two sessions", async () => {
    // Session 1 — no traces yet, digest block should be absent.
    const res1 = await post(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    const body1 = JSON.parse(res1.body);
    const instructions1 = body1.result?.instructions ?? "";
    expect(instructions1).not.toContain("RECENT DECISIONS");

    // Record between sessions.
    decisionTraceLog.record({
      ref: "PR-between",
      problem: "written between session 1 and session 2",
      solution: "session 2 must see this",
      workspace: "/tmp/ws",
    });

    // Session 2 — must include the new trace.
    const res2 = await post(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    const body2 = JSON.parse(res2.body);
    const instructions2 = body2.result?.instructions;
    expect(instructions2).toContain("RECENT DECISIONS (last 12h):");
    expect(instructions2).toContain("PR-between");
  });
});
