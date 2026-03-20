import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";
import { send, waitFor } from "./wsHelpers.js";

const logger = new Logger(false);
let server: Server | null = null;
let transport: McpTransport | null = null;
let wsClient: WebSocket | null = null;

async function setup(): Promise<{ ws: WebSocket }> {
  server = new Server("prompts-token", logger);
  transport = new McpTransport(logger);

  server.on("connection", (ws: WebSocket) => {
    transport?.attach(ws);
  });

  const port = await server.findAndListen(null);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { "x-claude-code-ide-authorization": "prompts-token" },
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  // MCP handshake
  send(ws, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  const initResp = await waitFor(ws, (m) => m.id === 0);

  // Verify prompts capability is advertised
  const result = (initResp.result as Record<string, unknown>) ?? {};
  const caps = (result.capabilities as Record<string, unknown>) ?? {};
  expect(caps.prompts).toBeDefined();

  send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((r) => setTimeout(r, 10));

  wsClient = ws;
  return { ws };
}

afterEach(async () => {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.close();
  }
  wsClient = null;
  await server?.close();
  server = null;
  transport = null;
});

describe("prompts/list", () => {
  it("returns prompt list after initialization", async () => {
    const { ws } = await setup();
    send(ws, { jsonrpc: "2.0", id: 1, method: "prompts/list", params: {} });
    const resp = await waitFor(ws, (m) => m.id === 1);
    expect(resp.error).toBeUndefined();
    const result = resp.result as { prompts: unknown[] };
    expect(Array.isArray(result.prompts)).toBe(true);
    expect(result.prompts.length).toBeGreaterThan(0);
    // Verify shape of first prompt
    const first = result.prompts[0] as Record<string, unknown>;
    expect(typeof first.name).toBe("string");
    expect(typeof first.description).toBe("string");
  });

  it("returns -32600 before initialized", async () => {
    server = new Server("prompts-token-pre", logger);
    transport = new McpTransport(logger);
    server.on("connection", (ws: WebSocket) => {
      transport?.attach(ws);
    });
    const port = await server.findAndListen(null);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": "prompts-token-pre" },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    // Send initialize but NOT notifications/initialized
    send(ws, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    await waitFor(ws, (m) => m.id === 0);
    // prompts/list before initialized
    send(ws, { jsonrpc: "2.0", id: 1, method: "prompts/list", params: {} });
    const resp = await waitFor(ws, (m) => m.id === 1);
    expect(resp.error).toBeDefined();
    const err = resp.error as { code: number };
    expect(err.code).toBe(-32600);
    ws.close();
    await server.close();
  });
});

describe("prompts/get", () => {
  it("returns filled messages for a known prompt with required args", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 2,
      method: "prompts/get",
      params: { name: "review-file", arguments: { file: "/src/foo.ts" } },
    });
    const resp = await waitFor(ws, (m) => m.id === 2);
    expect(resp.error).toBeUndefined();
    const result = resp.result as { messages: unknown[] };
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    const msg = result.messages[0] as {
      role: string;
      content: { type: string; text: string };
    };
    expect(msg.role).toBe("user");
    expect(msg.content.type).toBe("text");
    expect(msg.content.text).toContain("/src/foo.ts");
  });

  it("returns -32602 for unknown prompt name", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 3,
      method: "prompts/get",
      params: { name: "does-not-exist", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 3);
    expect(resp.error).toBeDefined();
    const err = resp.error as { code: number };
    expect(err.code).toBe(-32602);
  });

  it("returns -32602 when required argument is missing", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 4,
      method: "prompts/get",
      params: { name: "review-file", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 4);
    expect(resp.error).toBeDefined();
    const err = resp.error as { code: number };
    expect(err.code).toBe(-32602);
  });

  it("returns -32602 when name param is missing", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 5,
      method: "prompts/get",
      params: { arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 5);
    expect(resp.error).toBeDefined();
    const err = resp.error as { code: number };
    expect(err.code).toBe(-32602);
  });

  it("returns messages for debug-context with no arguments", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 6,
      method: "prompts/get",
      params: { name: "debug-context", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 6);
    expect(resp.error).toBeUndefined();
    const result = resp.result as { messages: unknown[] };
    expect(result.messages.length).toBeGreaterThan(0);
  });

  // ── Dispatch prompts ──────────────────────────────────────────────────────

  it("project-status: returns tool-calling instructions", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 20,
      method: "prompts/get",
      params: { name: "project-status", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 20);
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      description: string;
      messages: Array<{ content: { text: string } }>;
    };
    expect(result.messages.length).toBeGreaterThan(0);
    const text = result.messages[0].content.text;
    expect(text).toContain("getGitStatus");
    expect(text).toContain("getDiagnostics");
  });

  it("quick-tests: returns messages with optional filter", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 21,
      method: "prompts/get",
      params: { name: "quick-tests", arguments: { filter: "auth" } },
    });
    const resp = await waitFor(ws, (m) => m.id === 21);
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      messages: Array<{ content: { text: string } }>;
    };
    expect(result.messages[0].content.text).toContain("auth");
  });

  it("quick-review: returns review instructions", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 22,
      method: "prompts/get",
      params: { name: "quick-review", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 22);
    expect(resp.error).toBeUndefined();
  });

  it("build-check: returns build check instructions", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 23,
      method: "prompts/get",
      params: { name: "build-check", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 23);
    expect(resp.error).toBeUndefined();
  });

  it("recent-activity: returns git log instructions", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 24,
      method: "prompts/get",
      params: { name: "recent-activity", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 24);
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      messages: Array<{ content: { text: string } }>;
    };
    expect(result.messages[0].content.text).toContain("getGitLog");
  });

  // ── Agent Teams & Scheduled Tasks prompts ────────────────────────────────

  it("team-status: returns coordination instructions", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 30,
      method: "prompts/get",
      params: { name: "team-status", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 30);
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      messages: Array<{ content: { text: string } }>;
    };
    expect(result.messages[0].content.text).toContain("getGitStatus");
    expect(result.messages[0].content.text).toContain("listClaudeTasks");
  });

  it("health-check: returns comprehensive check instructions", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 31,
      method: "prompts/get",
      params: { name: "health-check", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 31);
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      messages: Array<{ content: { text: string } }>;
    };
    const text = result.messages[0].content.text;
    expect(text).toContain("runTests");
    expect(text).toContain("getSecurityAdvisories");
    expect(text).toContain("HEALTHY");
  });

  it("cowork: appears in prompts/list", async () => {
    const { ws } = await setup();
    send(ws, { jsonrpc: "2.0", id: 10, method: "prompts/list", params: {} });
    const resp = await waitFor(ws, (m) => m.id === 10);
    const result = resp.result as { prompts: Array<{ name: string }> };
    const names = result.prompts.map((p) => p.name);
    expect(names).toContain("cowork");
  });

  it("cowork: returns tool-calling instructions with no arguments", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 11,
      method: "prompts/get",
      params: { name: "cowork", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 11);
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      description: string;
      messages: Array<{ content: { text: string } }>;
    };
    expect(result.messages.length).toBeGreaterThan(0);
    const text = result.messages[0].content.text;
    expect(text).toContain("getHandoffNote");
    expect(text).toContain("getOpenEditors");
    expect(text).toContain("getDiagnostics");
    expect(text).toContain("getGitStatus");
    expect(text).toContain("getProjectInfo");
  });

  it("cowork: injects task description when provided", async () => {
    const { ws } = await setup();
    send(ws, {
      jsonrpc: "2.0",
      id: 12,
      method: "prompts/get",
      params: {
        name: "cowork",
        arguments: { task: "fix all TypeScript errors" },
      },
    });
    const resp = await waitFor(ws, (m) => m.id === 12);
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      description: string;
      messages: Array<{ content: { text: string } }>;
    };
    const text = result.messages[0].content.text;
    expect(text).toContain("fix all TypeScript errors");
    expect(result.description).toContain("fix all TypeScript errors");
  });
});
