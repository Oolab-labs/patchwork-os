import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockFileManager } from "../lockfile.js";
import { Logger } from "../logger.js";

let tmpDir: string;
let logger: Logger;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-test-"));
  // Point the lock file manager at our temp dir
  process.env.CLAUDE_CONFIG_DIR = tmpDir;
  logger = new Logger(false);
});

afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("LockFileManager", () => {
  it.skipIf(process.platform === "win32")(
    "creates lock file with correct permissions",
    () => {
      const mgr = new LockFileManager(logger);
      const lockPath = mgr.write(
        12345,
        "test-token",
        ["/workspace"],
        "TestIDE",
      );

      expect(fs.existsSync(lockPath)).toBe(true);
      const stat = fs.statSync(lockPath);
      // 0o600 = owner read/write only
      expect(stat.mode & 0o777).toBe(0o600);

      const content = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      expect(content.authToken).toBe("test-token");
      expect(content.pid).toBe(process.pid);
      expect(content.ideName).toBe("TestIDE");
    },
  );

  // On Windows chmod is a no-op (NTFS uses ACLs, not POSIX mode bits), so
  // the mode assertion above is skipped. This variant asserts that the lock
  // file is still created with the correct content on Win32.
  it.skipIf(process.platform !== "win32")(
    "creates lock file with correct content (Windows — no mode check)",
    () => {
      const mgr = new LockFileManager(logger);
      const lockPath = mgr.write(12345, "test-token", [os.tmpdir()], "TestIDE");
      expect(fs.existsSync(lockPath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      expect(content.authToken).toBe("test-token");
      expect(content.pid).toBe(process.pid);
      expect(content.ideName).toBe("TestIDE");
    },
  );

  it.skipIf(process.platform === "win32")(
    "enforces directory permissions on existing dirs",
    () => {
      // Create the ide dir with permissive mode
      const ideDir = path.join(tmpDir, "ide");
      fs.mkdirSync(ideDir, { recursive: true, mode: 0o755 });

      const mgr = new LockFileManager(logger);
      mgr.write(12345, "test-token", ["/workspace"], "TestIDE");

      // Should have been tightened to 0o700
      const stat = fs.statSync(ideDir);
      expect(stat.mode & 0o777).toBe(0o700);
    },
  );

  it("force-removes a symlink at the lock path and writes a new regular file", () => {
    const ideDir = path.join(tmpDir, "ide");
    fs.mkdirSync(ideDir, { recursive: true, mode: 0o700 });

    // Attacker places a symlink at the lock path before the bridge writes it.
    const lockPath = path.join(ideDir, "12345.lock");
    const targetPath = path.join(tmpDir, "evil-target");
    fs.writeFileSync(targetPath, "");
    fs.symlinkSync(targetPath, lockPath);

    const mgr = new LockFileManager(logger);
    // The symlink is force-removed and a new regular file is written via O_EXCL|O_NOFOLLOW.
    const result = mgr.write(12345, "test-token", ["/workspace"], "TestIDE");
    expect(result).toBe(lockPath);

    // The written path is a regular file, not a symlink.
    const stat = fs.lstatSync(lockPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);

    // The original symlink target is untouched (we only removed the symlink, not its target).
    expect(fs.existsSync(targetPath)).toBe(true);
  });

  it("overwrites existing regular lock file on retry", () => {
    const ideDir = path.join(tmpDir, "ide");
    fs.mkdirSync(ideDir, { recursive: true, mode: 0o700 });

    // Create a regular file at the lock path
    const lockPath = path.join(ideDir, "12345.lock");
    fs.writeFileSync(lockPath, '{"pid": 99999}', { mode: 0o600 });

    const mgr = new LockFileManager(logger);
    const result = mgr.write(12345, "new-token", ["/workspace"], "TestIDE");

    expect(result).toBe(lockPath);
    const content = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    expect(content.authToken).toBe("new-token");
  });

  it("deletes lock file on cleanup", () => {
    const mgr = new LockFileManager(logger);
    const lockPath = mgr.write(12345, "test-token", ["/workspace"], "TestIDE");

    expect(fs.existsSync(lockPath)).toBe(true);
    mgr.delete();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("cleanStale removes dead process lock files", () => {
    const ideDir = path.join(tmpDir, "ide");
    fs.mkdirSync(ideDir, { recursive: true, mode: 0o700 });

    // Write a lock file with a PID that doesn't exist
    const fakeLockPath = path.join(ideDir, "99999.lock");
    fs.writeFileSync(fakeLockPath, JSON.stringify({ pid: 999999 }), {
      mode: 0o600,
    });

    const mgr = new LockFileManager(logger);
    mgr.cleanStale();

    expect(fs.existsSync(fakeLockPath)).toBe(false);
  });

  it("cleanStale preserves live process lock files", () => {
    const ideDir = path.join(tmpDir, "ide");
    fs.mkdirSync(ideDir, { recursive: true, mode: 0o700 });

    // Write a lock file with the current PID (alive)
    const liveLockPath = path.join(ideDir, "11111.lock");
    fs.writeFileSync(liveLockPath, JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });

    const mgr = new LockFileManager(logger);
    mgr.cleanStale();

    expect(fs.existsSync(liveLockPath)).toBe(true);
  });

  it("cleanStale removes a live-PID lock whose startedAt is older than 24h (PID reuse guard)", () => {
    const ideDir = path.join(tmpDir, "ide");
    fs.mkdirSync(ideDir, { recursive: true, mode: 0o700 });

    // Case 1: alive PID + startedAt 25h ago → removed (too old, PID may be reused)
    const stalePath = path.join(ideDir, "22221.lock");
    fs.writeFileSync(
      stalePath,
      JSON.stringify({
        pid: process.pid,
        startedAt: Date.now() - 25 * 60 * 60 * 1000,
      }),
      { mode: 0o600 },
    );

    // Case 2: alive PID + startedAt 23h ago → kept (recent enough)
    const freshPath = path.join(ideDir, "22222.lock");
    fs.writeFileSync(
      freshPath,
      JSON.stringify({
        pid: process.pid,
        startedAt: Date.now() - 23 * 60 * 60 * 1000,
      }),
      { mode: 0o600 },
    );

    // Case 3: alive PID + no startedAt → kept (old lock format, backward compat)
    const legacyPath = path.join(ideDir, "22223.lock");
    fs.writeFileSync(legacyPath, JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });

    const mgr = new LockFileManager(logger);
    mgr.cleanStale();

    expect(fs.existsSync(stalePath)).toBe(false); // removed: 25h old
    expect(fs.existsSync(freshPath)).toBe(true); // kept: 23h old
    expect(fs.existsSync(legacyPath)).toBe(true); // kept: no startedAt
  });

  // ─── Foreign-PID EPERM (audit 2026-05-17) ──────────────────────────────────
  // process.kill(foreignPid, 0) throws EPERM on Windows for live processes
  // the bridge user lacks permission to signal (different user, higher
  // integrity). Pre-fix code unconditionally unlinked on ANY kill failure
  // → wrongly deleted a legitimate sibling's lock. Now: ESRCH unlinks,
  // EPERM (and other errnos) preserve the lock.
  it("cleanStale keeps foreign-PID lock when process.kill throws EPERM", () => {
    const ideDir = path.join(tmpDir, "ide");
    fs.mkdirSync(ideDir, { recursive: true, mode: 0o700 });

    const foreignLockPath = path.join(ideDir, "33333.lock");
    const foreignPid = 555555;
    fs.writeFileSync(foreignLockPath, JSON.stringify({ pid: foreignPid }), {
      mode: 0o600,
    });

    // Stub process.kill to throw EPERM for the foreign pid only.
    const origKill = process.kill;
    const killStub = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === foreignPid) {
        const err = new Error("kill EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return origKill(pid, signal);
    }) as typeof process.kill;
    // Assign via property descriptor since process.kill is read-only on
    // some Node builds.
    Object.defineProperty(process, "kill", {
      value: killStub,
      configurable: true,
    });
    try {
      const mgr = new LockFileManager(logger);
      mgr.cleanStale();
      expect(fs.existsSync(foreignLockPath)).toBe(true);
    } finally {
      Object.defineProperty(process, "kill", {
        value: origKill,
        configurable: true,
      });
    }
  });
});
