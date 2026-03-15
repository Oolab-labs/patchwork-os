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
});
