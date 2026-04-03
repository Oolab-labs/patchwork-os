import type * as cp from "node:child_process";
import { execFile, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

import { LOCK_DIR } from "./constants";

const execFileAsync = promisify(execFile);

export interface BridgeStartedEvent {
  port: number;
  authToken: string;
  /** PID of the spawned bridge process. Use in connectDirect() to avoid storing a dummy -1. */
  pid: number;
}

const LOCK_POLL_INTERVAL_MS = 250;
const LOCK_POLL_TIMEOUT_MS = 15_000;
const MAX_RESTARTS = 5;
const STABLE_RUN_MS = 60_000;
const RESTART_BACKOFF = [1000, 2000, 4000, 8000, 30_000];

/**
 * Manages the lifecycle of a `claude-ide-bridge` child process for one
 * workspace folder. Spawns the bridge, waits for its lock file to appear,
 * and exposes callbacks for started/failed/exit events.
 *
 * One BridgeProcess per workspace folder is created by extension.ts when no
 * valid lock file already exists for that workspace.
 */
export class BridgeProcess {
  private child: cp.ChildProcess | null = null;
  private stopped = false;
  private restartCount = 0;
  private spawnedAt = 0;
  private stderrTail = "";
  private lockPollTimer: ReturnType<typeof setInterval> | null = null;
  private lockPollTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private sentinelPath: string;

  onStarted: ((event: BridgeStartedEvent) => void) | null = null;
  onStartupFailed: ((err: string) => void) | null = null;
  onStopped: (() => void) | null = null;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly workspacePath: string,
    private readonly lockDir: string = LOCK_DIR,
    /** Override poll timeout (ms) — for tests only. */
    private readonly lockPollTimeoutMs: number = LOCK_POLL_TIMEOUT_MS,
    /** Fixed port to pass as --port. 0 = let the bridge auto-select. */
    private readonly port: number = 0,
  ) {
    // Sentinel file prevents two VS Code windows from racing to spawn a bridge
    // for the same workspace. Uses a hash of the workspace path as the filename.
    const hash = crypto
      .createHash("sha1")
      .update(workspacePath)
      .digest("hex")
      .slice(0, 12);
    this.sentinelPath = path.join(this.lockDir, `${hash}.spawning`);
  }

  private log(msg: string): void {
    this.output.appendLine(
      `${new Date().toISOString()} [BridgeProcess:${path.basename(this.workspacePath)}] ${msg}`,
    );
  }

  isAlive(): boolean {
    return (
      this.child !== null && !this.child.killed && this.child.exitCode === null
    );
  }

  /** Resolve the path to the `claude-ide-bridge` binary. */
  private async resolveBinary(): Promise<string> {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    try {
      const { stdout } = await execFileAsync(whichCmd, ["claude-ide-bridge"], {
        timeout: 5_000,
      });
      return stdout.trim().split("\n")[0].trim();
    } catch {
      // Fall back to bare command name — PATH resolution at spawn time
      return "claude-ide-bridge";
    }
  }

  /**
   * Acquire the sentinel file. Returns true if we got the lock, false if
   * another process is already spawning for this workspace.
   */
  /**
   * Acquire the sentinel file. Returns true if we got the lock, false if
   * another live process is already spawning for this workspace.
   *
   * Atomicity: uses O_EXCL for initial creation. When a stale sentinel is
   * found (owning PID dead or TTL expired), we unlink it and retry the O_EXCL
   * open rather than overwriting in-place — `unlink + open(O_EXCL)` is atomic
   * on POSIX, preventing the TOCTOU race that `writeFile` would introduce.
   */
  private async acquireSentinel(): Promise<boolean> {
    try {
      await fsp.mkdir(this.lockDir, { recursive: true, mode: 0o700 });
    } catch {
      /* lockDir may already exist */
    }

    const SENTINEL_CONTENT = JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
    });
    const SENTINEL_TTL_MS = 60_000; // sentinels older than 60s are always stale

    try {
      // O_EXCL ensures atomic creation — fails if file already exists
      const fd = await fsp.open(this.sentinelPath, "wx");
      await fd.writeFile(SENTINEL_CONTENT);
      await fd.close();
      return true;
    } catch {
      // File exists — inspect to determine if it is stale
      let isStale = false;
      try {
        const raw = await fsp.readFile(this.sentinelPath, "utf-8");
        const parsed = JSON.parse(raw) as { pid?: number; startedAt?: number };
        const pid = typeof parsed.pid === "number" ? parsed.pid : Number.NaN;
        const startedAt =
          typeof parsed.startedAt === "number" ? parsed.startedAt : 0;

        // Treat as stale if TTL expired (guards against PID reuse)
        if (Date.now() - startedAt > SENTINEL_TTL_MS) {
          isStale = true;
        } else if (!Number.isNaN(pid)) {
          try {
            process.kill(pid, 0); // throws ESRCH if dead, EPERM if alive+different user
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ESRCH") isStale = true;
            // EPERM means alive but different user — treat as live sentinel
          }
        }
      } catch {
        // Unreadable or invalid JSON — treat as stale
        isStale = true;
      }

      if (!isStale) return false;

      // Stale sentinel — unlink and retry with O_EXCL (atomic takeover)
      try {
        await fsp.unlink(this.sentinelPath);
        const fd = await fsp.open(this.sentinelPath, "wx");
        await fd.writeFile(SENTINEL_CONTENT);
        await fd.close();
        return true;
      } catch {
        // Another process beat us to the O_EXCL after our unlink — they own it now
        return false;
      }
    }
  }

  private async releaseSentinel(): Promise<void> {
    try {
      await fsp.unlink(this.sentinelPath);
    } catch {
      /* best-effort */
    }
  }

  /** Poll the lock directory until a lock file for this workspace appears. */
  private waitForLockFile(): Promise<BridgeStartedEvent> {
    return new Promise((resolve, reject) => {
      // Independent deadline — guarantees the promise settles within
      // lockPollTimeoutMs even if readdir stalls indefinitely.
      this.lockPollTimeoutTimer = setTimeout(() => {
        this.clearLockPoll();
        reject(
          new Error(
            `Bridge did not write a lock file within ${LOCK_POLL_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, this.lockPollTimeoutMs);

      this.lockPollTimer = setInterval(async () => {
        try {
          const files = await fsp.readdir(this.lockDir);
          for (const file of files) {
            if (!file.endsWith(".lock")) continue;
            try {
              const raw = await fsp.readFile(
                path.join(this.lockDir, file),
                "utf-8",
              );
              const content = JSON.parse(raw) as {
                authToken?: string;
                pid?: number;
                workspace?: string;
                isBridge?: boolean;
              };
              if (!content.isBridge) continue;
              if (!content.authToken) continue;
              if (
                content.workspace &&
                path.resolve(content.workspace) !==
                  path.resolve(this.workspacePath)
              )
                continue;

              const port = Number.parseInt(path.basename(file, ".lock"), 10);
              if (Number.isNaN(port)) continue;

              // Check if the process that wrote the lock file is still alive.
              // A stale lock file (dead PID) would cause a connection hang.
              const pid = content.pid;
              if (typeof pid === "number" && pid > 0) {
                try {
                  process.kill(pid, 0);
                  // If we reach here, the process is alive
                } catch (err: unknown) {
                  const code = (err as NodeJS.ErrnoException).code;
                  if (code === "ESRCH") {
                    // Process is dead — skip this stale lock file
                    continue;
                  }
                  // EPERM means alive but different user — treat as live
                }
              }

              this.clearLockPoll();
              resolve({
                port,
                authToken: content.authToken,
                pid: content.pid ?? -1,
              });
              return;
            } catch {
              /* skip unreadable lock files */
            }
          }
        } catch (err) {
          this.clearLockPoll();
          reject(err);
        }
      }, LOCK_POLL_INTERVAL_MS);
    });
  }

  private clearLockPoll(): void {
    if (this.lockPollTimer) {
      clearInterval(this.lockPollTimer);
      this.lockPollTimer = null;
    }
    if (this.lockPollTimeoutTimer) {
      clearTimeout(this.lockPollTimeoutTimer);
      this.lockPollTimeoutTimer = null;
    }
  }

  /**
   * Spawn the bridge process for this workspace. Acquires the sentinel,
   * spawns the child, polls for the lock file, then fires `onStarted`.
   */
  async spawn(): Promise<void> {
    if (this.stopped) return;

    const acquired = await this.acquireSentinel();
    if (!acquired) {
      this.log(
        "Another process is already spawning the bridge — will poll for lock file instead.",
      );
      // Wait for the other spawner to finish and pick up the lock file
      try {
        const event = await this.waitForLockFile();
        this.onStarted?.(event);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`Timed out waiting for sibling spawn: ${msg}`);
        this.onStartupFailed?.(msg);
      }
      return;
    }

    let binary: string;
    try {
      binary = await this.resolveBinary();
    } catch (err: unknown) {
      await this.releaseSentinel();
      const msg = `Could not resolve claude-ide-bridge binary: ${err instanceof Error ? err.message : String(err)}`;
      this.log(msg);
      this.onStartupFailed?.(msg);
      return;
    }

    const spawnArgs = ["--workspace", this.workspacePath];
    if (this.port > 0) spawnArgs.push("--port", String(this.port));
    this.log(`Spawning: ${binary} ${spawnArgs.join(" ")}`);
    this.spawnedAt = Date.now();
    this.stderrTail = ""; // reset stderr tail from any previous spawn attempt

    const child = spawn(binary, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      this.output.append(chunk.toString("utf-8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.output.append(text);
      // Keep a rolling tail of the last 2 KB of stderr so we can surface it in
      // startup failure notifications (the output channel is often not visible).
      this.stderrTail = (this.stderrTail + text).slice(-2000);
    });

    child.on("error", async (err) => {
      await this.releaseSentinel();
      const base = `Bridge spawn error: ${err.message}`;
      const tail = this.stderrTail.trim();
      const msg = tail ? `${base}\nLast output: ${tail.slice(-500)}` : base;
      this.log(msg);
      this.clearLockPoll();
      if (!this.stopped) this.onStartupFailed?.(msg);
    });

    child.on("exit", (code) => {
      this.log(`Bridge exited with code ${code ?? "null"}`);
      this.clearLockPoll();
      if (!this.stopped) {
        void this.handleUnexpectedExit(code);
      } else {
        this.onStopped?.();
      }
    });

    // Wait for the lock file to appear
    try {
      const event = await this.waitForLockFile();
      await this.releaseSentinel();
      // If stop() was called while we were waiting, don't fire onStarted
      if (this.stopped) return;
      this.log(`Bridge ready on port ${event.port}`);
      this.onStarted?.(event);
    } catch (err: unknown) {
      await this.releaseSentinel();
      // Intentional stop — don't surface as a failure to the caller
      if (this.stopped) return;
      const base = err instanceof Error ? err.message : String(err);
      const tail = this.stderrTail.trim();
      const msg = tail ? `${base}\nLast output: ${tail.slice(-500)}` : base;
      this.log(`Startup failed: ${msg}`);
      this.onStartupFailed?.(msg);
    }
  }

  private async handleUnexpectedExit(_code: number | null): Promise<void> {
    if (this.stopped) return;

    const ranFor = Date.now() - this.spawnedAt;
    if (ranFor > STABLE_RUN_MS) {
      this.restartCount = 0;
    }

    if (this.restartCount >= MAX_RESTARTS) {
      const msg = `Bridge crashed ${MAX_RESTARTS} times — giving up.`;
      this.log(msg);
      void vscode.window
        .showErrorMessage(
          `Claude IDE Bridge failed to start (crashed ${MAX_RESTARTS} times). Check the Claude IDE Bridge output channel.`,
          "Show Logs",
        )
        .then((choice) => {
          if (choice === "Show Logs") this.output.show();
        });
      // Notify the connection so it falls back to watching for a manually-started bridge
      this.onStartupFailed?.(msg);
      return;
    }

    const delay =
      RESTART_BACKOFF[Math.min(this.restartCount, RESTART_BACKOFF.length - 1)];
    this.restartCount++;
    this.log(
      `Restarting in ${delay}ms (attempt ${this.restartCount}/${MAX_RESTARTS})...`,
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) void this.spawn();
    }, delay);
  }

  /**
   * Gracefully stop the bridge process (SIGTERM, then SIGKILL after 3s).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearLockPoll();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await this.releaseSentinel();

    if (!this.child || this.child.killed) return;

    const child = this.child;
    return new Promise((resolve) => {
      const forceKill = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* best-effort */
        }
        resolve();
      }, 3_000);

      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(forceKill);
        resolve();
      }
    });
  }
}
