import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "./logger.js";

export class LockFileManager {
  private lockFilePath: string | null = null;
  private cleanedUp = false;
  /** In-memory nonce written into the lock file — used to detect PID reuse in cleanStale(). */
  private ownNonce: string | null = null;

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
    opts?: { orchestrator?: boolean },
  ): string {
    const dir = this.getLockDir();
    const lockPath = path.join(dir, `${port}.lock`);

    const nonce = crypto.randomBytes(8).toString("hex");
    this.ownNonce = nonce;
    const content = {
      pid: process.pid,
      startedAt: Date.now(),
      nonce,
      workspace: workspaceFolders[0] ?? null,
      workspaceFolders,
      ideName,
      isBridge: true,
      orchestrator: opts?.orchestrator ?? false,
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
        // After rmSync, O_EXCL ensures we fail if a new file/symlink appears in the
        // race window. On POSIX, O_NOFOLLOW provides defence-in-depth against a
        // symlink placed in that window (kernel rejects the open rather than
        // following it). On Windows, O_NOFOLLOW is undefined so we fall back to 0 —
        // O_EXCL alone still prevents double-create; symlink attacks are not a
        // practical concern on Windows without junction-point exploit chains.
        const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
        fs.rmSync(lockPath, { force: true });
        const fd = fs.openSync(
          lockPath,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            O_NOFOLLOW,
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
            // A multi-root workspace with many long folder paths in
            // workspaceFolders can legitimately exceed 4096 bytes — don't
            // delete a live sibling's lock based on size alone (every other
            // branch in this function checks PID liveness first). Only treat
            // it as garbage if it doesn't parse as valid JSON with a live PID.
            let keep = false;
            try {
              const raw = fs.readFileSync(filePath, "utf-8");
              const content = JSON.parse(raw);
              if (
                typeof content.pid === "number" &&
                Number.isInteger(content.pid) &&
                content.pid > 0
              ) {
                try {
                  process.kill(content.pid, 0);
                  keep = true;
                } catch (killErr) {
                  // EPERM: process exists but we lack permission to signal it
                  // (cross-user/elevated) — assume a legitimate live sibling.
                  // ESRCH or anything else: dead, fall through to delete.
                  keep = (killErr as NodeJS.ErrnoException).code === "EPERM";
                }
              }
            } catch {
              // unparseable — fall through to delete as oversized garbage
            }
            if (keep) {
              this.logger.debug(
                `Oversized but valid lock file, keeping: ${file} (${stat.size} bytes)`,
              );
              continue;
            }
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
              // Throws ESRCH if dead. On Windows a dead process whose handle
              // hasn't been released yet may return EPERM — the nonce check
              // below is the secondary stale guard for that edge case.
              process.kill(content.pid, 0);
              // PID appears alive.
              // Only attempt stale-detection on our OWN PID (e.g. a previous crash
              // that left our lock behind and the OS reused our PID for another
              // process). A different live PID belongs to a legitimate sibling
              // bridge — never delete it based on nonce comparison alone.
              if (content.pid === process.pid) {
                // Our own PID: check for stale lock left by a previous crash.
                if (
                  typeof content.nonce === "string" &&
                  this.ownNonce !== null &&
                  content.nonce !== this.ownNonce
                ) {
                  // Nonce mismatch — our PID was reused after a crash and this
                  // lock belongs to the old instance.
                  this.logger.warn(
                    `Removing stale lock file: ${file} (our PID ${content.pid} alive but nonce mismatch — likely PID reuse after crash)`,
                  );
                  fs.unlinkSync(filePath);
                } else if (
                  typeof content.nonce !== "string" &&
                  typeof content.startedAt === "number"
                ) {
                  // Legacy lock format (no nonce): use 24h age heuristic only
                  // for our own PID to catch old-format stale locks.
                  const lockAgeMs = Date.now() - content.startedAt;
                  if (lockAgeMs > 24 * 60 * 60 * 1000) {
                    this.logger.warn(
                      `Removing stale lock file: ${file} (our PID ${content.pid} alive but lock is ${Math.round(lockAgeMs / 3_600_000)}h old — legacy format, likely stale)`,
                    );
                    fs.unlinkSync(filePath);
                  }
                }
                // else: it really is our own live lock — leave it alone
              }
              // Different live PID → legitimate sibling bridge instance;
              // never delete based on age or nonce alone.
            } catch (killErr) {
              // On Windows `process.kill(foreignPid, 0)` can throw EPERM
              // for a LIVE process the bridge user lacks permission to
              // signal (e.g. lock owned by a different OS user or by a
              // higher-integrity process). Unconditionally unlinking on
              // any kill failure would WRONGLY delete a legitimate
              // foreign sibling's lock. Distinguish:
              //   - ESRCH → process is gone, remove the lock
              //   - EPERM on Windows → permission-only, do NOT delete
              //   - EPERM on POSIX → could be either (kernel doesn't
              //     distinguish for our pid). Conservative: do nothing
              //     for foreign pids, only act on our own pid via the
              //     nonce/age branch above. Audit 2026-05-17.
              const code = (killErr as NodeJS.ErrnoException).code;
              if (code === "ESRCH") {
                this.logger.warn(
                  `Removing stale lock file: ${file} (PID ${content.pid} not running)`,
                );
                fs.unlinkSync(filePath);
              } else if (code === "EPERM") {
                this.logger.warn(
                  `Keeping lock file ${file} — PID ${content.pid} returned EPERM (permission denied; assuming legitimate foreign sibling)`,
                );
              } else {
                // Other errno (rare). Preserve the lock — better to let
                // a stale-but-foreign lock linger than to wrongly delete
                // a live sibling's coordination file.
                this.logger.warn(
                  `Keeping lock file ${file} — process.kill(${content.pid}, 0) failed with ${code ?? "unknown"}: ${killErr instanceof Error ? killErr.message : String(killErr)}`,
                );
              }
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
