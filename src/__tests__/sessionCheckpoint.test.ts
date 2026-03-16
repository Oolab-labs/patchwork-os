import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:os", () => ({ default: { homedir: () => "/home/user" } }));

import fs from "node:fs";
import {
  type CheckpointData,
  SessionCheckpoint,
} from "../sessionCheckpoint.js";

const mockFs = vi.mocked(fs);

const sampleData: CheckpointData = {
  port: 12345,
  savedAt: Date.now(),
  sessions: [
    {
      id: "abc",
      connectedAt: Date.now(),
      openedFiles: ["/a.ts"],
      terminalPrefix: "s1",
      inGrace: false,
    },
  ],
  extensionConnected: true,
  gracePeriodMs: 5000,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockFs.existsSync = vi.fn(() => true);
  mockFs.mkdirSync = vi.fn();
  mockFs.writeFileSync = vi.fn();
  mockFs.unlinkSync = vi.fn();
  mockFs.readdirSync = vi.fn(() => [] as any);
  mockFs.statSync = vi.fn(() => ({ mtimeMs: Date.now() }) as any);
  mockFs.readFileSync = vi.fn(() => JSON.stringify(sampleData));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionCheckpoint", () => {
  it("constructor derives checkpoint path from port", () => {
    const sc = new SessionCheckpoint(9999);
    sc.write(sampleData);
    const path = (mockFs.writeFileSync as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(path).toContain("checkpoint-9999.json");
  });

  it.skipIf(process.platform === "win32")(
    "constructor uses CLAUDE_CONFIG_DIR env var",
    () => {
      process.env.CLAUDE_CONFIG_DIR = "/custom/config";
      const sc = new SessionCheckpoint(1111);
      sc.write(sampleData);
      const path = (mockFs.writeFileSync as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as string;
      expect(path).toContain("/custom/config");
      process.env.CLAUDE_CONFIG_DIR = undefined as unknown as string;
    },
  );

  it("write() serializes data to JSON", () => {
    const sc = new SessionCheckpoint(1234);
    sc.write(sampleData);
    expect(mockFs.writeFileSync).toHaveBeenCalledOnce();
    const written = (mockFs.writeFileSync as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.port).toBe(12345);
    expect(parsed.sessions).toHaveLength(1);
  });

  it("write() creates dir if it does not exist", () => {
    mockFs.existsSync = vi.fn(() => false);
    const sc = new SessionCheckpoint(1234);
    sc.write(sampleData);
    expect(mockFs.mkdirSync).toHaveBeenCalled();
  });

  it("write() swallows errors silently", () => {
    mockFs.writeFileSync = vi.fn(() => {
      throw new Error("disk full");
    });
    const sc = new SessionCheckpoint(1234);
    expect(() => sc.write(sampleData)).not.toThrow();
  });

  it("delete() calls unlinkSync", () => {
    const sc = new SessionCheckpoint(1234);
    sc.delete();
    expect(mockFs.unlinkSync).toHaveBeenCalledOnce();
  });

  it("delete() swallows ENOENT silently", () => {
    mockFs.unlinkSync = vi.fn(() => {
      throw new Error("ENOENT");
    });
    const sc = new SessionCheckpoint(1234);
    expect(() => sc.delete()).not.toThrow();
  });

  it("start() writes immediately then on interval", () => {
    const sc = new SessionCheckpoint(1234);
    const getSnapshot = vi.fn(() => sampleData);
    sc.start(getSnapshot, 1000);
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(4);
    sc.stop();
  });

  it("stop() clears the interval and deletes checkpoint", () => {
    const sc = new SessionCheckpoint(1234);
    const getSnapshot = vi.fn(() => sampleData);
    sc.start(getSnapshot, 500);
    sc.stop();
    const countAfterStop = (mockFs.writeFileSync as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    vi.advanceTimersByTime(2000);
    expect(
      (mockFs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(countAfterStop);
    expect(mockFs.unlinkSync).toHaveBeenCalled();
  });
});

describe("SessionCheckpoint.loadLatest", () => {
  it("returns null when ide dir is empty", () => {
    mockFs.readdirSync = vi.fn(() => [] as any);
    expect(SessionCheckpoint.loadLatest()).toBeNull();
  });

  it("returns null when readdirSync throws", () => {
    mockFs.readdirSync = vi.fn(() => {
      throw new Error("ENOENT");
    });
    expect(SessionCheckpoint.loadLatest()).toBeNull();
  });

  it("returns null when no checkpoint files found", () => {
    mockFs.readdirSync = vi.fn(() => ["somefile.json", "other.txt"] as any);
    expect(SessionCheckpoint.loadLatest()).toBeNull();
  });

  it("returns checkpoint when fresh file exists", () => {
    const fresh = { ...sampleData, savedAt: Date.now() };
    mockFs.readdirSync = vi.fn(() => ["checkpoint-1234.json"] as any);
    mockFs.statSync = vi.fn(() => ({ mtimeMs: Date.now() }) as any);
    mockFs.readFileSync = vi.fn(() => JSON.stringify(fresh));
    const result = SessionCheckpoint.loadLatest();
    expect(result).not.toBeNull();
    expect(result?.port).toBe(12345);
  });

  it("returns null when checkpoint is stale (>maxAgeMs)", () => {
    const stale = { ...sampleData, savedAt: Date.now() - 10 * 60 * 1000 };
    mockFs.readdirSync = vi.fn(() => ["checkpoint-1234.json"] as any);
    mockFs.statSync = vi.fn(() => ({ mtimeMs: Date.now() }) as any);
    mockFs.readFileSync = vi.fn(() => JSON.stringify(stale));
    expect(SessionCheckpoint.loadLatest()).toBeNull();
  });

  it("picks the newest file when multiple checkpoints exist", () => {
    const older = { ...sampleData, port: 1111, savedAt: Date.now() };
    const newer = { ...sampleData, port: 2222, savedAt: Date.now() };
    mockFs.readdirSync = vi.fn(
      () => ["checkpoint-1111.json", "checkpoint-2222.json"] as any,
    );
    let callCount = 0;
    mockFs.statSync = vi.fn(() => {
      callCount++;
      return { mtimeMs: callCount === 1 ? 100 : 200 } as any;
    });
    mockFs.readFileSync = vi.fn(() => JSON.stringify(newer));
    const result = SessionCheckpoint.loadLatest();
    expect(result?.port).toBe(2222);
  });

  it("returns null when readFileSync throws for the newest file", () => {
    mockFs.readdirSync = vi.fn(() => ["checkpoint-1234.json"] as any);
    mockFs.statSync = vi.fn(() => ({ mtimeMs: Date.now() }) as any);
    mockFs.readFileSync = vi.fn(() => {
      throw new Error("permission denied");
    });
    expect(SessionCheckpoint.loadLatest()).toBeNull();
  });

  it("skips files where readFileSync throws", () => {
    mockFs.readdirSync = vi.fn(() => ["checkpoint-1234.json"] as any);
    mockFs.readFileSync = vi.fn(() => {
      throw new Error("ENOENT");
    });
    expect(SessionCheckpoint.loadLatest()).toBeNull();
  });
});
