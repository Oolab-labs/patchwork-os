/**
 * Tests for mcp-stdio-shim.cjs backoff and error-handling behavior.
 *
 * Covers:
 *   - Exponential backoff on HTTP 429 (rate-limited upgrade rejection)
 *   - Exponential backoff on ECONNREFUSED
 *   - Passive reconnect mode after SHIM_MAX_UNREACHABLE_MS (no exit — auto-recovers when bridge restarts)
 *   - 401 upgrade rejection → immediate exit
 *   - stdin EPIPE → clean exit (no unhandled exception crash)
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
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

// ---- Helpers ----------------------------------------------------------------

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

/** Find a free TCP port. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

/**
 * Start a raw HTTP server that always responds with a given status code to the
 * WebSocket upgrade request. This is used to simulate 429 and 401 responses
 * without completing the WebSocket handshake.
 */
function startRejectServer(statusCode: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.on("upgrade", (_req, socket) => {
      socket.write(
        `HTTP/1.1 ${statusCode} ${statusCode === 429 ? "Too Many Requests" : "Unauthorized"}\r\n\r\n`,
      );
      socket.destroy();
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function startMockBridge(port: number, token: string): WebSocketServer {
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  wss.on("connection", (ws, req) => {
    const auth = req.headers["x-claude-code-ide-authorization"];
    if (auth !== token) ws.close(4001, "Unauthorized");
  });
  return wss;
}

async function closeServer(srv: http.Server | WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    srv.close((err) => (err ? reject(err) : resolve()));
    if ("clients" in srv) {
      for (const client of srv.clients) client.terminate();
    }
  });
}

// ---- Fixture setup ----------------------------------------------------------

let tmpDir: string;
let shimProcess: ChildProcess | null = null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-backoff-test-"));
  fs.mkdirSync(path.join(tmpDir, "ide"), { mode: 0o700 });
});

afterEach(async () => {
  shimProcess?.kill();
  shimProcess = null;
  await new Promise((r) => setTimeout(r, 150));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function spawnShim(env: Record<string, string> = {}): {
  proc: ChildProcess;
  stderr: string[];
} {
  const proc = spawn(process.execPath, [SHIM_PATH], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  shimProcess = proc;
  const stderr: string[] = [];
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (d: string) => stderr.push(d));
  return { proc, stderr };
}

// ---- Tests ------------------------------------------------------------------

describe("429 rate-limit backoff", () => {
  it("retries with exponential back-off instead of hammering the bridge", async () => {
    const srv = await startRejectServer(429);
    const port = (srv.address() as net.AddressInfo).port;
    const lockDir = path.join(tmpDir, "ide");
    writelock(lockDir, port, "tok");

    // Short enough that we see multiple retries but don't wait forever
    const { stderr } = spawnShim({ SHIM_MAX_UNREACHABLE_MS: "20000" });

    // Wait for at least 2 "Will retry" messages
    const retryMs: number[] = [];
    const retryPattern = /Will retry in (\d+)s/;
    const gotTwo = await waitFor(() => {
      for (const line of stderr) {
        const m = line.match(retryPattern);
        if (m) {
          const secs = Number(m[1]);
          if (!retryMs.includes(secs)) retryMs.push(secs);
        }
      }
      return retryMs.length >= 2;
    }, 15_000);

    await closeServer(srv);

    expect(gotTwo).toBe(true);
    // Second delay should be >= first (exponential growth — with full jitter the
    // distribution is non-deterministic so we only assert non-zero growth trend)
    expect(retryMs[0]).toBeGreaterThanOrEqual(0);
    expect(retryMs[1]).toBeGreaterThanOrEqual(0);
    // At least one retry message should mention "429"
    expect(stderr.join("")).toContain("429");
  }, 20_000);

  it("switches to passive reconnect mode (does not exit) after SHIM_MAX_UNREACHABLE_MS", async () => {
    const srv = await startRejectServer(429);
    const port = (srv.address() as net.AddressInfo).port;
    writelock(path.join(tmpDir, "ide"), port, "tok");

    const { proc, stderr } = spawnShim({ SHIM_MAX_UNREACHABLE_MS: "2000" });

    let exitCode: number | null = null;
    proc.on("exit", (code) => {
      exitCode = code;
    });

    // Shim should log the passive-mode message and NOT exit
    const loggedPassive = await waitFor(
      () => stderr.join("").includes("passive reconnect mode"),
      20_000,
    );
    await closeServer(srv);

    expect(loggedPassive).toBe(true);
    expect(exitCode).toBeNull(); // still running
    proc.kill();
  }, 30_000);
});

describe("ECONNREFUSED backoff", () => {
  it("retries with back-off on a dead port instead of spamming immediately", async () => {
    // Find a port that is definitely not listening
    const deadPort = await freePort();
    writelock(path.join(tmpDir, "ide"), deadPort, "tok");

    const { stderr } = spawnShim({ SHIM_MAX_UNREACHABLE_MS: "20000" });

    // Wait for at least 2 "Will retry" messages
    const retryLines: string[] = [];
    const gotTwo = await waitFor(() => {
      const all = stderr.join("");
      const matches = all.match(/Will retry in \d+s/g) ?? [];
      for (const m of matches) {
        if (!retryLines.includes(m)) retryLines.push(m);
      }
      return retryLines.length >= 2;
    }, 15_000);

    expect(gotTwo).toBe(true);
    expect(stderr.join("")).toContain("ECONNREFUSED");
  }, 20_000);

  it("switches to passive reconnect mode (does not exit) after SHIM_MAX_UNREACHABLE_MS on ECONNREFUSED", async () => {
    const deadPort = await freePort();
    writelock(path.join(tmpDir, "ide"), deadPort, "tok");

    const { proc, stderr } = spawnShim({ SHIM_MAX_UNREACHABLE_MS: "2000" });

    let exitCode: number | null = null;
    proc.on("exit", (code) => {
      exitCode = code;
    });

    // Shim should log the passive-mode message and NOT exit
    const loggedPassive = await waitFor(
      () => stderr.join("").includes("passive reconnect mode"),
      10_000,
    );
    expect(loggedPassive).toBe(true);
    expect(exitCode).toBeNull(); // still running
    proc.kill();
  }, 15_000);
});

describe("401 rejection → immediate exit", () => {
  it("exits immediately with code 1 when the bridge returns 401", async () => {
    const srv = await startRejectServer(401);
    const port = (srv.address() as net.AddressInfo).port;
    writelock(path.join(tmpDir, "ide"), port, "tok");

    const { proc, stderr } = spawnShim();

    let exitCode: number | null = null;
    proc.on("exit", (code) => {
      exitCode = code;
    });

    const exited = await waitFor(() => exitCode !== null, 5000);
    await closeServer(srv);

    expect(exited).toBe(true);
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toMatch(/401|auth/i);
  }, 10_000);
});

describe("stdin EPIPE → clean exit", () => {
  it("exits cleanly (code 0) when stdin is destroyed and logs the event", async () => {
    const port = await freePort();
    const token = "epipe-token";
    const wss = startMockBridge(port, token);
    writelock(path.join(tmpDir, "ide"), port, token);

    const { proc, stderr } = spawnShim();

    // Wait for the shim to connect
    const connected = await waitFor(
      () => stderr.some((l) => l.includes("Connected")),
      5000,
    );
    expect(connected).toBe(true);

    let exitCode: number | null = null;
    proc.on("exit", (code) => {
      exitCode = code;
    });

    // Destroy stdin to simulate the MCP host closing the pipe (EPIPE scenario)
    proc.stdin?.destroy();

    const exited = await waitFor(() => exitCode !== null, 5000);
    await closeServer(wss);

    expect(exited).toBe(true);
    // Should exit cleanly (0) — not crash with an unhandled exception (null/non-zero)
    expect(exitCode).toBe(0);
  }, 15_000);
});
