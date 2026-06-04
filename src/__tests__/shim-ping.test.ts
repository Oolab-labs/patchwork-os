/**
 * Tests for two mcp-stdio-shim.cjs hardening features:
 *   1. `--ping` one-shot probe — connects, does initialize + tools/list, prints a
 *      summary, and exits. Gives `grok mcp doctor`-style verifiers a clean exit
 *      instead of hanging on the persistent relay.
 *   2. Lock liveness — findLockFile skips locks whose owning bridge process has
 *      exited, so a stale/wedged lock can't be "selected" and hang the connect.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

const SHIM_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "mcp-stdio-shim.cjs",
);

function writeBridgeLock(
  lockDir: string,
  port: number,
  token: string,
  pid: number = process.pid,
): void {
  fs.writeFileSync(
    path.join(lockDir, `${port}.lock`),
    JSON.stringify({ pid, authToken: token, isBridge: true, workspace: "/p" }),
    { mode: 0o600 },
  );
}

/** A pid guaranteed dead: spawn a no-op node child, which has exited by the time
 *  spawnSync returns, then reuse its (now-free) pid. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  return r.pid as number;
}

/** Mock bridge that speaks just enough MCP for --ping: validates the auth header
 *  and answers initialize (id 1) + tools/list (id 2). Binds an ephemeral port. */
async function startMcpBridge(
  token: string,
  toolCount = 3,
): Promise<{ wss: WebSocketServer; port: number }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((res) => wss.once("listening", () => res()));
  wss.on("connection", (ws, req) => {
    if (req.headers["x-claude-code-ide-authorization"] !== token) {
      ws.close(4001, "Unauthorized");
      return;
    }
    ws.on("message", (raw) => {
      let m: { id?: number };
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.id === 1) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          }),
        );
      } else if (m.id === 2) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: {
              tools: Array.from({ length: toolCount }, (_v, i) => ({
                name: `t${i}`,
              })),
            },
          }),
        );
      }
    });
  });
  return { wss, port: (wss.address() as AddressInfo).port };
}

async function closeServer(wss: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    wss.close((err) => (err ? reject(err) : resolve()));
    for (const client of wss.clients) client.terminate();
  });
}

async function waitFor(
  fn: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

let tmpDir: string;
let proc: ChildProcess | null = null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-ping-"));
  fs.mkdirSync(path.join(tmpDir, "ide"), { mode: 0o700 });
});

afterEach(async () => {
  proc?.kill();
  proc = null;
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function spawnShim(args: string[]): ChildProcess {
  const p = spawn(process.execPath, [SHIM_PATH, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc = p;
  return p;
}

function collect(p: ChildProcess): { out: () => string; err: () => string } {
  const outC: string[] = [];
  const errC: string[] = [];
  p.stdout?.setEncoding("utf8");
  p.stdout?.on("data", (d: string) => outC.push(d));
  p.stderr?.setEncoding("utf8");
  p.stderr?.on("data", (d: string) => errC.push(d));
  return { out: () => outC.join(""), err: () => errC.join("") };
}

describe("shim --ping (one-shot probe)", () => {
  it("connects, lists tools, prints a summary, and exits 0", async () => {
    const token = "ping-token";
    const { wss, port } = await startMcpBridge(token, 2);
    writeBridgeLock(path.join(tmpDir, "ide"), port, token);

    const p = spawnShim(["--ping"]);
    const io = collect(p);
    const code = await new Promise<number | null>((res) => p.on("exit", res));

    expect(code).toBe(0);
    expect(io.out()).toMatch(/bridge OK/);
    expect(io.out()).toMatch(/2 tools/);
    await closeServer(wss);
  });

  it("exits non-zero when no bridge lock is present", async () => {
    const p = spawnShim(["--ping"]);
    const io = collect(p);
    const code = await new Promise<number | null>((res) => p.on("exit", res));

    expect(code).toBe(1);
    expect(io.err()).toMatch(/no bridge lock/i);
  });
});

describe("shim lock liveness", () => {
  it("ignores a lock whose bridge process is dead (treats as no live bridge)", async () => {
    writeBridgeLock(path.join(tmpDir, "ide"), 19990, "dead", deadPid());

    const p = spawnShim([]);
    const io = collect(p);

    const waited = await waitFor(
      () => io.err().includes("No bridge lock file found"),
      2500,
    );
    expect(waited).toBe(true);
    // It must never have tried to connect to the dead bridge's port.
    expect(io.err()).not.toMatch(/Connecting to bridge/);
  });

  it("connects to the live bridge even when a dead lock has a newer mtime", async () => {
    const ideDir = path.join(tmpDir, "ide");
    const token = "live-tok";
    const { wss, port } = await startMcpBridge(token);

    writeBridgeLock(ideDir, port, token); // live (pid = this process)
    await new Promise((r) => setTimeout(r, 40));
    // Written later → newer mtime → would win the tier on mtime alone.
    writeBridgeLock(ideDir, 19991, "dead", deadPid());

    const p = spawnShim([]);
    const io = collect(p);

    const connected = await waitFor(() => io.err().includes("Connected"), 3000);
    expect(connected).toBe(true);
    expect(io.err()).toContain(`ws://127.0.0.1:${port}`);
    expect(io.err()).not.toMatch(/19991/); // never tried the dead newer lock
    await closeServer(wss);
  });
});
