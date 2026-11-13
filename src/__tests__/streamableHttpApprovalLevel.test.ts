/**
 * Both transports hold a tool call at the SAME approval level.
 *
 * The bridge's live approval level is `server.approvalGate`. It is not simply
 * the configured value: under the governed profile (`config.json`
 * `profile: "governed"`) the bridge raises it to at least `"high"` at
 * startup, and `POST /settings` changes it on a running bridge. The
 * WebSocket gate read that live value. The Streamable HTTP gate — the
 * transport remote MCP clients use — read the configured
 * `config.approvalGate` instead, so with the governed profile and no
 * `approvalGate` in config a high-tier call over HTTP was not held, and a
 * level set through `POST /settings` never reached HTTP sessions.
 *
 * These tests start the REAL `Bridge` and make the same call on each
 * transport. WebSocket is the control throughout: it proves the harness can
 * observe a held call, so an HTTP failure is about HTTP and nothing else.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  getApprovalQueue,
  resetApprovalQueueForTests,
} from "../approvalQueue.js";
import type { Config } from "../config.js";
import {
  FLAG_ENFORCE_POLICY,
  FLAG_WORKER_AUTONOMY,
  setFlag,
} from "../featureFlags.js";
import { _resetActiveProfileForTesting } from "../governance/profile.js";
import { makeConfig as buildConfig } from "./helpers/fixtures.js";
import { send, waitFor } from "./wsHelpers.js";

vi.mock("../bridgeToken.js", () => ({
  loadOrCreateBridgeToken: vi.fn(() => "bridge-test-token"),
}));
vi.mock("../probe.js", () => ({ probeAll: vi.fn(async () => ({})) }));
vi.mock("../pluginLoader.js", () => ({
  loadPlugins: vi.fn(async () => []),
  loadPluginsFull: vi.fn(async () => []),
}));
vi.mock("../bridgeToolsRules.js", () => ({
  repairBridgeToolsRulesIfStale: vi.fn(),
}));
// Partial: tool dispatch runs inside `withSpan`, which must stay real.
vi.mock("../telemetry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telemetry.js")>()),
  initTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(async () => {}),
}));

const { Bridge } = await import("../bridge.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

const AUTH = "bridge-fixed-token";
/**
 * High tier, needs no editor. Held calls are always rejected below, so it
 * never runs while held; where the level lets it through it runs in an empty
 * temp directory and fails harmlessly (not a git repository).
 */
const HIGH_TOOL = "gitFetch";
/** Low tier: held only at level "all". */
const LOW_TOOL = "getToolCapabilities";

type Transport = "http" | "websocket";
const BOTH: Transport[] = ["websocket", "http"];

function makeConfig(workspace: string, overrides: Partial<Config>): Config {
  return buildConfig({
    workspace,
    workspaceFolders: [workspace],
    ideName: "Test",
    maxResultSize: 512 * 1024,
    gracePeriodMs: 1_000,
    driver: "none",
    toolRateLimit: 100,
    fixedToken: AUTH,
    fullMode: true,
    analyticsEnabled: false,
    wsPingIntervalMs: 0,
    lspVerbosity: "minimal",
    // What the CLI parser yields when nothing sets a level.
    approvalGate: "off",
    ...overrides,
  });
}

let tempDir = "";
let patchworkHome = "";
let bridge: InstanceType<typeof Bridge> | null = null;
const clients: WebSocket[] = [];

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "http-approval-level-"));
  patchworkHome = path.join(tempDir, ".patchwork");
  fs.mkdirSync(patchworkHome, { recursive: true });
  vi.stubEnv("HOME", tempDir);
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tempDir, ".claude"));
  vi.stubEnv("PATCHWORK_HOME", patchworkHome);
  resetApprovalQueueForTests();
});

afterEach(async () => {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
  clients.length = 0;
  await bridge?.stop();
  bridge = null;
  resetApprovalQueueForTests();
  _resetActiveProfileForTesting();
  // The governed profile turns these on process-wide.
  setFlag(FLAG_ENFORCE_POLICY, false);
  setFlag(FLAG_WORKER_AUTONOMY, false);
  vi.unstubAllEnvs();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // A lingering handle makes this EBUSY on Windows; the OS reaps the dir.
  }
});

// ── Harness ─────────────────────────────────────────────────────────────────

const PENDING_BUDGET_MS = 8_000;

async function until<T>(
  probe: () => T | undefined,
  budgetMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Start a bridge whose `config.json` holds exactly `patchworkConfig`. */
async function startBridge(
  patchworkConfig: Record<string, unknown>,
  overrides: Partial<Config> = {},
) {
  fs.writeFileSync(
    path.join(patchworkHome, "config.json"),
    JSON.stringify(patchworkConfig),
  );
  const workspace = fs.mkdtempSync(path.join(tempDir, "ws-"));
  bridge = new Bridge(makeConfig(workspace, overrides));
  await bridge.start();
  return bridge.getPort();
}

function request(
  port: number,
  urlPath: string,
  data: Record<string, unknown>,
  sessionId?: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${AUTH}`,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "POST", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(data));
  });
}

async function callOverHttp(port: number, tool: string) {
  const init = await request(port, "/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  });
  const sid = init.headers["mcp-session-id"];
  if (typeof sid !== "string") {
    throw new Error(`initialize returned no session id (${init.status})`);
  }
  await request(
    port,
    "/mcp",
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sid,
  );
  const response = request(
    port,
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: tool, arguments: {} },
    },
    sid,
  ).then(() => undefined);
  return { sessionId: sid, response };
}

async function callOverWebSocket(port: number, tool: string) {
  const sessionId = randomUUID();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: {
      "x-claude-code-ide-authorization": AUTH,
      "x-claude-code-session-id": sessionId,
    },
  });
  clients.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  send(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await waitFor(ws, (m) => m.id === 1);
  send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
  const response = waitFor(ws, (m) => m.id === 2, 10_000).then(() => undefined);
  send(ws, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: tool, arguments: {} },
  });
  return { sessionId, response };
}

/**
 * Make one call and report whether it was held for a person. A held call is
 * rejected straight away, so nothing held ever runs.
 *
 * "Not held" is decided by the call FINISHING with no approval having been
 * queued for its session — not by a timeout — so a passing run costs only
 * as long as the call takes.
 */
async function wasHeld(
  port: number,
  transport: Transport,
  tool: string,
): Promise<boolean> {
  const queue = getApprovalQueue();
  const { sessionId, response } =
    transport === "http"
      ? await callOverHttp(port, tool)
      : await callOverWebSocket(port, tool);
  let finished = false;
  void response.then(() => {
    finished = true;
  });
  const outcome = await until(() => {
    const pending = queue
      .list()
      .find((p) => p.toolName === tool && p.sessionId === sessionId);
    if (pending) return pending;
    return finished ? ("finished" as const) : undefined;
  }, PENDING_BUDGET_MS);
  if (outcome === undefined) {
    throw new Error(`${transport} call neither queued nor finished`);
  }
  if (outcome === "finished") return false;
  queue.reject(outcome.callId);
  await response;
  return true;
}

async function heldOn(port: number, tool: string) {
  const result: Record<Transport, boolean> = { websocket: false, http: false };
  for (const t of BOTH) result[t] = await wasHeld(port, t, tool);
  return result;
}

async function setLevel(port: number, level: "off" | "high" | "all") {
  const res = await request(port, "/settings", { approvalGate: level });
  expect(res.status, `POST /settings → ${res.body}`).toBe(200);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("governed profile, no approvalGate in config", () => {
  it("a high-tier call is held on BOTH transports (the governed floor)", async () => {
    const port = await startBridge({ profile: "governed" });
    expect(await heldOn(port, HIGH_TOOL)).toEqual({
      websocket: true,
      http: true,
    });
  });

  it("a low-tier call is held on neither (the floor is high, not all)", async () => {
    const port = await startBridge({ profile: "governed" });
    expect(await heldOn(port, LOW_TOOL)).toEqual({
      websocket: false,
      http: false,
    });
  });

  it("a level changed through POST /settings reaches both transports", async () => {
    const port = await startBridge({ profile: "governed" });
    await setLevel(port, "all");
    expect(await heldOn(port, LOW_TOOL)).toEqual({
      websocket: true,
      http: true,
    });
  });
});

describe("compat profile", () => {
  // At startup both transports already agreed under compat (the live level
  // IS the configured one); these pin that nothing there changes. The
  // `POST /settings` case diverged under compat too, and is fixed with the rest.
  it("level off: a high-tier call is held on neither", async () => {
    const port = await startBridge({});
    expect(await heldOn(port, HIGH_TOOL)).toEqual({
      websocket: false,
      http: false,
    });
  });

  it("level high: a high-tier call is held on both", async () => {
    const port = await startBridge({}, { approvalGate: "high" });
    expect(await heldOn(port, HIGH_TOOL)).toEqual({
      websocket: true,
      http: true,
    });
  });

  it("a level changed through POST /settings reaches both transports", async () => {
    const port = await startBridge({});
    await setLevel(port, "high");
    expect(await heldOn(port, HIGH_TOOL)).toEqual({
      websocket: true,
      http: true,
    });
  });
});
