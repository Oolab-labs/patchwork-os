/**
 * OrchestratorBridge health-probe regression tests.
 *
 * Two MEDIUM bugs in the probe loop:
 *
 *  (1) Transient empty listTools() clobbers a healthy bridge's tools.
 *      A child's HTTP session can expire (or listTools() can swallow a transient
 *      error and return []). For an already-healthy bridge this must be treated
 *      as a probe miss — the previous tool list must be preserved, NOT replaced
 *      with [] (which would deregister every proxied tool).
 *
 *  (2) No re-entrancy guard on the health-probe loop.
 *      setInterval fires every healthIntervalMs and runs refresh()+probeAll()
 *      without awaiting the prior probeAll. A slow probe can overlap, racing on
 *      shared registry/client state. Overlapping ticks must be skipped while a
 *      probe is in flight.
 *
 * Like the sibling integration tests we bypass OrchestratorBridge.start()'s
 * signal handlers where possible and reach into the (TypeScript-private) probe
 * internals via a typed accessor cast.
 */

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "../../server.js";
import { ChildBridgeClient } from "../childBridgeClient.js";
import type { ChildBridgeRegistry } from "../childBridgeRegistry.js";
import { OrchestratorBridge } from "../orchestratorBridge.js";
import type { OrchestratorConfig } from "../orchestratorConfig.js";

// ── cleanup tracking ──────────────────────────────────────────────────────────

const servers: Server[] = [];
const orchBridges: OrchestratorBridge[] = [];
const registries: ChildBridgeRegistry[] = [];

afterEach(async () => {
  for (const o of orchBridges) {
    // Reach into the private members to tear down without process.exit.
    const internal = o as unknown as {
      healthTimer: ReturnType<typeof setInterval> | null;
      registry: ChildBridgeRegistry;
      server: { close: () => void };
      lockFile: { delete: () => void };
    };
    if (internal.healthTimer) clearInterval(internal.healthTimer);
    internal.registry.stop();
    internal.server.close();
    try {
      internal.lockFile.delete();
    } catch {
      // ignore
    }
  }
  orchBridges.length = 0;

  for (const r of registries) r.stop();
  registries.length = 0;

  for (const s of servers) await s.close();
  servers.length = 0;
});

// ── helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Spin up a child bridge whose tools/list response is controlled by a mutable
 * `toolsRef`. Lets a test flip the next probe's tool list to [] to simulate a
 * transient empty result (expired HTTP session / swallowed error).
 */
async function startTogglableChildBridge(
  _workspace: string,
  toolsRef: { tools: Array<{ name: string; description: string }> },
): Promise<{ server: Server; port: number; authToken: string }> {
  const authToken = randomUUID();
  const { Logger } = await import("../../logger.js");
  const logger = new Logger(false);
  const server = new Server(authToken, logger);
  const mcpSessionId = randomUUID();

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

    if (method === "initialize") {
      res.setHeader("mcp-session-id", mcpSessionId);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "togglable-child", version: "1.0.0" },
          },
        }),
      );
    } else if (method === "notifications/initialized") {
      res.writeHead(204).end();
    } else if (method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            tools: toolsRef.tools.map((t) => ({
              ...t,
              inputSchema: { type: "object", properties: {} },
            })),
          },
        }),
      );
    } else {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
    }
  };

  const port = await server.findAndListen(null);
  servers.push(server);
  return { server, port, authToken };
}

interface ProbeInternals {
  probeAll(): Promise<void>;
  registry: ChildBridgeRegistry;
  runHealthTick(): void;
  probing: boolean;
}

function internals(o: OrchestratorBridge): ProbeInternals {
  return o as unknown as ProbeInternals;
}

async function startOrchBridge(
  lockDir: string,
): Promise<{ orch: OrchestratorBridge; port: number; token: string }> {
  // Pre-allocate a free port so the lock file uses a known filename.
  const port = await new Promise<number>((resolve, reject) => {
    const tmp = http.createServer();
    tmp.listen(0, "127.0.0.1", () => {
      const addr = tmp.address() as { port: number };
      tmp.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
  const token = randomUUID();
  const config: OrchestratorConfig = {
    port,
    bindAddress: "127.0.0.1",
    lockDir,
    healthIntervalMs: 60_000, // long — we drive probes manually
    verbose: false,
    jsonl: false,
    watch: false,
    fixedToken: token,
  };
  const orch = new OrchestratorBridge(config);
  orchBridges.push(orch);
  await orch.start();
  return { orch, port, token };
}

// ── Bug (1): transient empty listTools() must not clobber a healthy bridge ─────

describe("OrchestratorBridge probe: transient empty listTools() preserves tools", () => {
  it("a healthy bridge that returns [] on one probe keeps its previous tools", async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-probe-empty-"));

    const toolsRef = {
      tools: [{ name: "echo", description: "Echo the input back" }],
    };
    const child = await startTogglableChildBridge("/projects/empty", toolsRef);
    writeBridgeLock(lockDir, child.port, child.authToken, "/projects/empty");

    const { orch } = await startOrchBridge(lockDir);
    const reg = internals(orch).registry;

    // After start()'s initial probe the bridge is healthy with the echo tool.
    const before = reg.get(child.port);
    expect(before?.healthy).toBe(true);
    expect(before?.tools.map((t) => t.name)).toEqual(["echo"]);

    // Simulate a transient empty result on the next probe (expired session /
    // swallowed error): the child now reports zero tools.
    toolsRef.tools = [];

    await internals(orch).probeAll();

    // BUG (1): the previous guard `tools.length === 0 && !b.healthy` falls
    // through to markHealthy(port, []) for an already-healthy bridge, wiping
    // its tools. After the fix the previous tool list must be preserved.
    const after = reg.get(child.port);
    expect(after?.tools.map((t) => t.name)).toEqual(["echo"]);
    expect(after?.healthy).toBe(true);
  });

  it("a never-healthy bridge that returns [] stays warming (unchanged behavior)", async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-probe-warm-"));

    // Child reports zero tools from the very first probe.
    const toolsRef = {
      tools: [] as Array<{ name: string; description: string }>,
    };
    const child = await startTogglableChildBridge("/projects/warm", toolsRef);
    writeBridgeLock(lockDir, child.port, child.authToken, "/projects/warm");

    const { orch } = await startOrchBridge(lockDir);
    const reg = internals(orch).registry;

    const b = reg.get(child.port);
    // Never marked healthy — stays warming with no tools.
    expect(b?.healthy).toBe(false);
    expect(b?.tools).toEqual([]);
  });
});

// ── childBridgeClient: swallowed-error [] must not wipe a healthy bridge ───────

describe("ChildBridgeClient.listTools 404 session-expiry recovery", () => {
  let server: http.Server;
  let client: ChildBridgeClient;

  afterEach(async () => {
    client?.destroy();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
  });

  it("re-initializes the session and retries when tools/list gets a 404", async () => {
    let initCount = 0;
    let sess1Calls = 0;

    const echoResult = JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf-8"),
        ) as Record<string, unknown>;
        const id = body.id;
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (body.method === "initialize") {
          initCount++;
          res.setHeader("mcp-session-id", `sess-${initCount}`);
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: "2025-11-25", capabilities: {} },
            }),
          );
        } else if (body.method === "notifications/initialized") {
          res.writeHead(204).end();
        } else if (body.method === "tools/list") {
          if (sessionId === "sess-1") {
            sess1Calls++;
            // First tools/list on sess-1 succeeds (primes the cache); the
            // session then expires, so the SECOND tools/list returns 404.
            if (sess1Calls === 1) {
              res
                .writeHead(200, { "content-type": "application/json" })
                .end(
                  echoResult.replace('"id":0', `"id":${JSON.stringify(id)}`),
                );
            } else {
              res.writeHead(404).end();
            }
          } else {
            // Re-initialized session (sess-2+) works.
            res
              .writeHead(200, { "content-type": "application/json" })
              .end(echoResult.replace('"id":0', `"id":${JSON.stringify(id)}`));
          }
        } else {
          res.writeHead(200).end("{}");
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    client = new ChildBridgeClient(port, "test-token");

    // First listTools() primes the session (sess-1) and returns the echo tool.
    const first = await client.listTools();
    expect(first.map((t) => t.name)).toEqual(["echo"]);

    // Second listTools() now hits a 404 (session expired). Before the fix the
    // client swallows the error and returns [] — which the orchestrator would
    // then write over a healthy bridge's tools. After the fix the session is
    // re-initialized and the call retried, returning the real tool list.
    const second = await client.listTools();
    expect(second.map((t) => t.name)).toEqual(["echo"]);
    expect(initCount).toBe(2); // initial + reinit after 404
  });
});

// ── Bug (2): re-entrancy guard on the health-probe tick ───────────────────────

describe("OrchestratorBridge probe: health tick re-entrancy guard", () => {
  it("skips overlapping ticks while a probe is in flight", async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-probe-race-"));
    const toolsRef = {
      tools: [{ name: "echo", description: "Echo" }],
    };
    const child = await startTogglableChildBridge("/projects/race", toolsRef);
    writeBridgeLock(lockDir, child.port, child.authToken, "/projects/race");

    const { orch } = await startOrchBridge(lockDir);
    const ix = internals(orch);

    // Replace probeAll with a slow, controllable stub that counts concurrent
    // invocations. If runHealthTick() lacks a re-entrancy guard, the second
    // tick fires probeAll while the first is still pending.
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    ix.probeAll = async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
    };

    // Fire two ticks back-to-back while the first probe is still in flight.
    ix.runHealthTick();
    ix.runHealthTick();

    // The second tick must have been skipped by the `probing` guard.
    expect(calls).toBe(1);
    expect(maxActive).toBe(1);

    // Release the in-flight probe and let the guard reset.
    release();
    await new Promise((r) => setTimeout(r, 10));

    // After the in-flight probe settles a fresh tick runs again.
    ix.runHealthTick();
    expect(calls).toBe(2);
  });
});
