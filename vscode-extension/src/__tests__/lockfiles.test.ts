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

  it("rejects a lock file whose startedAt is more than 2 hours ago even if PID is alive (PID reuse)", async () => {
    const twoHoursAndOneMinute = 2 * 60 * 60 * 1000 + 60_000;
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ startedAt: NOW - twoHoursAndOneMinute }) as any,
    );
    // process.kill returns true — simulating a reused PID
    const result = await readLockFilesAsync();
    expect(result).toBeNull();
  });

  it("accepts a lock file whose startedAt is just under 2 hours ago", async () => {
    const justUnder2h = 2 * 60 * 60 * 1000 - 5_000;
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ startedAt: NOW - justUnder2h }) as any,
    );
    const result = await readLockFilesAsync();
    expect(result).not.toBeNull();
  });

  it("rejects a lock file whose startedAt is exactly 24 hours ago (old threshold should no longer pass)", async () => {
    const exactly24h = 24 * 60 * 60 * 1000;
    vi.mocked(fsp.readFile).mockResolvedValue(
      makeLockContent({ startedAt: NOW - exactly24h }) as any,
    );
    const result = await readLockFilesAsync();
    // With the old 24h window this would have been accepted; with the new 2h
    // window it must be rejected.
    expect(result).toBeNull();
  });
});
