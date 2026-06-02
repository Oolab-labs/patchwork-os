/**
 * Tests for `findBridgeLockForTask()` — the lock-selection primitive behind
 * `quick-task` / `start-task` / `continue-handoff`.
 *
 * Regression guard: the original `findLock()` in task.ts picked the most
 * recently MODIFIED `~/.claude/ide/*.lock` with NO `isBridge:true` filter and
 * NO PID-liveness check. That meant it could select an IDE-owned lock or a
 * dead bridge and POST a Bearer token to the wrong port. These tests pin the
 * fixed behaviour: only `isBridge:true` + live-PID locks are selectable, and
 * an explicit `--port` override is verified the same way.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findBridgeLockForTask } from "../task.js";

let dir: string;

function writeLock(
  port: number,
  body: {
    pid?: number;
    authToken?: string;
    workspace?: string;
    isBridge?: boolean;
  },
): void {
  writeFileSync(join(dir, `${port}.lock`), JSON.stringify(body));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pw-task-findlock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findBridgeLockForTask() — auto-discovery", () => {
  it("selects an isBridge + live lock", () => {
    writeLock(4100, {
      pid: 5100,
      authToken: "tok-bridge",
      isBridge: true,
    });
    const lock = findBridgeLockForTask(undefined, {
      lockDir: dir,
      isLive: () => true,
    });
    expect(lock).toEqual({ port: 4100, authToken: "tok-bridge" });
  });

  it("ignores an IDE-owned (non-isBridge) lock even if it is newest", () => {
    // A live bridge plus a newer IDE-owned lock — the old findLock would
    // have picked the IDE lock by mtime. The fixed primitive must not.
    writeLock(4100, {
      pid: 5100,
      authToken: "tok-bridge",
      isBridge: true,
    });
    writeLock(4200, {
      pid: 5200,
      authToken: "tok-ide", // IDE-owned: must never be selected
      isBridge: false,
    });
    const lock = findBridgeLockForTask(undefined, {
      lockDir: dir,
      isLive: () => true,
    });
    expect(lock?.port).toBe(4100);
    expect(lock?.authToken).toBe("tok-bridge");
  });

  it("ignores a dead-PID bridge lock", () => {
    writeLock(4100, {
      pid: 5100,
      authToken: "tok-dead",
      isBridge: true,
    });
    writeLock(4200, {
      pid: 5200,
      authToken: "tok-live",
      isBridge: true,
    });
    const lock = findBridgeLockForTask(undefined, {
      lockDir: dir,
      isLive: (pid) => pid === 5200, // only 4200's bridge is alive
    });
    expect(lock?.port).toBe(4200);
    expect(lock?.authToken).toBe("tok-live");
  });

  it("returns null when only IDE-owned or dead locks exist", () => {
    writeLock(4100, { pid: 5100, authToken: "tok", isBridge: false });
    writeLock(4200, { pid: 5200, authToken: "tok", isBridge: true });
    const lock = findBridgeLockForTask(undefined, {
      lockDir: dir,
      isLive: () => false, // bridge PID is dead
    });
    expect(lock).toBeNull();
  });
});

describe("findBridgeLockForTask() — explicit --port override", () => {
  it("returns the lock for the given port when it is a live bridge", () => {
    writeLock(4300, {
      pid: 5300,
      authToken: "tok-port",
      isBridge: true,
    });
    const lock = findBridgeLockForTask(4300, {
      lockDir: dir,
      isLive: () => true,
    });
    expect(lock).toEqual({ port: 4300, authToken: "tok-port" });
  });

  it("returns null for a --port that points at an IDE-owned lock", () => {
    writeLock(4300, {
      pid: 5300,
      authToken: "tok-ide",
      isBridge: false, // not a bridge
    });
    const lock = findBridgeLockForTask(4300, {
      lockDir: dir,
      isLive: () => true,
    });
    expect(lock).toBeNull();
  });

  it("returns null for a --port whose bridge PID is dead", () => {
    writeLock(4300, {
      pid: 5300,
      authToken: "tok",
      isBridge: true,
    });
    const lock = findBridgeLockForTask(4300, {
      lockDir: dir,
      isLive: () => false,
    });
    expect(lock).toBeNull();
  });

  it("returns null for a --port with no lock file", () => {
    const lock = findBridgeLockForTask(9999, {
      lockDir: dir,
      isLive: () => true,
    });
    expect(lock).toBeNull();
  });
});
