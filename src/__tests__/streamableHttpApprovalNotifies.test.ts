/**
 * An approval raised for a REMOTE client must reach a person.
 *
 * The bridge gates its own MCP tools on two transports. A `tools/call` that
 * needs approval over the WebSocket transport is queued through
 * `enqueueApprovalWithDispatch`, which also announces it on the configured
 * channels (webhook, Web Push, ntfy). The same call over Streamable HTTP —
 * the transport remote MCP clients use — was queued with a bare
 * `queue.request()`, which announces nothing. Same tool, same gate setting,
 * same queue; one transport told a person and the other waited in silence
 * until the approval expired and the call failed.
 *
 * That divergence had no test because the one end-to-end approval test
 * re-implements the gate inside the test file, so it exercises its own copy
 * and can never see what `Bridge` actually wires. These tests start the REAL
 * `Bridge` and make a real call on each transport:
 *
 *   - WebSocket is the control. It already notifies, so it proves this
 *     harness can observe a notification at all — a test of the HTTP path
 *     alone could pass or fail for reasons that have nothing to do with it.
 *   - Streamable HTTP is the path under test, and must send the same notice.
 *
 * What is observed is the last hop: an outbound send to each configured
 * channel. DNS is stubbed and `fetch` is replaced, so nothing leaves the
 * process; the calls TO the bridge use `node:http` and `ws`, which the
 * replaced `fetch` does not touch. Every host, token and topic is synthetic.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { PendingApproval } from "../approvalQueue.js";
import {
  getApprovalQueue,
  resetApprovalQueueForTests,
} from "../approvalQueue.js";
import type { Config } from "../config.js";
import { makeConfig as buildConfig } from "./helpers/fixtures.js";
import { send, waitFor } from "./wsHelpers.js";

// The notification senders resolve DNS before sending (pinnedSend) and refuse
// an unresolvable name. Only `lookup` is replaced — a whole `Bridge` is in
// this import graph, so everything else on the module stays real.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = vi
    .fn()
    .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  return { ...actual, lookup, default: { ...actual, lookup } };
});
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
// Partial: the tool dispatch below runs inside `withSpan`, which must stay
// real — a mock without it turns every approved call into a tool error.
vi.mock("../telemetry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telemetry.js")>()),
  initTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(async () => {}),
}));

const { Bridge } = await import("../bridge.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

const AUTH = "bridge-fixed-token";
/** Registered in slim mode, needs no editor, and has no side effects. */
const TOOL = "getToolCapabilities";

/** Every channel the bridge can be configured with, all set. */
const CHANNELS = {
  approvalWebhookUrl: "https://hooks.example.test/approvals",
  pushServiceUrl: "https://push.example.test",
  pushServiceToken: "synthetic-relay-token",
  pushServiceBaseUrl: "https://bridge.example.test",
  pushServiceAllowPrivate: false,
  ntfyTopic: "synthetic-topic",
  ntfyServer: "https://ntfy.example.test",
} as const;

/** Where each channel's send lands. */
const WEBHOOK_SEND = CHANNELS.approvalWebhookUrl;
const PUSH_SEND = `${CHANNELS.pushServiceUrl}/push`;
const NTFY_SEND = `${CHANNELS.ntfyServer}/`;
const CHANNEL_SENDS = [WEBHOOK_SEND, PUSH_SEND, NTFY_SEND].sort();

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
    fullMode: false,
    analyticsEnabled: false,
    wsPingIntervalMs: 0,
    lspVerbosity: "minimal",
    // "all": every tool call queues, so a harmless read is enough to reach
    // the gate. The gate decides WHETHER to ask; this file is about what
    // happens once it has decided to.
    approvalGate: "all",
    ...overrides,
  });
}

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}

let tempDir = "";
let sent: Sent[] = [];
let bridge: InstanceType<typeof Bridge> | null = null;
const clients: WebSocket[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "http-approval-notify-"));
  // A real Bridge writes its lock file, token and ledgers under these.
  const patchworkHome = path.join(tempDir, ".patchwork");
  fs.mkdirSync(patchworkHome, { recursive: true });
  vi.stubEnv("HOME", tempDir);
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tempDir, ".claude"));
  vi.stubEnv("PATCHWORK_HOME", patchworkHome);
  resetApprovalQueueForTests();
  sent = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    } catch {
      // not one of ours
    }
    sent.push({ url: String(url), body });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
  clients.length = 0;
  await bridge?.stop();
  bridge = null;
  globalThis.fetch = realFetch;
  resetApprovalQueueForTests();
  vi.unstubAllEnvs();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // A lingering handle makes this EBUSY on Windows; the OS reaps the dir.
  }
});

// ── Harness ─────────────────────────────────────────────────────────────────

/**
 * How long to wait for an approval to appear, and then for its notices. Both
 * return the moment the thing happens, so on a passing run they cost
 * milliseconds; they are sized for a slow CI cell under coverage, and are only
 * ever used up when the thing never happens (which is the defect). Together
 * they stay inside the 15 s test timeout.
 */
const PENDING_BUDGET_MS = 8_000;
const SEND_BUDGET_MS = 5_000;

/** Poll until `probe` yields a value; `undefined` when the budget runs out. */
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

async function startBridge(overrides: Partial<Config> = CHANNELS) {
  const workspace = fs.mkdtempSync(path.join(tempDir, "ws-"));
  bridge = new Bridge(makeConfig(workspace, overrides));
  await bridge.start();
  return bridge.getPort();
}

/** POST one JSON-RPC message to /mcp. */
function post(
  port: number,
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
      { hostname: "127.0.0.1", port, path: "/mcp", method: "POST", headers },
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

/** A remote client: initialize over Streamable HTTP, then call the tool. */
async function callOverHttp(port: number) {
  const init = await post(port, {
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
  await post(
    port,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sid,
  );
  const response = post(
    port,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: TOOL, arguments: {} },
    },
    sid,
  ).then((r) => (JSON.parse(r.body) as { result?: ToolResult }).result);
  return { sessionId: sid, response };
}

/** A local client: the same call over the WebSocket transport. */
async function callOverWebSocket(port: number) {
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
  const response = waitFor(ws, (m) => m.id === 2, 10_000).then(
    (m) => m.result as ToolResult | undefined,
  );
  send(ws, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: TOOL, arguments: {} },
  });
  return { sessionId, response };
}

const TRANSPORTS = {
  http: callOverHttp,
  websocket: callOverWebSocket,
} as const;

/**
 * Make the call and stop at the moment a person is being waited on. Returns
 * the pending approval and whatever had been sent to the channels by then.
 */
async function callUntilWaitingOnAPerson(
  port: number,
  transport: keyof typeof TRANSPORTS,
  // `sendBudgetMs` is overridden only by the test that expects NO notice,
  // which would otherwise sit out the whole budget on every passing run.
  { sendBudgetMs = SEND_BUDGET_MS }: { sendBudgetMs?: number } = {},
) {
  sent.length = 0;
  const queue = getApprovalQueue();
  const { sessionId, response } = await TRANSPORTS[transport](port);
  // `owned`: created by a live caller in this process, i.e. by this call.
  const pending = await until(
    () => queue.list().find((p) => p.owned && p.toolName === TOOL),
    PENDING_BUDGET_MS,
  );
  // The sends are fire-and-forget behind a DNS lookup; give them a moment.
  // On the defect this simply runs out — nothing was dispatched.
  const channelSends = () => sent.filter((s) => CHANNEL_SENDS.includes(s.url));
  await until(
    () => (channelSends().length >= CHANNEL_SENDS.length ? true : undefined),
    sendBudgetMs,
  );
  return { queue, sessionId, response, pending, notices: channelSends() };
}

/**
 * A notice with the per-call values removed, so two approvals of the same
 * kind can be compared: ids, the single-use token and timestamps differ on
 * every call by construction, and everything else must not.
 */
function comparable(notices: Sent[], pending: PendingApproval | undefined) {
  const perCall = [pending?.callId, pending?.sessionId].filter(
    (v): v is string => typeof v === "string",
  );
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") {
      return perCall.reduce((s, id) => s.split(id).join("<per-call>"), v);
    }
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, val]) => [
          k,
          k === "approvalToken" ||
          k === "x-approval-token" ||
          k === "requestedAt" ||
          k === "expiresAt"
            ? `<${typeof val}>`
            : scrub(val),
        ]),
      );
    }
    return v;
  };
  return notices
    .map((n) => ({ url: n.url, body: scrub(n.body) }))
    .sort((a, b) => a.url.localeCompare(b.url));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("a tools/call that needs approval is announced, on either transport", () => {
  it("WebSocket (the control): every configured channel hears about it", async () => {
    const port = await startBridge();
    const { queue, response, pending, notices } =
      await callUntilWaitingOnAPerson(port, "websocket");
    try {
      expect(pending, "the WebSocket gate queued nothing").toBeDefined();
      expect(notices.map((n) => n.url).sort()).toEqual(CHANNEL_SENDS);
    } finally {
      if (pending) queue.reject(pending.callId);
      await response;
    }
  });

  it("Streamable HTTP: it is queued for a person (the precondition)", async () => {
    // Not the defect — the setup. If this fails the tests below would be
    // failing for the wrong reason: the call never reached the gate's queue.
    const port = await startBridge();
    const { queue, sessionId, response, pending } =
      await callUntilWaitingOnAPerson(port, "http");
    try {
      expect(pending, "the Streamable HTTP gate queued nothing").toBeDefined();
      expect(pending?.toolName).toBe(TOOL);
      expect(pending?.sessionId).toBe(sessionId);
    } finally {
      if (pending) queue.reject(pending.callId);
      await response;
    }
  });

  it("Streamable HTTP: every configured channel hears about it", async () => {
    const port = await startBridge();
    const { queue, response, pending, notices } =
      await callUntilWaitingOnAPerson(port, "http");
    try {
      expect(pending, "the Streamable HTTP gate queued nothing").toBeDefined();
      expect(notices.map((n) => n.url).sort()).toEqual(CHANNEL_SENDS);
      // Each notice is about THIS approval.
      const by = (url: string) => notices.find((n) => n.url === url)?.body;
      expect(by(WEBHOOK_SEND)).toMatchObject({
        toolName: TOOL,
        callId: pending?.callId,
      });
      expect(by(PUSH_SEND)).toMatchObject({
        toolName: TOOL,
        callId: pending?.callId,
        bridgeCallbackBase: CHANNELS.pushServiceBaseUrl,
      });
      expect(typeof by(PUSH_SEND)?.approvalToken).toBe("string");
      expect(by(NTFY_SEND)).toMatchObject({ topic: CHANNELS.ntfyTopic });
    } finally {
      if (pending) queue.reject(pending.callId);
      await response;
    }
  });

  it("Streamable HTTP sends the SAME notice the WebSocket transport sends", async () => {
    // The requirement in one assertion. Not "some notification": the same
    // channels with the same content, for the same call, on one bridge.
    const port = await startBridge();
    const viaWs = await callUntilWaitingOnAPerson(port, "websocket");
    if (viaWs.pending) viaWs.queue.reject(viaWs.pending.callId);
    await viaWs.response;

    const viaHttp = await callUntilWaitingOnAPerson(port, "http");
    try {
      expect(viaWs.notices).toHaveLength(CHANNEL_SENDS.length);
      expect(comparable(viaHttp.notices, viaHttp.pending)).toEqual(
        comparable(viaWs.notices, viaWs.pending),
      );
    } finally {
      if (viaHttp.pending) viaHttp.queue.reject(viaHttp.pending.callId);
      await viaHttp.response;
    }
  });

  it("Streamable HTTP: with no channel configured it still queues, and sends nothing", async () => {
    // The other direction: dispatch is driven by the settings, not invented.
    const port = await startBridge({});
    const { queue, response, pending, notices } =
      await callUntilWaitingOnAPerson(port, "http", { sendBudgetMs: 200 });
    try {
      expect(pending, "the Streamable HTTP gate queued nothing").toBeDefined();
      expect(notices).toEqual([]);
    } finally {
      if (pending) queue.reject(pending.callId);
      await response;
    }
  });
});

describe("a Streamable HTTP approval decides the call exactly as before", () => {
  // Routing through the dispatching helper must change WHO HEARS about the
  // approval and nothing about what the decision then does.
  const text = (r: ToolResult | undefined) => r?.content?.[0]?.text ?? "";

  it("approved: the tool runs — the grant still matches the action", async () => {
    // The transport revalidates the grant's approved-action identity (tool,
    // params, session, tier) before dispatch. A request rebuilt with any of
    // those changed is refused as `approval_identity_mismatch`.
    const port = await startBridge();
    const { queue, response, pending } = await callUntilWaitingOnAPerson(
      port,
      "http",
    );
    expect(pending, "the Streamable HTTP gate queued nothing").toBeDefined();
    if (pending) queue.approve(pending.callId);
    const result = await response;
    expect(text(result)).not.toMatch(/approval_identity_mismatch/);
    expect(result?.isError).not.toBe(true);
  });

  it("rejected: the tool does not run", async () => {
    const port = await startBridge();
    const { queue, response, pending } = await callUntilWaitingOnAPerson(
      port,
      "http",
    );
    expect(pending, "the Streamable HTTP gate queued nothing").toBeDefined();
    if (pending) queue.reject(pending.callId);
    const result = await response;
    expect(result?.isError).toBe(true);
    expect(text(result)).toMatch(/rejected by human reviewer/);
  });

  it("expired: the tool does not run", async () => {
    const port = await startBridge();
    const { queue, response, pending } = await callUntilWaitingOnAPerson(
      port,
      "http",
    );
    expect(pending, "the Streamable HTTP gate queued nothing").toBeDefined();
    queue.clear(); // resolves what is pending as "expired"
    const result = await response;
    expect(result?.isError).toBe(true);
    expect(text(result)).toMatch(/expired without human decision/);
  });

  it("cancelled: the tool does not run", async () => {
    const port = await startBridge();
    const { queue, response, pending } = await callUntilWaitingOnAPerson(
      port,
      "http",
    );
    expect(pending, "the Streamable HTTP gate queued nothing").toBeDefined();
    if (pending) queue.cancel(pending.callId);
    const result = await response;
    expect(result?.isError).toBe(true);
    expect(text(result)).toMatch(/cancelled before a human decision/);
  });
});
