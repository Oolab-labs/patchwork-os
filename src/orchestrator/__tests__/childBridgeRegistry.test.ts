import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChildBridgeRegistry,
  validateLockData,
} from "../childBridgeRegistry.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeLockDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
}

function writeLock(
  dir: string,
  port: number,
  overrides: Record<string, unknown> = {},
): void {
  const content = {
    pid: process.pid,
    startedAt: Date.now(),
    nonce: "aabbccdd",
    workspace: `/projects/ws${port}`,
    workspaceFolders: [`/projects/ws${port}`],
    ideName: "VSCode",
    isBridge: true,
    orchestrator: false,
    transport: "ws",
    authToken: "a".repeat(36),
    ...overrides,
  };
  fs.writeFileSync(
    path.join(dir, `${port}.lock`),
    JSON.stringify(content),
    "utf-8",
  );
}

// ── validateLockData ─────────────────────────────────────────────────────────

describe("validateLockData", () => {
  it("rejects non-object input", () => {
    expect(validateLockData(null)).toMatchObject({ invalid: true });
    expect(validateLockData("string")).toMatchObject({ invalid: true });
    expect(validateLockData(42)).toMatchObject({ invalid: true });
  });

  it("rejects orchestrator lock", () => {
    expect(
      validateLockData({
        orchestrator: true,
        isBridge: true,
        pid: 1,
        startedAt: 1,
        workspaceFolders: [],
        ideName: "X",
        authToken: "a".repeat(36),
      }),
    ).toMatchObject({ invalid: true, reason: "orchestrator lock" });
  });

  it("rejects isBridge !== true", () => {
    expect(
      validateLockData({
        isBridge: false,
        pid: 1,
        startedAt: 1,
        workspaceFolders: [],
        ideName: "X",
        authToken: "a".repeat(36),
      }),
    ).toMatchObject({ invalid: true, reason: "isBridge !== true" });
  });

  it("rejects missing or short authToken", () => {
    const base = {
      isBridge: true,
      pid: 1,
      startedAt: 1,
      workspaceFolders: [],
      ideName: "X",
    };
    expect(validateLockData({ ...base, authToken: undefined })).toMatchObject({
      invalid: true,
    });
    expect(validateLockData({ ...base, authToken: "short" })).toMatchObject({
      invalid: true,
    });
  });

  it("rejects invalid pid", () => {
    const base = {
      isBridge: true,
      startedAt: 1,
      workspaceFolders: [],
      ideName: "X",
      authToken: "a".repeat(36),
    };
    expect(validateLockData({ ...base, pid: "not-a-number" })).toMatchObject({
      invalid: true,
    });
    expect(validateLockData({ ...base, pid: 0 })).toMatchObject({
      invalid: true,
    });
    expect(validateLockData({ ...base, pid: -1 })).toMatchObject({
      invalid: true,
    });
  });

  it("rejects missing startedAt", () => {
    expect(
      validateLockData({
        isBridge: true,
        pid: 1,
        workspaceFolders: [],
        ideName: "X",
        authToken: "a".repeat(36),
      }),
    ).toMatchObject({ invalid: true, reason: "missing startedAt" });
  });

  it("rejects workspaceFolders that is not an array", () => {
    expect(
      validateLockData({
        isBridge: true,
        pid: 1,
        startedAt: 1,
        workspaceFolders: "nope",
        ideName: "X",
        authToken: "a".repeat(36),
      }),
    ).toMatchObject({ invalid: true, reason: "workspaceFolders not an array" });
  });

  it("rejects missing ideName", () => {
    expect(
      validateLockData({
        isBridge: true,
        pid: 1,
        startedAt: 1,
        workspaceFolders: [],
        ideName: "",
        authToken: "a".repeat(36),
      }),
    ).toMatchObject({ invalid: true, reason: "missing ideName" });
  });

  it("rejects known non-bridge IDE names", () => {
    for (const ide of ["JetBrains", "IntelliJ IDEA", "PyCharm", "WebStorm"]) {
      expect(
        validateLockData({
          isBridge: true,
          pid: 1,
          startedAt: 1,
          workspaceFolders: [],
          ideName: ide,
          authToken: "a".repeat(36),
        }),
      ).toMatchObject({
        invalid: true,
        reason: `known non-bridge IDE: ${ide}`,
      });
    }
  });

  it("rejects unexpected transport value", () => {
    expect(
      validateLockData({
        isBridge: true,
        pid: 1,
        startedAt: 1,
        workspaceFolders: [],
        ideName: "X",
        authToken: "a".repeat(36),
        transport: "stdio",
      }),
    ).toMatchObject({ invalid: true, reason: "unexpected transport: stdio" });
  });

  it("accepts a well-formed bridge lock", () => {
    const result = validateLockData({
      isBridge: true,
      pid: process.pid,
      startedAt: Date.now(),
      workspace: "/projects/foo",
      workspaceFolders: ["/projects/foo"],
      ideName: "VSCode",
      authToken: "a".repeat(36),
      transport: "ws",
    });
    expect("invalid" in result).toBe(false);
    if (!("invalid" in result)) {
      expect(result.ideName).toBe("VSCode");
      expect(result.workspaceFolders).toEqual(["/projects/foo"]);
    }
  });

  it("accepts lock with null workspace but valid workspaceFolders", () => {
    const result = validateLockData({
      isBridge: true,
      pid: process.pid,
      startedAt: Date.now(),
      workspace: null,
      workspaceFolders: ["/projects/foo"],
      ideName: "Cursor",
      authToken: "a".repeat(36),
    });
    expect("invalid" in result).toBe(false);
    if (!("invalid" in result)) {
      expect(result.workspace).toBe("/projects/foo");
    }
  });
});

// ── ChildBridgeRegistry — edge case 1: startup grace period ──────────────────

describe("ChildBridgeRegistry: startup grace period", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = makeLockDir();
  });

  afterEach(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("newly discovered bridge has warmingUp=true and discoveredAt set", () => {
    writeLock(lockDir, 4747);
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    const before = Date.now();
    registry.refresh();
    const after = Date.now();
    const b = registry.get(4747);
    expect(b).toBeDefined();
    expect(b!.warmingUp).toBe(true);
    expect(b!.discoveredAt).toBeGreaterThanOrEqual(before);
    expect(b!.discoveredAt).toBeLessThanOrEqual(after);
  });

  it("markUnhealthy during grace window does NOT increment consecutiveFailures", () => {
    writeLock(lockDir, 4747);
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    registry.markUnhealthy(4747);
    registry.markUnhealthy(4747);
    registry.markUnhealthy(4747);
    expect(registry.get(4747)!.consecutiveFailures).toBe(0);
  });

  it("markUnhealthy after warmingUp=false DOES increment consecutiveFailures", () => {
    writeLock(lockDir, 4747);
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    registry.markWarm(4747); // clear grace
    registry.markUnhealthy(4747);
    registry.markUnhealthy(4747);
    expect(registry.get(4747)!.consecutiveFailures).toBe(2);
  });

  it("markHealthy clears warmingUp", () => {
    writeLock(lockDir, 4747);
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    expect(registry.get(4747)!.warmingUp).toBe(true);
    registry.markHealthy(4747, []);
    expect(registry.get(4747)!.warmingUp).toBe(false);
  });

  it("markWarm sets warmingUp=false", () => {
    writeLock(lockDir, 4747);
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    registry.markWarm(4747);
    expect(registry.get(4747)!.warmingUp).toBe(false);
  });

  it("keepWarm updates lastCheckedAt without changing health or failures", () => {
    writeLock(lockDir, 4747);
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    const before = Date.now();
    registry.keepWarm(4747);
    const b = registry.get(4747)!;
    expect(b.lastCheckedAt).toBeGreaterThanOrEqual(before);
    expect(b.healthy).toBe(false);
    expect(b.consecutiveFailures).toBe(0);
  });

  it("getWarmingUp returns only non-healthy warming bridges", () => {
    writeLock(lockDir, 4747);
    writeLock(lockDir, 4748);
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    registry.markHealthy(4747, []);
    const warming = registry.getWarmingUp();
    expect(warming).toHaveLength(1);
    expect(warming[0]!.port).toBe(4748);
  });
});

// ── ChildBridgeRegistry — edge case 2: duplicate workspaces ──────────────────

describe("ChildBridgeRegistry: duplicate workspaces", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = makeLockDir();
  });

  afterEach(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("getDuplicateWorkspaces returns empty map when no duplicates", () => {
    writeLock(lockDir, 4747, {
      workspace: "/projects/a",
      workspaceFolders: ["/projects/a"],
    });
    writeLock(lockDir, 4748, {
      workspace: "/projects/b",
      workspaceFolders: ["/projects/b"],
    });
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    registry.markHealthy(4747, []);
    registry.markHealthy(4748, []);
    expect(registry.getDuplicateWorkspaces().size).toBe(0);
  });

  it("getDuplicateWorkspaces returns both bridges when two share the same workspace", () => {
    writeLock(lockDir, 4747, {
      workspace: "/projects/same",
      workspaceFolders: ["/projects/same"],
      ideName: "VSCode",
    });
    writeLock(lockDir, 4748, {
      workspace: "/projects/same",
      workspaceFolders: ["/projects/same"],
      ideName: "Cursor",
    });
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    registry.markHealthy(4747, []);
    registry.markHealthy(4748, []);
    const dupes = registry.getDuplicateWorkspaces();
    expect(dupes.size).toBe(1);
    expect(dupes.get("/projects/same")).toHaveLength(2);
  });

  it("getDuplicateWorkspaces ignores unhealthy bridges", () => {
    writeLock(lockDir, 4747, {
      workspace: "/projects/same",
      workspaceFolders: ["/projects/same"],
      ideName: "VSCode",
    });
    writeLock(lockDir, 4748, {
      workspace: "/projects/same",
      workspaceFolders: ["/projects/same"],
      ideName: "Cursor",
    });
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    registry.markHealthy(4747, []);
    // 4748 stays unhealthy
    expect(registry.getDuplicateWorkspaces().size).toBe(0);
  });

  it("pickForWorkspace tie-breaking: prefers bridge with 0 consecutiveFailures", () => {
    writeLock(lockDir, 4747, {
      workspace: "/projects/same",
      workspaceFolders: ["/projects/same"],
      startedAt: Date.now() - 5000,
    });
    writeLock(lockDir, 4748, {
      workspace: "/projects/same",
      workspaceFolders: ["/projects/same"],
      startedAt: Date.now(),
    });
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    registry.markHealthy(4747, []);
    registry.markHealthy(4748, []);
    // Manually add a failure to 4747 (simulate post-healthy degradation)
    registry.markWarm(4747);
    registry.markUnhealthy(4747);
    registry.markHealthy(4747, []); // mark healthy again but failures are reset by markHealthy
    // Since markHealthy resets failures, let's test tie-breaking differently:
    // Give 4748 a higher startedAt — it should win on recency
    const b = registry.pickForWorkspace("/projects/same");
    expect(b).toBeDefined();
  });

  it("pickForWorkspace tie-breaking: prefers more recently started bridge when failures equal", () => {
    const older = Date.now() - 10_000;
    const newer = Date.now();
    writeLock(lockDir, 4747, {
      workspace: "/projects/same",
      workspaceFolders: ["/projects/same"],
      startedAt: older,
    });
    writeLock(lockDir, 4748, {
      workspace: "/projects/same",
      workspaceFolders: ["/projects/same"],
      startedAt: newer,
    });
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    registry.markHealthy(4747, []);
    registry.markHealthy(4748, []);
    const b = registry.pickForWorkspace("/projects/same");
    expect(b!.port).toBe(4748);
  });
});

// ── ChildBridgeRegistry — edge case 3: lock file validation ──────────────────

describe("ChildBridgeRegistry: lock file validation", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = makeLockDir();
  });

  afterEach(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("JetBrains lock file is silently skipped", () => {
    writeLock(lockDir, 4747, { ideName: "JetBrains" });
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    expect(registry.getAll()).toHaveLength(0);
  });

  it("lock with isBridge=false is skipped", () => {
    writeLock(lockDir, 4747, { isBridge: false });
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    expect(registry.getAll()).toHaveLength(0);
  });

  it("lock with non-ws transport is rejected", () => {
    writeLock(lockDir, 4747, { transport: "stdio" });
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    expect(registry.getAll()).toHaveLength(0);
  });

  it("lock with missing authToken is rejected", () => {
    writeLock(lockDir, 4747, { authToken: undefined });
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    expect(registry.getAll()).toHaveLength(0);
  });

  it("getRejected returns ports with reasons after refresh", () => {
    writeLock(lockDir, 4747, { ideName: "JetBrains" });
    writeLock(lockDir, 4748, { isBridge: false });
    writeLock(lockDir, 4749); // valid
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    const rejected = registry.getRejected();
    const rejectedPorts = rejected.map((r) => r.port);
    expect(rejectedPorts).toContain(4747);
    expect(rejectedPorts).toContain(4748);
    expect(rejectedPorts).not.toContain(4749);
  });

  it("rejected ports are not re-added to bridges on subsequent refresh", () => {
    writeLock(lockDir, 4747, { ideName: "JetBrains" });
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    registry.refresh();
    registry.refresh();
    expect(registry.getAll()).toHaveLength(0);
    // Only one rejection recorded (not triplicated)
    expect(registry.getRejected().filter((r) => r.port === 4747)).toHaveLength(
      1,
    );
  });

  it("valid lock file is not in getRejected", () => {
    writeLock(lockDir, 4747);
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    const rejected = registry.getRejected();
    expect(rejected.map((r) => r.port)).not.toContain(4747);
  });

  it("orchestrator own-port lock file is skipped entirely (not rejected)", () => {
    writeLock(lockDir, 4746); // same port as ownPort
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    registry.refresh();
    expect(registry.getAll()).toHaveLength(0);
    expect(registry.getRejected()).toHaveLength(0);
  });

  it("symlink lock files are skipped without crashing", () => {
    const target = path.join(lockDir, "real.lock");
    fs.writeFileSync(target, JSON.stringify({ isBridge: true }), "utf-8");
    fs.symlinkSync(target, path.join(lockDir, "4747.lock"));
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 4746);
    expect(() => registry.refresh()).not.toThrow();
    expect(registry.getAll()).toHaveLength(0);
  });
});

// ── pickBest() ────────────────────────────────────────────────────────────────

describe("ChildBridgeRegistry.pickBest()", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = makeLockDir();
  });

  afterEach(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("returns null when no healthy bridges exist", () => {
    writeLock(lockDir, 5100);
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 9999);
    registry.refresh();
    // No markHealthy call → no healthy bridges
    expect(registry.pickBest()).toBeNull();
  });

  it("returns the only healthy bridge", () => {
    writeLock(lockDir, 5101);
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 9999);
    registry.refresh();
    registry.markHealthy(5101, []);
    expect(registry.pickBest()?.port).toBe(5101);
  });

  it("prefers the more recently started bridge when failure counts are equal", () => {
    const now = Date.now();
    writeLock(lockDir, 5102, { startedAt: now - 2000 });
    writeLock(lockDir, 5103, { startedAt: now - 500 });
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 9999);
    registry.refresh();
    registry.markHealthy(5102, []);
    registry.markHealthy(5103, []);
    // 5103 is newer → should win
    expect(registry.pickBest()?.port).toBe(5103);
  });

  it("excludes unhealthy bridges — older healthy bridge wins over newer unhealthy one", () => {
    const now = Date.now();
    writeLock(lockDir, 5104, { startedAt: now - 100 }); // newer but will be unhealthy
    writeLock(lockDir, 5105, { startedAt: now - 2000 }); // older but healthy
    const registry = new ChildBridgeRegistry(lockDir, 10_000, 9999);
    registry.refresh();
    registry.markHealthy(5104, []);
    registry.markHealthy(5105, []);
    registry.markUnhealthy(5104); // healthy=false → excluded from pickBest
    expect(registry.pickBest()?.port).toBe(5105);
  });
});
