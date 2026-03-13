import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");

import fs from "node:fs";
import { ActivityLog } from "../activityLog.js";

const mockFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.existsSync = vi.fn(() => true);
  mockFs.mkdirSync = vi.fn();
  mockFs.appendFileSync = vi.fn();
  mockFs.writeFileSync = vi.fn();
  mockFs.readFileSync = vi.fn(() => "");
  mockFs.statSync = vi.fn(() => ({ size: 0 }) as any);
});

describe("ActivityLog", () => {
  it("records and queries entries", () => {
    const log = new ActivityLog();
    log.record("openFile", 10, "success");
    log.record("runCommand", 200, "error", "Command failed");

    const all = log.query();
    expect(all).toHaveLength(2);
    expect(all.at(0)?.tool).toBe("openFile");
    expect(all.at(1)?.tool).toBe("runCommand");
    expect(all.at(1)?.errorMessage).toBe("Command failed");
  });

  it("filters by tool name", () => {
    const log = new ActivityLog();
    log.record("openFile", 10, "success");
    log.record("runCommand", 200, "success");
    log.record("openFile", 15, "success");

    const results = log.query({ tool: "openFile" });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.tool === "openFile")).toBe(true);
  });

  it("filters by status", () => {
    const log = new ActivityLog();
    log.record("a", 10, "success");
    log.record("b", 20, "error", "fail");
    log.record("c", 30, "success");

    const errors = log.query({ status: "error" });
    expect(errors).toHaveLength(1);
    expect(errors.at(0)?.tool).toBe("b");
  });

  it("respects last parameter", () => {
    const log = new ActivityLog();
    for (let i = 0; i < 10; i++) {
      log.record(`tool${i}`, i, "success");
    }
    const results = log.query({ last: 3 });
    expect(results).toHaveLength(3);
    expect(results.at(0)?.tool).toBe("tool7");
  });

  it("caps last at 200", () => {
    const log = new ActivityLog();
    for (let i = 0; i < 250; i++) {
      log.record("t", 1, "success");
    }
    const results = log.query({ last: 500 });
    expect(results.length).toBeLessThanOrEqual(200);
  });

  it("computes stats correctly", () => {
    const log = new ActivityLog();
    log.record("openFile", 10, "success");
    log.record("openFile", 20, "success");
    log.record("openFile", 30, "error", "fail");
    log.record("runCommand", 100, "success");

    const stats = log.stats();
    expect(stats.openFile?.count).toBe(3);
    expect(stats.openFile?.avgDurationMs).toBe(20);
    expect(stats.openFile?.errors).toBe(1);
    expect(stats.runCommand?.count).toBe(1);
    expect(stats.runCommand?.errors).toBe(0);
  });

  it("performs batch eviction at 120% capacity", () => {
    const log = new ActivityLog(10); // maxEntries = 10
    // Add 12 entries (120%) — should not trigger eviction yet
    for (let i = 0; i < 12; i++) {
      log.record(`tool${i}`, 1, "success");
    }
    // Add one more to push over 120%
    log.record("toolTrigger", 1, "success");
    // After eviction, should have maxEntries (10) entries
    const all = log.query({ last: 200 });
    expect(all.length).toBe(10);
    // The oldest entries should have been dropped
    expect(all.at(0)?.tool).not.toBe("tool0");
  });

  it("assigns sequential ids", () => {
    const log = new ActivityLog();
    log.record("a", 1, "success");
    log.record("b", 1, "success");
    log.record("c", 1, "success");
    const all = log.query();
    expect(all.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("toPrometheus emits counters and gauges", () => {
    const log = new ActivityLog();
    log.record("openFile", 10, "success");
    log.record("openFile", 20, "success");
    log.record("openFile", 30, "error", "fail");
    log.record("runCommand", 100, "success");

    const output = log.toPrometheus();

    // Counter lines for openFile
    expect(output).toContain(
      'bridge_tool_calls_total{tool="openFile",status="success"} 2',
    );
    expect(output).toContain(
      'bridge_tool_calls_total{tool="openFile",status="error"} 1',
    );
    // Counter lines for runCommand
    expect(output).toContain(
      'bridge_tool_calls_total{tool="runCommand",status="success"} 1',
    );
    expect(output).toContain(
      'bridge_tool_calls_total{tool="runCommand",status="error"} 0',
    );
    // Gauge lines
    expect(output).toContain('bridge_tool_duration_ms_avg{tool="openFile"} 20');
    // Uptime gauge present
    expect(output).toMatch(/bridge_uptime_seconds \d+/);
    // Correct HELP/TYPE headers
    expect(output).toContain("# HELP bridge_tool_calls_total");
    expect(output).toContain("# TYPE bridge_tool_calls_total counter");
    expect(output).toContain("# TYPE bridge_tool_duration_ms_avg gauge");
    // Ends with newline (Prometheus format requirement)
    expect(output.endsWith("\n")).toBe(true);
  });

  it("toPrometheus returns empty metrics when no entries", () => {
    const log = new ActivityLog();
    const output = log.toPrometheus();
    // Headers still present, no data lines
    expect(output).toContain("# HELP bridge_tool_calls_total");
    expect(output).not.toContain('tool="');
    expect(output).toContain("bridge_uptime_seconds");
  });

  it("toPrometheus escapes double quotes in tool names", () => {
    const log = new ActivityLog();
    log.record('tool"with"quotes', 10, "success");
    const output = log.toPrometheus();
    // Prometheus label values escape " as \"
    expect(output).toContain('tool="tool\\"with\\"quotes"');
  });
});

describe("ActivityLog — disk persistence", () => {
  it("appends entry to disk when persistPath is set", () => {
    const log = new ActivityLog();
    log.setPersistPath("/tmp/activity.jsonl");
    log.record("read", 10, "success");
    expect(mockFs.appendFileSync).toHaveBeenCalled();
    const written = (
      mockFs.appendFileSync as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[1] as string;
    expect(written).toContain('"kind":"tool"');
    expect(written).toContain('"tool":"read"');
  });

  it("creates directory when it does not exist", () => {
    mockFs.existsSync = vi.fn(() => false);
    const log = new ActivityLog();
    log.setPersistPath("/tmp/newdir/activity.jsonl");
    log.record("t", 5, "success");
    expect(mockFs.mkdirSync).toHaveBeenCalled();
  });

  it("rotates file when size exceeds 1 MB", () => {
    mockFs.statSync = vi.fn(() => ({ size: 1024 * 1024 + 1 }) as any);
    mockFs.readFileSync = vi.fn(
      () =>
        '{"kind":"tool","id":1,"timestamp":"t","tool":"x","durationMs":1,"status":"success"}\n',
    );
    const log = new ActivityLog();
    log.setPersistPath("/tmp/big.jsonl");
    log.record("y", 5, "success");
    expect(mockFs.writeFileSync).toHaveBeenCalled();
  });

  it("loads existing tool entries from disk on setPersistPath", () => {
    const existing = JSON.stringify({
      kind: "tool",
      id: 1,
      timestamp: "2024-01-01T00:00:00.000Z",
      tool: "cached",
      durationMs: 10,
      status: "success",
    });
    mockFs.readFileSync = vi.fn(() => `${existing}\n`);
    const log = new ActivityLog();
    log.setPersistPath("/tmp/existing.jsonl");
    expect(log.query({ tool: "cached" })).toHaveLength(1);
  });

  it("loads lifecycle entries from disk on setPersistPath", () => {
    const existing = JSON.stringify({
      kind: "lifecycle",
      id: 2,
      timestamp: "2024-01-01T00:00:00.000Z",
      event: "connected",
    });
    mockFs.readFileSync = vi.fn(() => `${existing}\n`);
    const log = new ActivityLog();
    log.setPersistPath("/tmp/lifecycle.jsonl");
    const timeline = log.queryTimeline();
    const found = timeline.find(
      (e) => e.kind === "lifecycle" && (e as any).event === "connected",
    );
    expect(found).toBeDefined();
  });

  it("skips malformed lines during load", () => {
    mockFs.readFileSync = vi.fn(
      () =>
        'not-json\n{"kind":"tool","id":2,"timestamp":"t","tool":"ok","durationMs":1,"status":"success"}\n',
    );
    const log = new ActivityLog();
    log.setPersistPath("/tmp/partial.jsonl");
    expect(log.query({ tool: "ok" })).toHaveLength(1);
  });

  it("skips tool entries with missing required fields", () => {
    const bad = JSON.stringify({ kind: "tool", id: 1, timestamp: "t" }); // missing tool + durationMs
    mockFs.readFileSync = vi.fn(() => `${bad}\n`);
    const log = new ActivityLog();
    log.setPersistPath("/tmp/bad.jsonl");
    expect(log.query()).toHaveLength(0);
  });

  it("swallows appendFileSync errors silently", () => {
    mockFs.appendFileSync = vi.fn(() => {
      throw new Error("disk full");
    });
    const log = new ActivityLog();
    log.setPersistPath("/tmp/fail.jsonl");
    expect(() => log.record("t", 10, "success")).not.toThrow();
  });

  it("appends lifecycle events to disk", () => {
    const log = new ActivityLog();
    log.setPersistPath("/tmp/lc.jsonl");
    log.recordEvent("started", { port: 1234 });
    const written = (
      mockFs.appendFileSync as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[1] as string;
    expect(written).toContain('"kind":"lifecycle"');
    expect(written).toContain('"event":"started"');
  });
});
