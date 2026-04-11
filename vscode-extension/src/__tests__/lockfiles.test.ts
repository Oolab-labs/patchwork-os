import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock vscode before importing lockfiles
vi.mock("vscode", async () => {
  const mod = await import("./__mocks__/vscode");
  return mod;
});

// Mock fs/promises
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

// Mock constants
vi.mock("../constants", () => ({
  LOCK_DIR: "/mock/lock/dir",
}));

import * as fsp from "node:fs/promises";
import * as vscode from "vscode";
import { readLockFilesAsync } from "../lockfiles";

const NOW = 1_700_000_000_000; // fixed "now" in ms

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(process, "kill").mockImplementation(() => true as any);
  vi.mocked(fsp.access).mockResolvedValue(undefined as any);
  vi.mocked(fsp.readdir).mockResolvedValue(["12345.lock"] as any);
  vi.mocked(fsp.stat).mockResolvedValue({ mtimeMs: NOW } as any);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeLockContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    authToken: "tok-abc",
    pid: 9999,
    workspace: "/some/workspace",
    startedAt: NOW - 60_000, // 1 minute ago — valid by default
    isBridge: true,
    ...overrides,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("readLockFilesAsync — PID reuse guards", () => {
  it("accepts a valid lock file with recent startedAt", async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(makeLockContent() as any);
    const result = await readLockFilesAsync();
    expect(result).not.toBeNull();
    expect(result?.port).toBe(12345);
    expect(result?.authToken).toBe("tok-abc");
  });

  it("rejects a lock file with no startedAt field (should not skip the guard)", async () => {
    // Without startedAt the old code skips the age check entirely — this test
    // asserts the NEW behaviour: missing startedAt means the lock is invalid.
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ startedAt: undefined }) as any,
    );
    const result = await readLockFilesAsync();
    expect(result).toBeNull();
  });

  it("accepts a lock file whose startedAt is 3 hours ago (within the 24-hour window)", async () => {
    // The age filter was changed from 2h → 24h so that long-running bridges
    // are not incorrectly dropped by the extension after 2 hours of uptime.
    const threeHoursAgo = 3 * 60 * 60 * 1000;
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ startedAt: NOW - threeHoursAgo }) as any,
    );
    const result = await readLockFilesAsync();
    expect(result).not.toBeNull();
  });

  it("accepts a lock file whose startedAt is just under 24 hours ago", async () => {
    const justUnder24h = 24 * 60 * 60 * 1000 - 5_000;
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ startedAt: NOW - justUnder24h }) as any,
    );
    const result = await readLockFilesAsync();
    expect(result).not.toBeNull();
  });

  it("rejects a lock file whose startedAt is more than 24 hours ago (PID reuse guard)", async () => {
    const twentyFiveHoursAgo = 25 * 60 * 60 * 1000;
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ startedAt: NOW - twentyFiveHoursAgo }) as any,
    );
    // process.kill returns true — simulating a reused PID
    const result = await readLockFilesAsync();
    expect(result).toBeNull();
  });
});

// ── Multi-bridge warning + optional-chaining fix ──────────────────────────────

describe("readLockFilesAsync — multiple bridges", () => {
  it("returns the first valid candidate when multiple lock files exist", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      "11111.lock",
      "22222.lock",
    ] as any);
    vi.mocked(fsp.stat).mockResolvedValue({ mtimeMs: NOW } as any);
    vi.mocked(fsp.readFile).mockImplementation(async (p) => {
      if (String(p).includes("11111"))
        return makeLockContent({ authToken: "first-tok" }) as any;
      return makeLockContent({ authToken: "second-tok" }) as any;
    });
    // Both workspace fields match current workspace ("/some/workspace" set in mock)
    const result = await readLockFilesAsync();
    expect(result).not.toBeNull();
    // Must not throw — the ?. guard prevents crashing when candidates[0] exists
    expect(result?.port).toBe(11111);
    expect(result?.authToken).toBe("first-tok");
  });

  it("shows a warning message listing both ports when two bridges are found", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      "33333.lock",
      "44444.lock",
    ] as any);
    vi.mocked(fsp.stat).mockResolvedValue({ mtimeMs: NOW } as any);
    vi.mocked(fsp.readFile).mockImplementation(async (p) => {
      if (String(p).includes("33333"))
        return makeLockContent({ authToken: "tok-a" }) as any;
      return makeLockContent({ authToken: "tok-b" }) as any;
    });
    const warnSpy = vi.spyOn(vscode.window, "showWarningMessage");
    await readLockFilesAsync();
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain("33333");
    expect(msg).toContain("44444");
    expect(msg).toContain("Multiple bridge instances");
  });

  it("does NOT show a warning when exactly one bridge is found", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue(["55555.lock"] as any);
    vi.mocked(fsp.stat).mockResolvedValue({ mtimeMs: NOW } as any);
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ authToken: "solo-tok" }) as any,
    );
    const warnSpy = vi.spyOn(vscode.window, "showWarningMessage");
    await readLockFilesAsync();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("the warning message includes candidates[0]?.port safely (no throw even if entry is borderline)", async () => {
    // This guards the ?.port optional-chain fix: if for any reason the first
    // candidate were undefined, the old candidates[0]!.port would throw.
    // We test that the call completes and the warning port is present in the message.
    vi.mocked(fsp.readdir).mockResolvedValue([
      "66666.lock",
      "77777.lock",
    ] as any);
    vi.mocked(fsp.stat).mockResolvedValue({ mtimeMs: NOW } as any);
    vi.mocked(fsp.readFile).mockImplementation(async (p) => {
      if (String(p).includes("66666"))
        return makeLockContent({ authToken: "tok-c" }) as any;
      return makeLockContent({ authToken: "tok-d" }) as any;
    });
    const warnSpy = vi.spyOn(vscode.window, "showWarningMessage");
    // Must not throw
    await expect(readLockFilesAsync()).resolves.not.toThrow();
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("66666");
  });
});
