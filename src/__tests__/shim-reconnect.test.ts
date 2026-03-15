/**
 * Tests for mcp-stdio-shim.cjs reconnection behavior.
 *
 * Bug 1: Shim exits immediately (code 1) when no lock file exists at startup.
 *        It should poll/wait for a lock file to appear instead.
 *
 * Bug 2: When the bridge restarts and no fs.watch event fires (macOS unreliability),
 *        there is no polling fallback — the shim stays disconnected forever.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
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

function writelock(
  lockDir: string,
  port: number,
  token: string,
  isBridge = true,
) {
  const lockFile = path.join(lockDir, `${port}.lock`);
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, authToken: token, isBridge }),
    { mode: 0o600 },
  );
  return lockFile;
}

function startMockBridge(port: number, token: string): WebSocketServer {
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  wss.on("connection", (ws, req) => {
    const auth = req.headers["x-claude-code-ide-authorization"];
    if (auth !== token) {
      ws.close(4001, "Unauthorized");
    }
  });
  return wss;
}

async function waitFor(
  conditionFn: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (conditionFn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function closeServer(wss: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    wss.close((err) => (err ? reject(err) : resolve()));
    for (const client of wss.clients) client.terminate();
  });
}

let tmpDir: string;
let shimProcess: ChildProcess | null = null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-test-"));
  fs.mkdirSync(path.join(tmpDir, "ide"), { mode: 0o700 });
});

afterEach(async () => {
  shimProcess?.kill();
  shimProcess = null;
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function spawnShim(env: Record<string, string> = {}): ChildProcess {
  const proc = spawn(process.execPath, [SHIM_PATH], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  shimProcess = proc;
  return proc;
}

// ---------------------------------------------------------------------------
// BUG 1: Shim should wait for a lock file on startup, not exit immediately
// ---------------------------------------------------------------------------
describe("startup with no lock file", () => {
  it("should stay alive for at least 3s waiting for a lock file to appear", async () => {
    const proc = spawnShim();

    let exitCode: number | null = null;
    proc.on("exit", (code) => {
      exitCode = code;
    });

    // Give it 3 seconds — it should NOT have exited
    await new Promise((r) => setTimeout(r, 3000));

    // BUG: currently exits immediately with code 1 → this assertion FAILS
    expect(exitCode).toBeNull();
  });

  it("should connect once a lock file appears during the wait", async () => {
    const port = 19800;
    const token = "test-token-startup";

    const proc = spawnShim();
    const stderrLines: string[] = [];
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d: string) => stderrLines.push(d));

    // Start bridge and write lock file after 1s delay (simulating slow bridge start)
    const wss = startMockBridge(port, token);
    await new Promise((r) => setTimeout(r, 1000));
    writelock(path.join(tmpDir, "ide"), port, token);

    // Shim should detect the new lock and connect within 3s
    const connected = await waitFor(
      () => stderrLines.some((l) => l.includes("Connected")),
      3000,
    );

    await closeServer(wss);

    // BUG: shim already exited so it never connects → this assertion FAILS
    expect(connected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG 2: Shim should reconnect via polling when fs.watch event is missed
// ---------------------------------------------------------------------------
describe("reconnection after bridge restart", () => {
  it("reconnects via watcher when lock file changes to a new port", async () => {
    const port1 = 19801;
    const port2 = 19802;
    const token1 = "token-bridge-1";
    const token2 = "token-bridge-2";
    const lockDir = path.join(tmpDir, "ide");

    const wss1 = startMockBridge(port1, token1);
    writelock(lockDir, port1, token1);

    const proc = spawnShim();
    const stderrLines: string[] = [];
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d: string) => stderrLines.push(d));

    // Wait for initial connection
    const connected1 = await waitFor(
      () => stderrLines.some((l) => l.includes("Connected")),
      3000,
    );
    expect(connected1).toBe(true);

    // Simulate bridge restart: close old server, remove old lock, start new one
    await closeServer(wss1);
    fs.rmSync(path.join(lockDir, `${port1}.lock`));
    const wss2 = startMockBridge(port2, token2);
    writelock(lockDir, port2, token2);

    // Shim should reconnect to new port
    const reconnected = await waitFor(
      () =>
        stderrLines.some(
          (l) => l.includes("reconnecting") || l.includes("port " + port2),
        ),
      4000,
    );

    await closeServer(wss2);

    // This may already pass — it tests the watcher path
    expect(reconnected).toBe(true);
  });

  it("reconnects via polling even when no fs.watch event fires (polling fallback)", async () => {
    // This test simulates fs.watch missing an event by writing the new lock file
    // BEFORE the shim is connected (so watcher is already set up) and then verifying
    // the shim polls for reconnection after the WebSocket drops.
    const port1 = 19803;
    const port2 = 19804;
    const token1 = "token-poll-1";
    const token2 = "token-poll-2";
    const lockDir = path.join(tmpDir, "ide");

    const wss1 = startMockBridge(port1, token1);
    writelock(lockDir, port1, token1);

    const proc = spawnShim();
    const stderrLines: string[] = [];
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d: string) => stderrLines.push(d));

    const connected1 = await waitFor(
      () => stderrLines.some((l) => l.includes("Connected")),
      3000,
    );
    expect(connected1).toBe(true);

    // Disconnect shim by closing bridge (no lock file change yet)
    await closeServer(wss1);

    // Wait longer than RECONNECT_DEBOUNCE_MS but don't write lock yet
    await new Promise((r) => setTimeout(r, 1000));

    // Now write the new lock file but DON'T rely on fs.watch — polling should catch it
    // (In practice fs.watch may fire, but the polling interval should also recover)
    const wss2 = startMockBridge(port2, token2);
    writelock(lockDir, port2, token2);

    // Shim should reconnect within poll interval (expected: ≤10s with polling)
    const reconnectedCount = stderrLines.filter((l) =>
      l.includes("Connected"),
    ).length;

    const reconnected = await waitFor(
      () =>
        stderrLines.filter((l) => l.includes("Connected")).length >
        reconnectedCount,
      // BUG: without polling fallback, if watch event was missed, this never fires
      // Current timeout is generous but the test documents the expected behavior
      10000,
    );

    await closeServer(wss2);

    // BUG: without a polling loop, if the watch event is missed this FAILS
    // (We can't guarantee the watch event fires in all macOS CI environments)
    expect(reconnected).toBe(true);
  });
});
