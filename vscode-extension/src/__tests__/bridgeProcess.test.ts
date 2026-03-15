import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// Mock vscode
vi.mock("vscode", () => ({
  window: {
    showErrorMessage: vi.fn(async () => undefined),
    withProgress: vi.fn(async (_opts: unknown, task: () => Promise<void>) => task()),
  },
  ProgressLocation: { Window: 10 },
}));

// Mock child_process.spawn and execFile
const mockChildProcess = new EventEmitter() as EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
};
mockChildProcess.stdout = new EventEmitter();
mockChildProcess.stderr = new EventEmitter();
mockChildProcess.killed = false;
mockChildProcess.exitCode = null;
mockChildProcess.kill = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return {
    ...mod,
    spawn: vi.fn(() => mockChildProcess),
    execFile: vi.fn((_bin: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: "/usr/local/bin/claude-ide-bridge\n", stderr: "" });
    }),
  };
});

import { BridgeProcess } from "../bridgeProcess";
import * as vscode from "vscode";

let tmpDir: string;
let output: { appendLine: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
  output = { appendLine: vi.fn(), append: vi.fn(), show: vi.fn() };
  // Reset child process mock state
  mockChildProcess.killed = false;
  mockChildProcess.exitCode = null;
  mockChildProcess.removeAllListeners();
  mockChildProcess.stdout.removeAllListeners();
  mockChildProcess.stderr.removeAllListeners();
  vi.clearAllMocks();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/** Helper: write a valid bridge lock file */
async function writeLockFile(
  lockDir: string,
  port: number,
  workspace: string,
  authToken = "test-token",
) {
  await fsp.writeFile(
    path.join(lockDir, `${port}.lock`),
    JSON.stringify({ authToken, pid: process.pid, workspace, isBridge: true }),
  );
}

/** Helper: create a BridgeProcess with a short poll timeout for fast tests */
function makeProc(workspace: string, timeoutMs = 500) {
  return new BridgeProcess(
    output as unknown as import("vscode").OutputChannel,
    workspace,
    tmpDir,
    timeoutMs,
  );
}

describe("BridgeProcess", () => {
  it("fires onStarted when lock file appears for the workspace", async () => {
    const ws = "/home/user/project";
    const proc = makeProc(ws);
    const startedEvents: Array<{ port: number; authToken: string }> = [];
    proc.onStarted = (e) => startedEvents.push(e);

    const spawnPromise = proc.spawn();

    await new Promise((r) => setTimeout(r, 50));
    await writeLockFile(tmpDir, 54321, ws, "test-token-123");

    await spawnPromise;

    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].port).toBe(54321);
    expect(startedEvents[0].authToken).toBe("test-token-123");
  });

  it("includes pid in the BridgeStartedEvent", async () => {
    const ws = "/home/user/project-pid";
    const proc = makeProc(ws);
    const startedEvents: Array<{ port: number; pid: number }> = [];
    proc.onStarted = (e) => startedEvents.push(e);

    const spawnPromise = proc.spawn();
    await new Promise((r) => setTimeout(r, 50));
    await writeLockFile(tmpDir, 11111, ws);
    await spawnPromise;

    expect(startedEvents[0].pid).toBe(process.pid);
  });

  it("fires onStartupFailed after poll timeout if no lock file appears", async () => {
    const ws = "/home/user/project-timeout";
    const proc = makeProc(ws, 300); // 300ms timeout
    const failedMessages: string[] = [];
    proc.onStartupFailed = (msg) => failedMessages.push(msg);

    await proc.spawn();

    expect(failedMessages).toHaveLength(1);
    expect(failedMessages[0]).toMatch(/lock file/);
  }, 5_000);

  it("does NOT fire onStartupFailed when stop() is called during startup", async () => {
    const ws = "/home/user/project-stop";
    const proc = makeProc(ws, 300);
    const failedMessages: string[] = [];
    proc.onStartupFailed = (msg) => failedMessages.push(msg);

    const spawnPromise = proc.spawn();
    // Stop before any lock file appears
    await proc.stop();
    await spawnPromise;

    expect(failedMessages).toHaveLength(0);
  }, 5_000);

  it("isAlive() returns false before spawn", () => {
    const proc = makeProc("/tmp/project");
    expect(proc.isAlive()).toBe(false);
  });

  it("stop() resolves without error when not running", async () => {
    const proc = makeProc("/tmp/project");
    await expect(proc.stop()).resolves.toBeUndefined();
  });

  it("releases sentinel file after successful spawn", async () => {
    const ws = "/home/user/project-sentinel";
    const proc = makeProc(ws);
    const spawnPromise = proc.spawn();

    await new Promise((r) => setTimeout(r, 30));
    await writeLockFile(tmpDir, 12345, ws);
    await spawnPromise;

    const files = await fsp.readdir(tmpDir);
    expect(files.filter((f) => f.endsWith(".spawning"))).toHaveLength(0);
  });

  it("skips spawn and polls when sentinel exists for another live PID", async () => {
    const ws = "/home/user/project-race";
    const proc = makeProc(ws, 600);

    // Write a valid JSON sentinel owned by the current process (= "alive")
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha1").update(ws).digest("hex").slice(0, 12);
    const sentinelPath = path.join(tmpDir, `${hash}.spawning`);
    await fsp.writeFile(
      sentinelPath,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    );

    const startedEvents: Array<{ port: number; authToken: string }> = [];
    proc.onStarted = (e) => startedEvents.push(e);

    const spawnPromise = proc.spawn();

    await new Promise((r) => setTimeout(r, 80));
    await writeLockFile(tmpDir, 99999, ws, "race-token");
    await spawnPromise;

    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].authToken).toBe("race-token");

    await fsp.unlink(sentinelPath).catch(() => {});
  });

  it("takes over a stale sentinel (dead PID) atomically", async () => {
    const ws = "/home/user/project-stale";
    const proc = makeProc(ws, 600);

    const { createHash } = await import("node:crypto");
    const hash = createHash("sha1").update(ws).digest("hex").slice(0, 12);
    const sentinelPath = path.join(tmpDir, `${hash}.spawning`);
    // Write a sentinel with a dead PID (PID 1 is init on Linux; on macOS kill(1,0) returns EPERM
    // so use a clearly invalid PID like 999999 which should not exist)
    await fsp.writeFile(
      sentinelPath,
      JSON.stringify({ pid: 999_999_999, startedAt: Date.now() }),
    );

    const startedEvents: Array<{ port: number }> = [];
    proc.onStarted = (e) => startedEvents.push(e);

    const spawnPromise = proc.spawn();
    await new Promise((r) => setTimeout(r, 50));
    await writeLockFile(tmpDir, 22222, ws);
    await spawnPromise;

    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].port).toBe(22222);
  });

  it("takes over a sentinel that has exceeded TTL regardless of PID", async () => {
    const ws = "/home/user/project-ttl";
    const proc = makeProc(ws, 600);

    const { createHash } = await import("node:crypto");
    const hash = createHash("sha1").update(ws).digest("hex").slice(0, 12);
    const sentinelPath = path.join(tmpDir, `${hash}.spawning`);
    // Expired sentinel: startedAt far in the past, PID = current process (alive)
    await fsp.writeFile(
      sentinelPath,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() - 120_000 }),
    );

    const startedEvents: Array<{ port: number }> = [];
    proc.onStarted = (e) => startedEvents.push(e);

    const spawnPromise = proc.spawn();
    await new Promise((r) => setTimeout(r, 50));
    await writeLockFile(tmpDir, 33333, ws);
    await spawnPromise;

    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].port).toBe(33333);
  });
});

describe("BridgeProcess — restart loop", () => {
  it("calls onStartupFailed after MAX_RESTARTS crashes", async () => {
    const ws = "/home/user/project-crashes";
    const proc = makeProc(ws, 200);
    const failedMessages: string[] = [];
    proc.onStartupFailed = (msg) => failedMessages.push(msg);

    // Directly drive handleUnexpectedExit (private) to test the logic without
    // real timers or the full spawn/lock-file dance.
    // biome-ignore lint/suspicious/noExplicitAny: testing private method
    const handleExit = (proc as any).handleUnexpectedExit.bind(proc);

    // Set spawnedAt to now so ranFor < STABLE_RUN_MS and restartCount is NOT reset
    // biome-ignore lint/suspicious/noExplicitAny: accessing private for test
    (proc as any).spawnedAt = Date.now();

    // Exhaust all restarts (5 × exit) — each increments restartCount and
    // schedules a setTimeout that we immediately clear so the test is synchronous.
    for (let i = 0; i < 5; i++) {
      await handleExit(1);
      // biome-ignore lint/suspicious/noExplicitAny: accessing private for test
      if ((proc as any).restartTimer) {
        // biome-ignore lint/suspicious/noExplicitAny: accessing private for test
        clearTimeout((proc as any).restartTimer);
        // biome-ignore lint/suspicious/noExplicitAny: accessing private for test
        (proc as any).restartTimer = null;
      }
    }

    // 6th call should hit MAX_RESTARTS (5) and call onStartupFailed
    await handleExit(1);

    expect(failedMessages.length).toBeGreaterThan(0);
    expect(failedMessages[0]).toMatch(/crashed/);
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });

  it("resets restart count after bridge runs stably for > 60s", async () => {
    const ws = "/home/user/project-stable";
    const proc = makeProc(ws, 200);

    // Set restart count near limit and simulate a stable run
    // biome-ignore lint/suspicious/noExplicitAny: accessing private for test
    (proc as any).restartCount = 4;
    // biome-ignore lint/suspicious/noExplicitAny: accessing private for test
    (proc as any).spawnedAt = Date.now() - 70_000; // ran for 70s > STABLE_RUN_MS (60s)

    // biome-ignore lint/suspicious/noExplicitAny: testing private method
    await (proc as any).handleUnexpectedExit(1);

    // restartCount was reset to 0, then incremented to 1 — should NOT hit MAX_RESTARTS
    // biome-ignore lint/suspicious/noExplicitAny: accessing private for test
    expect((proc as any).restartCount).toBe(1);

    // Clean up the scheduled restart timer
    // biome-ignore lint/suspicious/noExplicitAny: accessing private for test
    if ((proc as any).restartTimer) {
      // biome-ignore lint/suspicious/noExplicitAny: accessing private for test
      clearTimeout((proc as any).restartTimer);
    }
  });
});
