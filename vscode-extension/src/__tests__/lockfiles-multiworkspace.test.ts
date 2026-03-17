/**
 * Tests for multi-workspace lockfile functions:
 * - readLockFileForWorkspace
 * - readAllMatchingLockFiles
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => {
  const mod = await import("./__mocks__/vscode");
  return mod;
});

vi.mock("fs/promises", () => ({
  access: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("../constants", () => ({
  LOCK_DIR: "/mock/lock/dir",
}));

import * as fsp from "node:fs/promises";
import * as vscode from "vscode";
import {
  readAllMatchingLockFiles,
  readLockFileForWorkspace,
} from "../lockfiles";

const NOW = 1_700_000_000_000;

function makeLockContent(
  workspace: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    authToken: "tok-abc",
    pid: 9999,
    workspace,
    startedAt: NOW - 60_000,
    isBridge: true,
    ...overrides,
  });
}

function setupLocks(
  locks: Array<{
    file: string;
    workspace: string;
    overrides?: Record<string, unknown>;
  }>,
): void {
  vi.mocked(fsp.readdir).mockResolvedValue(locks.map((l) => l.file) as any);
  vi.mocked(fsp.stat).mockResolvedValue({ mtimeMs: NOW } as any);
  vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
    const file = String(p).split("/").pop()!;
    const lock = locks.find((l) => l.file === file);
    if (!lock) throw new Error(`ENOENT: ${String(p)}`);
    return makeLockContent(lock.workspace, lock.overrides ?? {}) as any;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(process, "kill").mockImplementation(() => true as any);
  vi.mocked(fsp.access).mockResolvedValue(undefined as any);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── readLockFileForWorkspace ──────────────────────────────────────────────────

describe("readLockFileForWorkspace", () => {
  it("returns the lock file matching the specified workspace", async () => {
    setupLocks([
      { file: "10001.lock", workspace: "/project/a" },
      { file: "10002.lock", workspace: "/project/b" },
    ]);
    const result = await readLockFileForWorkspace("/project/b");
    expect(result).not.toBeNull();
    expect(result!.port).toBe(10002);
    expect(result!.workspace).toBe("/project/b");
  });

  it("returns null when no lock file matches", async () => {
    setupLocks([{ file: "10001.lock", workspace: "/project/a" }]);
    const result = await readLockFileForWorkspace("/project/unknown");
    expect(result).toBeNull();
  });

  it("resolves symlink-style paths correctly (both resolved)", async () => {
    setupLocks([{ file: "10001.lock", workspace: "/project/a" }]);
    // The function uses path.resolve() on both sides
    const result = await readLockFileForWorkspace("/project/./a");
    expect(result).not.toBeNull();
    expect(result!.port).toBe(10001);
  });

  it("skips expired lock files", async () => {
    setupLocks([
      {
        file: "10001.lock",
        workspace: "/project/a",
        overrides: { startedAt: NOW - 3 * 60 * 60 * 1000 }, // 3h ago
      },
    ]);
    const result = await readLockFileForWorkspace("/project/a");
    expect(result).toBeNull();
  });

  it("uses the provided lockDir override", async () => {
    vi.mocked(fsp.access).mockImplementation(async (p) => {
      if (String(p) !== "/custom/lock") throw new Error("ENOENT");
    });
    setupLocks([{ file: "10001.lock", workspace: "/project/a" }]);
    const result = await readLockFileForWorkspace("/project/a", "/custom/lock");
    // Access check passes for /custom/lock; file lookup succeeds
    expect(result).not.toBeNull();
  });
});

// ── readAllMatchingLockFiles ──────────────────────────────────────────────────

describe("readAllMatchingLockFiles", () => {
  it("returns one lock per workspace folder", async () => {
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/project/a" } },
      { uri: { fsPath: "/project/b" } },
    ];
    setupLocks([
      { file: "10001.lock", workspace: "/project/a" },
      { file: "10002.lock", workspace: "/project/b" },
    ]);
    const results = await readAllMatchingLockFiles();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.port).sort()).toEqual([10001, 10002]);
  });

  it("omits workspace folders with no matching bridge", async () => {
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/project/a" } },
      { uri: { fsPath: "/project/c" } }, // no bridge
    ];
    setupLocks([{ file: "10001.lock", workspace: "/project/a" }]);
    const results = await readAllMatchingLockFiles();
    expect(results).toHaveLength(1);
    expect(results[0].port).toBe(10001);
  });

  it("deduplicates: same port appears only once even if matched by two folders", async () => {
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/project/a" } },
      { uri: { fsPath: "/project/a" } }, // duplicate
    ];
    setupLocks([{ file: "10001.lock", workspace: "/project/a" }]);
    const results = await readAllMatchingLockFiles();
    expect(results).toHaveLength(1);
  });

  it("returns the newest available lock when no workspace folders are open", async () => {
    (vscode.workspace as any).workspaceFolders = undefined;
    setupLocks([{ file: "10001.lock", workspace: "/some/ws" }]);
    const results = await readAllMatchingLockFiles();
    expect(results).toHaveLength(1);
    expect(results[0].port).toBe(10001);
  });

  it("returns empty array when no workspace folders and no lock files", async () => {
    (vscode.workspace as any).workspaceFolders = [];
    vi.mocked(fsp.readdir).mockResolvedValue([] as any);
    const results = await readAllMatchingLockFiles();
    expect(results).toHaveLength(0);
  });
});
