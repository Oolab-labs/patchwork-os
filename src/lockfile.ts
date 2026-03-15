import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "./logger.js";

export class LockFileManager {
  private lockFilePath: string | null = null;
  private cleanedUp = false;

  constructor(private logger: Logger) {}

  private getLockDir(): string {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const dir = path.join(configDir, "ide");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Enforce permissions even if directory already existed with wrong mode
    fs.chmodSync(dir, 0o700);
    return dir;
  }

  write(
    port: number,
    authToken: string,
    workspaceFolders: string[],
    ideName: string,
  ): string {
    const dir = this.getLockDir();
    const lockPath = path.join(dir, `${port}.lock`);

    const content = {
      pid: process.pid,
      startedAt: Date.now(),
      workspace: workspaceFolders[0] ?? null,
      workspaceFolders,
      ideName,
      isBridge: true,
      transport: "ws",
      runningInWindows: process.platform === "win32",
      authToken,
    };

    const data = JSON.stringify(content);

    // Use O_EXCL to prevent symlink attacks — if file exists, remove and retry once
    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      try {
        fs.writeSync(fd, data);
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(lockPath, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Force-remove whatever is at lockPath (regular file or stale symlink).
        // We do NOT lstat+check first — that introduces a TOCTOU race.
        // The subsequent O_EXCL|O_NOFOLLOW open guarantees we create a new regular
        // file and refuse to follow any symlink an attacker may have placed after rm.
        fs.rmSync(lockPath, { force: true });
        const fd = fs.openSync(
          lockPath,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            (fs.constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          fs.writeSync(fd, data);
        } finally {
          fs.closeSync(fd);
        }
        fs.chmodSync(lockPath, 0o600);
      } else {
        throw err;
      }
    }

    this.lockFilePath = lockPath;
    this.logger.debug(`Lock file written: ${lockPath}`);
    return lockPath;
  }

  delete(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    if (this.lockFilePath) {
      try {
        fs.unlinkSync(this.lockFilePath);
        this.logger.debug(`Lock file removed: ${this.lockFilePath}`);
      } catch {
        // best-effort
      }
    }
  }

  /** Remove stale lock files from dead processes */
  cleanStale(): void {
    try {
      const dir = this.getLockDir();
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".lock")) continue;
        const filePath = path.join(dir, file);
        try {
          // Use lstatSync so symlinks to large files don't fool the size check
          const stat = fs.lstatSync(filePath);
          // Skip symlinks — they shouldn't exist here; remove them defensively
          if (stat.isSymbolicLink()) {
            this.logger.warn(`Removing symlink in lock dir: ${file}`);
            fs.unlinkSync(filePath);
            continue;
          }
          if (stat.size > 4096) {
            this.logger.warn(
              `Removing oversized lock file: ${file} (${stat.size} bytes)`,
            );
            fs.unlinkSync(filePath);
            continue;
          }
          const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          if (
            typeof content.pid === "number" &&
            Number.isInteger(content.pid) &&
            content.pid > 0
          ) {
            try {
              process.kill(content.pid, 0); // check if alive — throws if dead
              // PID appears alive — guard against PID reuse: if the lock has a
              // startedAt timestamp and it is >24h old, the original process
              // almost certainly died and its PID was recycled by an unrelated
              // process. Only apply when startedAt is present (old lock format
              // without the field is left alone).
              if (typeof content.startedAt === "number") {
                const lockAgeMs = Date.now() - content.startedAt;
                if (lockAgeMs > 24 * 60 * 60 * 1000) {
                  this.logger.warn(
                    `Removing stale lock file: ${file} (PID ${content.pid} alive but lock is ${Math.round(lockAgeMs / 3_600_000)}h old — likely PID reuse)`,
                  );
                  fs.unlinkSync(filePath);
                }
              }
            } catch {
              this.logger.warn(
                `Removing stale lock file: ${file} (PID ${content.pid} not running)`,
              );
              fs.unlinkSync(filePath);
            }
          }
        } catch (err) {
          this.logger.warn(
            `Skipping malformed lock file ${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `Failed to scan lock directory: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
