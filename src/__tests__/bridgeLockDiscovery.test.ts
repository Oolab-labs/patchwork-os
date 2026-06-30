/**
 * Tests for `findAllLiveBridges()` — the multi-bridge fan-out helper
 * added in step 3 of issue #422 v2 to enable `patchwork kill-switch`
 * targeting every live bridge in a multi-workspace deployment.
 *
 * v2-B2 from the design review: ADR-0007 acknowledges "one bridge per
 * workspace" as the realistic deployment. A single-bridge kill-switch
 * would leave sibling bridges writing through the gate, defeating
 * emergency-stop semantics.
 *
 * Helper takes injection seams for `lockDir` + `isLive(pid)` so tests
 * can exercise the directory walk + liveness filter without touching
 * the real `~/.claude/ide` or real PIDs.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findAllLiveBridges, findBridgeLock } from "../bridgeLockDiscovery.js";

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
  dir = mkdtempSync(join(tmpdir(), "pw-lock-discovery-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findAllLiveBridges()", () => {
  it("returns [] when the lock dir does not exist", () => {
    rmSync(dir, { recursive: true, force: true });
    const all = findAllLiveBridges({
      lockDir: dir,
      isLive: () => true,
    });
    expect(all).toEqual([]);
  });

  it("returns [] when the lock dir is empty", () => {
    const all = findAllLiveBridges({
      lockDir: dir,
      isLive: () => true,
    });
    expect(all).toEqual([]);
  });

  it("returns one entry per live isBridge lock", () => {
    writeLock(3101, {
      pid: 1001,
      authToken: "tok-a",
      workspace: "/ws/a",
      isBridge: true,
    });
    writeLock(3102, {
      pid: 1002,
      authToken: "tok-b",
      workspace: "/ws/b",
      isBridge: true,
    });
    const all = findAllLiveBridges({
      lockDir: dir,
      isLive: () => true,
    });
    expect(all).toHaveLength(2);
    const ports = all.map((l) => l.port).sort();
    expect(ports).toEqual([3101, 3102]);
    const a = all.find((l) => l.port === 3101);
    expect(a).toBeDefined();
    expect(a?.authToken).toBe("tok-a");
    expect(a?.workspace).toBe("/ws/a");
  });

  it("filters out locks where isBridge is false (IDE-owned locks)", () => {
    writeLock(3101, {
      pid: 1001,
      authToken: "tok-a",
      isBridge: true,
    });
    writeLock(3102, {
      pid: 1002,
      authToken: "tok-b",
      isBridge: false, // IDE owns this lock; not a bridge
    });
    writeLock(3103, {
      pid: 1003,
      authToken: "tok-c",
      // missing isBridge — treat as not-a-bridge
    });
    const all = findAllLiveBridges({
      lockDir: dir,
      isLive: () => true,
    });
    expect(all.map((l) => l.port)).toEqual([3101]);
  });

  it("filters out locks for dead PIDs", () => {
    writeLock(3101, { pid: 1001, isBridge: true });
    writeLock(3102, { pid: 1002, isBridge: true });
    writeLock(3103, { pid: 1003, isBridge: true });
    // Only 1002 is "alive"
    const all = findAllLiveBridges({
      lockDir: dir,
      isLive: (pid) => pid === 1002,
    });
    expect(all.map((l) => l.port)).toEqual([3102]);
  });

  it("skips malformed JSON lock files without throwing", () => {
    writeLock(3101, { pid: 1001, isBridge: true });
    writeFileSync(join(dir, "3102.lock"), "not-valid-json");
    const all = findAllLiveBridges({
      lockDir: dir,
      isLive: () => true,
    });
    expect(all.map((l) => l.port)).toEqual([3101]);
  });

  it("skips files whose name is not <port>.lock", () => {
    writeLock(3101, { pid: 1001, isBridge: true });
    writeFileSync(join(dir, "not-a-lock.txt"), "{}");
    writeFileSync(join(dir, "lock"), "{}");
    const all = findAllLiveBridges({
      lockDir: dir,
      isLive: () => true,
    });
    expect(all.map((l) => l.port)).toEqual([3101]);
  });

  it("skips entries with missing PID", () => {
    writeLock(3101, { isBridge: true }); // no pid
    writeLock(3102, { pid: 1002, isBridge: true });
    const all = findAllLiveBridges({
      lockDir: dir,
      isLive: () => true,
    });
    expect(all.map((l) => l.port)).toEqual([3102]);
  });

  it("handles missing optional fields (authToken / workspace)", () => {
    writeLock(3101, { pid: 1001, isBridge: true });
    const all = findAllLiveBridges({
      lockDir: dir,
      isLive: () => true,
    });
    expect(all).toHaveLength(1);
    expect(all[0]?.authToken).toBe("");
    expect(all[0]?.workspace).toBe("");
  });
});

describe("findBridgeLock() — first-of-many (back-compat)", () => {
  it("returns the first live bridge from the multi-bridge set", () => {
    writeLock(3101, {
      pid: 1001,
      authToken: "tok-a",
      isBridge: true,
    });
    writeLock(3102, {
      pid: 1002,
      authToken: "tok-b",
      isBridge: true,
    });
    const first = findBridgeLock({
      lockDir: dir,
      isLive: () => true,
    });
    expect(first).not.toBeNull();
    // We don't assert a specific ordering — readdir order varies by FS.
    // Just confirm we got one of the two live bridges back.
    expect([3101, 3102]).toContain(first?.port);
  });

  it("returns null when there are no live bridges", () => {
    writeLock(3101, { pid: 1001, isBridge: false }); // not a bridge
    const first = findBridgeLock({
      lockDir: dir,
      isLive: () => true,
    });
    expect(first).toBeNull();
  });
});

describe("findBridgeLock() — workspace-aware selection (multi-bridge)", () => {
  it("prefers the bridge whose workspace contains the caller's cwd", () => {
    writeLock(3101, {
      pid: 1001,
      authToken: "tok-a",
      workspace: "/ws/a",
      isBridge: true,
    });
    writeLock(3102, {
      pid: 1002,
      authToken: "tok-b",
      workspace: "/ws/b",
      isBridge: true,
    });
    const pick = findBridgeLock({
      lockDir: dir,
      isLive: () => true,
      cwd: "/ws/b",
    });
    expect(pick?.port).toBe(3102);
    expect(pick?.authToken).toBe("tok-b");
  });

  it("matches a cwd nested under the workspace root (not just an exact match)", () => {
    writeLock(3101, { pid: 1001, workspace: "/ws/a", isBridge: true });
    writeLock(3102, { pid: 1002, workspace: "/ws/b", isBridge: true });
    const pick = findBridgeLock({
      lockDir: dir,
      isLive: () => true,
      cwd: "/ws/b/packages/api/src",
    });
    expect(pick?.port).toBe(3102);
  });

  it("does NOT match a sibling whose path merely shares a prefix string", () => {
    // "/ws/b-other" must not be considered a parent of "/ws/b".
    writeLock(3101, { pid: 1001, workspace: "/ws/b-other", isBridge: true });
    writeLock(3102, { pid: 1002, workspace: "/ws/b", isBridge: true });
    const pick = findBridgeLock({
      lockDir: dir,
      isLive: () => true,
      cwd: "/ws/b/src",
    });
    expect(pick?.port).toBe(3102);
  });

  it("falls back to a live bridge when no workspace contains the cwd", () => {
    writeLock(3101, { pid: 1001, workspace: "/ws/a", isBridge: true });
    writeLock(3102, { pid: 1002, workspace: "/ws/b", isBridge: true });
    const pick = findBridgeLock({
      lockDir: dir,
      isLive: () => true,
      cwd: "/somewhere/else",
    });
    // No match → first live bridge (order is FS-dependent; just assert one).
    expect([3101, 3102]).toContain(pick?.port);
  });

  it("ignores the cwd preference when only one bridge is live (byte-identical)", () => {
    writeLock(3101, { pid: 1001, workspace: "/ws/a", isBridge: true });
    const pick = findBridgeLock({
      lockDir: dir,
      isLive: () => true,
      cwd: "/totally/unrelated",
    });
    expect(pick?.port).toBe(3101);
  });
});
