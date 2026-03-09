import { describe, it, expect } from "vitest";
import { ActivityLog } from "../activityLog.js";

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
    expect(stats["openFile"]?.count).toBe(3);
    expect(stats["openFile"]?.avgDurationMs).toBe(20);
    expect(stats["openFile"]?.errors).toBe(1);
    expect(stats["runCommand"]?.count).toBe(1);
    expect(stats["runCommand"]?.errors).toBe(0);
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
    expect(output).toContain('bridge_tool_calls_total{tool="openFile",status="success"} 2');
    expect(output).toContain('bridge_tool_calls_total{tool="openFile",status="error"} 1');
    // Counter lines for runCommand
    expect(output).toContain('bridge_tool_calls_total{tool="runCommand",status="success"} 1');
    expect(output).toContain('bridge_tool_calls_total{tool="runCommand",status="error"} 0');
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
