/**
 * Tests for persistent-session-state: openedFiles restoration on bridge restart.
 *
 * Two test groups:
 *  1. extractRestoredFiles() — pure function, unit-tested directly.
 *  2. First-session seeding — scaffold that mirrors bridge.ts restoration logic,
 *     verifying the first session receives restored files and subsequent sessions
 *     do not.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { extractRestoredFiles } from "../bridge.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import type { CheckpointData } from "../sessionCheckpoint.js";
import { McpTransport } from "../transport.js";
import { send, waitFor } from "./wsHelpers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCheckpoint(
  sessions: Array<{ id: string; openedFiles: string[] }>,
): CheckpointData {
  return {
    port: 9000,
    savedAt: Date.now(),
    extensionConnected: false,
    gracePeriodMs: 30_000,
    sessions: sessions.map((s) => ({
      ...s,
      connectedAt: Date.now(),
      terminalPrefix: "s1-",
      inGrace: false,
    })),
  };
}

// ── Unit tests: extractRestoredFiles ──────────────────────────────────────────

// Use tmpdir as workspace so resolveFilePath containment checks pass for paths under it
const WS = os.tmpdir();
const p = (name: string) => `${WS}/${name}`;

describe("extractRestoredFiles", () => {
  it("returns empty set for checkpoint with no sessions", () => {
    const result = extractRestoredFiles(makeCheckpoint([]), WS);
    expect(result.size).toBe(0);
  });

  it("returns files from a single session", () => {
    const result = extractRestoredFiles(
      makeCheckpoint([{ id: "s1", openedFiles: [p("a.ts"), p("b.ts")] }]),
      WS,
    );
    expect([...result].sort()).toEqual([p("a.ts"), p("b.ts")].sort());
  });

  it("merges files from multiple sessions deduplicating overlaps", () => {
    const result = extractRestoredFiles(
      makeCheckpoint([
        { id: "s1", openedFiles: [p("a.ts"), p("shared.ts")] },
        { id: "s2", openedFiles: [p("b.ts"), p("shared.ts")] },
      ]),
      WS,
    );
    expect([...result].sort()).toEqual(
      [p("a.ts"), p("b.ts"), p("shared.ts")].sort(),
    );
  });

  it("handles sessions with empty openedFiles arrays", () => {
    const result = extractRestoredFiles(
      makeCheckpoint([
        { id: "s1", openedFiles: [] },
        { id: "s2", openedFiles: [p("c.ts")] },
      ]),
      WS,
    );
    expect([...result]).toEqual([p("c.ts")]);
  });

  it("returns a mutable Set — callers can add files to it", () => {
    const result = extractRestoredFiles(
      makeCheckpoint([{ id: "s1", openedFiles: [p("a.ts")] }]),
      WS,
    );
    result.add(p("b.ts"));
    expect(result.has(p("b.ts"))).toBe(true);
  });

  it("filters out paths that escape the workspace", () => {
    const result = extractRestoredFiles(
      makeCheckpoint([
        { id: "s1", openedFiles: [p("file.ts"), "/etc/passwd"] },
      ]),
      WS,
    );
    expect([...result]).toEqual([p("file.ts")]);
  });
});

// ── Integration: first-session seeding scaffold ───────────────────────────────

/**
 * Scaffold that mirrors bridge.ts restoration logic:
 *  - Accepts a pre-computed `restoredFiles` Set (from extractRestoredFiles)
 *  - Gives it to the FIRST connecting session only
 *  - Subsequent sessions start with an empty Set
 *
 * Returns a map of sessionId → openedFiles for inspection.
 */
function buildRestorationScaffold(restoredFiles: Set<string> | null) {
  const authToken = randomUUID();
  const logger = new Logger(false);
  const server = new Server(authToken, logger);
  const sessions = new Map<string, { openedFiles: Set<string> }>();

  let pendingRestore: Set<string> | null = restoredFiles;

  server.on("connection", (ws: WebSocket) => {
    const sessionId = randomUUID();
    const transport = new McpTransport(logger);

    // Mirror bridge.ts: first session gets restored files, others get empty set
    const openedFiles =
      sessions.size === 0 && pendingRestore !== null
        ? pendingRestore
        : new Set<string>();
    if (sessions.size === 0 && pendingRestore !== null) {
      pendingRestore = null;
    }

    sessions.set(sessionId, { openedFiles });
    transport.attach(ws);

    ws.on("close", () => {
      sessions.delete(sessionId);
      transport.detach();
    });
  });

  return { server, authToken, sessions };
}

const servers: Server[] = [];
const openedClients: WebSocket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of openedClients) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
  openedClients.length = 0;
  for (const s of servers) {
    await s.close();
  }
  servers.length = 0;
});

async function connect(port: number, authToken: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { "x-claude-code-ide-authorization": authToken },
  });
  openedClients.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

describe("Bridge session restore: first-session seeding", () => {
  it("first session receives restored files when checkpoint has data", async () => {
    const restored = new Set(["/a.ts", "/b.ts"]);
    const { server, authToken, sessions } = buildRestorationScaffold(restored);
    servers.push(server);
    const port = await server.findAndListen(null);

    const ws = await connect(port, authToken);

    // Give the connection handler time to fire
    await new Promise((r) => setTimeout(r, 20));

    const sessionValues = [...sessions.values()];
    expect(sessionValues).toHaveLength(1);
    expect([...sessionValues[0]!.openedFiles].sort()).toEqual([
      "/a.ts",
      "/b.ts",
    ]);

    ws.close();
  });

  it("first session starts empty when no checkpoint data", async () => {
    const { server, authToken, sessions } = buildRestorationScaffold(null);
    servers.push(server);
    const port = await server.findAndListen(null);

    const ws = await connect(port, authToken);
    await new Promise((r) => setTimeout(r, 20));

    const sessionValues = [...sessions.values()];
    expect(sessionValues).toHaveLength(1);
    expect(sessionValues[0]!.openedFiles.size).toBe(0);

    ws.close();
  });

  it("second session in the same run gets an empty set — restore is one-time", async () => {
    const restored = new Set(["/only-first.ts"]);
    const { server, authToken, sessions } = buildRestorationScaffold(restored);
    servers.push(server);
    const port = await server.findAndListen(null);

    const ws1 = await connect(port, authToken);
    await new Promise((r) => setTimeout(r, 60)); // respect MIN_CONNECTION_INTERVAL_MS
    const ws2 = await connect(port, authToken);
    await new Promise((r) => setTimeout(r, 20));

    const sessionValues = [...sessions.values()];
    expect(sessionValues).toHaveLength(2);

    const [first, second] = sessionValues;
    expect(first!.openedFiles.has("/only-first.ts")).toBe(true);
    expect(second!.openedFiles.size).toBe(0);

    ws1.close();
    ws2.close();
  });

  it("restored set is passed directly to the first session (scaffold uses same reference)", async () => {
    // NOTE: This scaffold passes the restoredFiles Set directly (no copy).
    // bridge.ts creates `new Set(captured)` — a copy — so in production code
    // the session's openedFiles will NOT be the same object reference as the
    // captured checkpoint set. This test verifies the scaffold's own behaviour,
    // not the production copy semantics.
    const restored = new Set(["/exact.ts"]);
    const { server, authToken, sessions } = buildRestorationScaffold(restored);
    servers.push(server);
    const port = await server.findAndListen(null);

    const ws = await connect(port, authToken);
    await new Promise((r) => setTimeout(r, 20));

    const sessionValues = [...sessions.values()];
    // Contents must match the restored set
    expect([...sessionValues[0]!.openedFiles]).toEqual([...restored]);
    // The scaffold passes the same reference; production bridge.ts passes a copy (not same ref)
    expect(sessionValues[0]!.openedFiles).toBe(restored); // scaffold-specific: same ref

    ws.close();
  });

  it("waitFor correctly reads tool response (smoke test for scaffold)", async () => {
    const { server, authToken } = buildRestorationScaffold(null);
    servers.push(server);
    const port = await server.findAndListen(null);

    const ws = await connect(port, authToken);

    send(ws, {
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        clientInfo: { name: "test", version: "0" },
        capabilities: {},
      },
    });

    const resp = await waitFor(ws, (m) => m.id === "init-1");
    expect(
      (resp.result as Record<string, unknown>)?.protocolVersion,
    ).toBeTruthy();

    ws.close();
  });
});
