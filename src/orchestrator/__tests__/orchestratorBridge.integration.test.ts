/**
 * OrchestratorBridge integration tests.
 *
 * Each test spins up:
 *   - One or two real child bridge HTTP servers (Server + McpTransport with a
 *     registered echo tool) that respond to /health and /mcp.
 *   - A real OrchestratorBridge pointed at a temp lock dir containing the
 *     child's lock file.
 *   - A WebSocket client that connects to the orchestrator and drives MCP.
 *
 * The orchestrator's probeAll() runs once at start() so by the time the
 * client connects the child is already marked healthy.
 *
 * We bypass OrchestratorBridge.start() (which installs signal handlers) and
 * wire the components manually, the same way bridge.ts and integration.test.ts
 * do it.
 */

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { send, waitFor } from "../../__tests__/wsHelpers.js";
import { Logger } from "../../logger.js";
import { Server } from "../../server.js";
import { McpTransport } from "../../transport.js";
import { ChildBridgeClient } from "../childBridgeClient.js";
import { ChildBridgeRegistry } from "../childBridgeRegistry.js";
import type { OrchestratorConfig } from "../orchestratorConfig.js";
import { createOrchestratorTools } from "../orchestratorTools.js";

// ── cleanup tracking ──────────────────────────────────────────────────────────

const openedClients: WebSocket[] = [];
const servers: Server[] = [];
const clients: ChildBridgeClient[] = [];
const registries: ChildBridgeRegistry[] = [];
const orchServers: Server[] = [];

afterEach(async () => {
  for (const ws of openedClients) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
  openedClients.length = 0;

  for (const c of clients) c.destroy();
  clients.length = 0;

  for (const r of registries) r.stop();
  registries.length = 0;

  for (const s of [...servers, ...orchServers]) {
    await s.close();
  }
  servers.length = 0;
  orchServers.length = 0;
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Write a valid child bridge lock file directly into the temp lock dir. */
function writeBridgeLock(
  lockDir: string,
  port: number,
  authToken: string,
  workspace: string,
): void {
  const content = JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    nonce: randomBytes(8).toString("hex"),
    workspace,
    workspaceFolders: [workspace],
    ideName: "VSCode",
    isBridge: true,
    orchestrator: false,
    transport: "ws",
    authToken,
  });
  fs.writeFileSync(path.join(lockDir, `${port}.lock`), content, {
    mode: 0o600,
  });
}

interface ChildScaffold {
  server: Server;
  transport: McpTransport;
  port: number;
  authToken: string;
  workspace: string;
}

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

/**
 * Spin up a minimal child bridge that speaks the MCP HTTP protocol that
 * ChildBridgeClient expects:
 *   - GET  /health → 200
 *   - POST /mcp initialize → {result: {protocolVersion, capabilities, serverInfo}}
 *   - POST /mcp tools/list  → {result: {tools: [...]}}
 *   - POST /mcp tools/call  → {result: {content: [...]}}
 */
async function startChildBridge(workspace: string): Promise<ChildScaffold> {
  const authToken = randomUUID();
  const logger = new Logger(false);
  const server = new Server(authToken, logger);
  const transport = new McpTransport(logger); // kept for WebSocket clients if needed

  const mcpSessionId = randomUUID();
  const toolSchemas = [
    {
      name: "echo",
      description: "Echo the input back",
      inputSchema: {
        type: "object" as const,
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ];
  const toolHandlers = new Map<string, ToolHandler>([
    [
      "echo",
      async (args) => ({
        content: [{ type: "text", text: `echo: ${args.message as string}` }],
      }),
    ],
  ]);

  server.httpMcpHandler = async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", resolve);
    });

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      res.writeHead(400).end();
      return;
    }

    const method = body.method as string;
    const id = body.id;
    let responseBody: string;

    if (method === "initialize") {
      res.setHeader("mcp-session-id", mcpSessionId);
      responseBody = JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "test-child", version: "1.0.0" },
        },
      });
    } else if (method === "notifications/initialized") {
      res.writeHead(204).end();
      return;
    } else if (method === "tools/list") {
      responseBody = JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { tools: toolSchemas },
      });
    } else if (method === "tools/call") {
      const params = body.params as {
        name: string;
        arguments: Record<string, unknown>;
      };
      const handler = toolHandlers.get(params.name);
      if (!handler) {
        responseBody = JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Tool not found" },
        });
      } else {
        try {
          const result = await handler(params.arguments);
          responseBody = JSON.stringify({ jsonrpc: "2.0", id, result });
        } catch (err) {
          responseBody = JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: String(err) },
          });
        }
      }
    } else {
      responseBody = JSON.stringify({ jsonrpc: "2.0", id, result: {} });
    }

    res
      .writeHead(200, { "content-type": "application/json" })
      .end(responseBody);
  };

  server.on("connection", (ws: WebSocket) => {
    transport.attach(ws);
  });

  const port = await server.findAndListen(null);
  servers.push(server);

  return { server, transport, port, authToken, workspace };
}

/**
 * Wire up an orchestrator against a single child bridge and return both
 * an MCP WebSocket client and the orch server reference.
 */
async function startOrchestrator(
  lockDir: string,
  childPort: number,
): Promise<{ orchPort: number; orchToken: string; orchServer: Server }> {
  const orchToken = randomUUID();
  const logger = new Logger(false);
  const orchServer = new Server(orchToken, logger);
  orchServers.push(orchServer);

  const orchPort = await orchServer.findAndListen(null);

  const config: OrchestratorConfig = {
    port: orchPort,
    bindAddress: "127.0.0.1",
    lockDir,
    healthIntervalMs: 60_000, // don't auto-probe during test
    verbose: false,
    jsonl: false,
  };

  const registry = new ChildBridgeRegistry(lockDir, 60_000, orchPort);
  registries.push(registry);
  registry.start(); // reads lock files once

  // Prime health: probe all children right now
  const bridges = registry.getAll();
  const clientMap = new Map<number, ChildBridgeClient>();
  for (const b of bridges) {
    const client = new ChildBridgeClient(b.port, b.authToken);
    clients.push(client);
    clientMap.set(b.port, client);

    const alive = await client.ping();
    if (alive) {
      const tools = await client.listTools();
      registry.markHealthy(b.port, tools);
    }
  }

  // Wire orchestrator connection handler (mirrors OrchestratorBridge.handleConnection)
  orchServer.on("connection", (ws: WebSocket) => {
    const sessionId = randomUUID();
    const transport = new McpTransport(logger);
    const sessions = new Map<string, { stickyBridgePort: number | null }>();
    sessions.set(sessionId, { stickyBridgePort: null });

    transport.setDynamicToolDispatch(async (args, signal) => {
      const toolName = (args as Record<string, unknown>).__toolName as string;
      const realArgs = { ...(args as Record<string, unknown>) };
      realArgs.__toolName = undefined;

      const session = sessions.get(sessionId) ?? null;
      let targetPort = session?.stickyBridgePort ?? null;

      if (!targetPort) {
        const best = registry.pickBest();
        if (best) {
          targetPort = best.port;
          if (session && !session.stickyBridgePort) {
            session.stickyBridgePort = best.port;
          }
        }
      }

      if (!targetPort) {
        return {
          content: [
            { type: "text", text: "[ORCHESTRATOR ERROR] No healthy bridge" },
          ],
        };
      }

      const client = clientMap.get(targetPort);
      if (!client) {
        return {
          content: [{ type: "text", text: "[ORCHESTRATOR ERROR] No client" }],
        };
      }

      return client.callTool(toolName, realArgs, signal);
    });

    const orchTools = createOrchestratorTools({
      registry,
      config,
      startedAt: Date.now(),
      getActiveSessions: () => sessions.size,
      setStickyBridge: (sid, port) => {
        const s = sessions.get(sid);
        if (s) s.stickyBridgePort = port;
      },
    });
    for (const t of orchTools) {
      transport.registerTool(t.schema, t.handler);
    }

    // Register proxied tools from healthy bridges
    for (const b of registry.getHealthy()) {
      for (const tool of b.tools) {
        const capturedPort = b.port;
        const capturedName = tool.name;
        transport.registerTool(
          {
            ...tool,
            description: `[${b.ideName}: ${b.workspace}] ${tool.description}`,
          },
          async (args, signal) => {
            const client = clientMap.get(capturedPort)!;
            return client.callTool(capturedName, args, signal);
          },
        );
      }
    }

    transport.attach(ws);
    ws.on("close", () => sessions.delete(sessionId));
  });

  return { orchPort, orchToken, orchServer };
}

async function connectMcpClient(
  port: number,
  token: string,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { "x-claude-code-ide-authorization": token },
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  openedClients.push(ws);
  return ws;
}

async function mcpHandshake(ws: WebSocket): Promise<Record<string, unknown>> {
  send(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const initResp = await waitFor(ws, (m) => m.id === 1);
  send(ws, { jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((r) => setTimeout(r, 10));
  return initResp;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("OrchestratorBridge integration: single child bridge", () => {
  let lockDir: string;
  let child: ChildScaffold;
  let orchPort: number;
  let orchToken: string;

  beforeEach(async () => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-integ-"));
    child = await startChildBridge(`/projects/ws-${randomUUID().slice(0, 8)}`);
    writeBridgeLock(lockDir, child.port, child.authToken, child.workspace);
    ({ orchPort, orchToken } = await startOrchestrator(lockDir, child.port));
  });

  it("initialize returns a valid MCP protocolVersion from the orchestrator", async () => {
    const ws = await connectMcpClient(orchPort, orchToken);
    const initResp = await mcpHandshake(ws);
    const result = initResp.result as Record<string, unknown>;
    expect(result.protocolVersion).toBeTruthy();
    expect(typeof result.protocolVersion).toBe("string");
  });

  it("tools/list includes the proxied echo tool from the child bridge", async () => {
    const ws = await connectMcpClient(orchPort, orchToken);
    await mcpHandshake(ws);

    send(ws, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const resp = await waitFor(ws, (m) => m.id === 2);
    const tools = (resp.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);

    // Orchestrator native tools
    expect(names).toContain("listWorkspaces");
    expect(names).toContain("switchWorkspace");
    expect(names).toContain("listBridges");
    expect(names).toContain("getOrchestratorStatus");

    // Proxied child tool
    expect(names).toContain("echo");
  });

  it("calling a proxied tool routes through the child and returns the result", async () => {
    const ws = await connectMcpClient(orchPort, orchToken);
    await mcpHandshake(ws);

    send(ws, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "hello orchestrator" } },
    });
    const resp = await waitFor(ws, (m) => m.id === 3, 8000);

    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text).toBe("echo: hello orchestrator");
  });

  it("listWorkspaces tool returns the child workspace", async () => {
    const ws = await connectMcpClient(orchPort, orchToken);
    await mcpHandshake(ws);

    send(ws, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "listWorkspaces", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 4, 8000);
    expect(resp.error).toBeUndefined();
    const text = (resp.result as { content: [{ text: string }] }).content[0]
      .text;
    expect(text).toContain(child.workspace);
  });

  it("getOrchestratorStatus reports 1 child bridge", async () => {
    const ws = await connectMcpClient(orchPort, orchToken);
    await mcpHandshake(ws);

    send(ws, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "getOrchestratorStatus", arguments: {} },
    });
    const resp = await waitFor(ws, (m) => m.id === 5, 8000);
    const text = (resp.result as { content: [{ text: string }] }).content[0]
      .text;
    const json = JSON.parse(text) as { childBridges: unknown[] };
    expect(json.childBridges).toHaveLength(1);
  });
});

describe("OrchestratorBridge integration: child bridge goes down mid-session", () => {
  it("returns BRIDGE_UNAVAILABLE error (not a JSON-RPC error) when child is unreachable", async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-integ-down-"));
    const child = await startChildBridge(
      `/projects/down-${randomUUID().slice(0, 8)}`,
    );
    writeBridgeLock(lockDir, child.port, child.authToken, child.workspace);
    const { orchPort, orchToken } = await startOrchestrator(
      lockDir,
      child.port,
    );

    const ws = await connectMcpClient(orchPort, orchToken);
    await mcpHandshake(ws);

    // Kill the child bridge
    await child.server.close();

    send(ws, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "after death" } },
    });
    const resp = await waitFor(ws, (m) => m.id === 10, 8000);

    // Must be an MCP content result, not a JSON-RPC error
    expect(resp.error).toBeUndefined();
    const text = (resp.result as { content: [{ text: string }] }).content[0]
      .text;
    expect(text).toMatch(/BRIDGE_UNAVAILABLE|No healthy bridge|unavailable/i);
  });
});

describe("OrchestratorBridge integration: two child bridges", () => {
  it("getOrchestratorStatus reports both bridges and listWorkspaces shows both workspaces", async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-integ-two-"));
    const childA = await startChildBridge("/projects/alpha");
    const childB = await startChildBridge("/projects/beta");
    writeBridgeLock(lockDir, childA.port, childA.authToken, childA.workspace);
    writeBridgeLock(lockDir, childB.port, childB.authToken, childB.workspace);

    // Use a custom orch that doesn't proxy child tools (avoids duplicate-name error
    // in the test scaffold — production OrchestratorBridge handles deduplication).
    const orchToken = randomUUID();
    const logger = new Logger(false);
    const orchServer = new Server(orchToken, logger);
    orchServers.push(orchServer);
    const orchPort = await orchServer.findAndListen(null);

    const config: OrchestratorConfig = {
      port: orchPort,
      bindAddress: "127.0.0.1",
      lockDir,
      healthIntervalMs: 60_000,
      verbose: false,
      jsonl: false,
    };

    const registry = new ChildBridgeRegistry(lockDir, 60_000, orchPort);
    registries.push(registry);
    registry.start();

    const clientMap = new Map<number, ChildBridgeClient>();
    for (const b of registry.getAll()) {
      const client = new ChildBridgeClient(b.port, b.authToken);
      clients.push(client);
      clientMap.set(b.port, client);
      const alive = await client.ping();
      if (alive) {
        const tools = await client.listTools();
        registry.markHealthy(b.port, tools);
      }
    }

    orchServer.on("connection", (ws: WebSocket) => {
      const transport = new McpTransport(logger);
      // Only register orchestrator-native tools (no child tool proxying)
      // to avoid duplicate-name collisions in the test scaffold.
      const orchTools = createOrchestratorTools({
        registry,
        config,
        startedAt: Date.now(),
        getActiveSessions: () => 1,
        setStickyBridge: () => {},
      });
      for (const t of orchTools) transport.registerTool(t.schema, t.handler);
      transport.attach(ws);
    });

    const ws = await connectMcpClient(orchPort, orchToken);
    await mcpHandshake(ws);

    // Both bridges should be healthy in the registry
    send(ws, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "getOrchestratorStatus", arguments: {} },
    });
    const statusResp = await waitFor(ws, (m) => m.id === 2, 8000);
    const statusText = (statusResp.result as { content: [{ text: string }] })
      .content[0].text;
    const status = JSON.parse(statusText) as { childBridges: unknown[] };
    expect(status.childBridges).toHaveLength(2);

    // listWorkspaces should show both
    send(ws, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "listWorkspaces", arguments: {} },
    });
    const wsResp = await waitFor(ws, (m) => m.id === 3, 8000);
    const wsText = (wsResp.result as { content: [{ text: string }] }).content[0]
      .text;
    expect(wsText).toContain(childA.workspace);
    expect(wsText).toContain(childB.workspace);
  });
});
