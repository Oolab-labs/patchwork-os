import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLockSync } from "../fileLockSync.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "patchwork-flock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("withFileLockSync", () => {
  it("runs the critical section and returns its value", () => {
    const target = path.join(dir, "log.jsonl");
    const result = withFileLockSync(target, () => "ok");
    expect(result).toBe("ok");
  });

  it("creates and removes the sentinel lock file around the call", () => {
    const target = path.join(dir, "log.jsonl");
    const lockPath = `${target}.lock`;
    let observedLockExists = false;
    withFileLockSync(target, () => {
      observedLockExists = existsSync(lockPath);
    });
    expect(observedLockExists).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock even when the critical section throws", () => {
    const target = path.join(dir, "log.jsonl");
    const lockPath = `${target}.lock`;
    expect(() =>
      withFileLockSync(target, () => {
        throw new Error("boom");
      }),
    ).toThrow(/boom/);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("blocks a held lock until timeoutMs and then throws", () => {
    const target = path.join(dir, "log.jsonl");
    const lockPath = `${target}.lock`;
    // Simulate a stuck (live) lock by manually creating the sentinel.
    closeSyncFd(openSync(lockPath, "wx", 0o600));
    // Stamp it as recent so it doesn't trigger the stale-lock path.
    writeFileSync(lockPath, ""); // mtime=now
    const start = Date.now();
    expect(() =>
      withFileLockSync(target, () => "never", {
        timeoutMs: 50,
        staleLockMs: 60_000,
      }),
    ).toThrow(/timed out/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow a bit of slack
    // Lock file we manually created is still there (our timeout doesn't
    // try to remove someone else's lock).
    expect(existsSync(lockPath)).toBe(true);
  });

  it("force-unlinks a stale lock and then acquires it", () => {
    const target = path.join(dir, "log.jsonl");
    const lockPath = `${target}.lock`;
    closeSyncFd(openSync(lockPath, "wx", 0o600));
    // Age the file artificially via utimesSync-equivalent. Easiest:
    // pass staleLockMs=0 so any existing lock is treated as stale.
    const result = withFileLockSync(target, () => "acquired", {
      staleLockMs: 0,
      timeoutMs: 1_000,
    });
    expect(result).toBe("acquired");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("serializes interleaved sync appends from the same process", () => {
    // Two synchronous callers under the same lock must produce a
    // well-formed JSONL file. (Cross-process interleaving is what the
    // helper actually defends against, but a sync test inside one
    // process is the closest deterministic exercise we can write.)
    const target = path.join(dir, "log.jsonl");
    for (let i = 0; i < 50; i++) {
      withFileLockSync(target, () => {
        appendFileSync(target, `${JSON.stringify({ i })}\n`, { mode: 0o600 });
      });
    }
    const raw = readFileSync(target, "utf-8").trim().split("\n");
    expect(raw).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      expect(JSON.parse(raw[i] ?? "")).toEqual({ i });
    }
  });
});

// Helper — tiny shim so we don't need to import closeSync into the
// top-level alongside openSync (keeps the imports list minimal).
function closeSyncFd(fd: number): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { closeSync } = require("node:fs") as typeof import("node:fs");
  closeSync(fd);
}
