import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CO_OCCURRENCE_WINDOW_MS } from "../activityLog.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(
        (_path: any) => true,
      ) as any as typeof import("node:fs").existsSync,
      mkdirSync: vi.fn() as any,
      appendFileSync: vi.fn() as any,
      writeFileSync: vi.fn() as any,
      readFileSync: vi.fn(
        (_path: any) => "",
      ) as any as typeof import("node:fs").readFileSync,
      statSync: vi.fn((_path: any) => ({
        size: 0,
      })) as any as typeof import("node:fs").statSync,
      promises: {
        ...actual.promises,
        appendFile: vi.fn(() => Promise.resolve()) as any,
        stat: vi.fn(() => Promise.resolve({ size: 0 })) as any,
      },
    },
  };
});

import fs from "node:fs";
import { ActivityLog } from "../activityLog.js";

const mockFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  (mockFs.existsSync as any) = vi.fn((_path: any) => true) as any;
  (mockFs.mkdirSync as any) = vi.fn();
  (mockFs.appendFileSync as any) = vi.fn();
  (mockFs.writeFileSync as any) = vi.fn();
  (mockFs.readFileSync as any) = vi.fn((_path: any) => "") as any;
  Object.defineProperty(mockFs, "statSync", {
    value: vi.fn((_path: any) => ({ size: 0 })) as any,
    writable: true,
  });
  (mockFs.promises as unknown as Record<string, unknown>).appendFile = vi.fn(
    () => Promise.resolve(),
  );
  (mockFs.promises as unknown as Record<string, unknown>).stat = vi.fn(() =>
    Promise.resolve({ size: 0 }),
  );
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

describe("ActivityLog — percentiles", () => {
  it("returns empty object when no entries", () => {
    const log = new ActivityLog();
    expect(log.percentiles()).toEqual({});
  });

  it("returns null-equivalent (skips) tools with only 1 sample", () => {
    const log = new ActivityLog();
    log.record("solo", 100, "success");
    expect(log.percentiles().solo).toBeUndefined();
  });

  it("computes p50/p95/p99 correctly for known distribution", () => {
    const log = new ActivityLog();
    // 100 samples: 1..100ms
    for (let i = 1; i <= 100; i++) log.record("t", i, "success");
    const p = log.percentiles().t;
    expect(p).toBeDefined();
    // p50 = 50th percentile of [1..100] sorted = 50
    expect(p!.p50).toBe(50);
    // p95 = 95th percentile = 95
    expect(p!.p95).toBe(95);
    // p99 = 99th percentile = 99
    expect(p!.p99).toBe(99);
    expect(p!.sampleCount).toBe(100);
  });

  it("percentile values within ±2ms for 1000-sample uniform distribution", () => {
    const log = new ActivityLog();
    for (let i = 1; i <= 1000; i++) log.record("u", i, "success");
    const p = log.percentiles().u!;
    expect(Math.abs(p.p50 - 500)).toBeLessThanOrEqual(2);
    expect(Math.abs(p.p95 - 950)).toBeLessThanOrEqual(2);
    expect(Math.abs(p.p99 - 990)).toBeLessThanOrEqual(2);
  });

  it("evicts oldest samples when buffer exceeds 1200 entries", () => {
    const log = new ActivityLog();
    // Push 1201 entries to trigger batch eviction (cap 1000 * 1.2 = 1200)
    for (let i = 0; i < 1201; i++) log.record("big", i, "success");
    const p = log.percentiles().big!;
    // After eviction, sampleCount should be capped at 1000
    expect(p.sampleCount).toBeLessThanOrEqual(1000);
  });

  it("tracks multiple tools independently", () => {
    const log = new ActivityLog();
    for (let i = 1; i <= 10; i++) log.record("fast", i, "success");
    for (let i = 100; i <= 109; i++) log.record("slow", i, "success");
    const p = log.percentiles();
    expect(p.fast!.p50).toBeLessThan(p.slow!.p50);
  });
});

describe("ActivityLog — co-occurrence", () => {
  it("returns empty array when no entries", () => {
    const log = new ActivityLog();
    expect(log.coOccurrence()).toEqual([]);
  });

  it("returns empty for single tool (no pairs)", () => {
    const log = new ActivityLog();
    const now = Date.now();
    // Manually inject entries with controlled timestamps
    (log as any).entries = [
      {
        id: 1,
        timestamp: new Date(now).toISOString(),
        tool: "a",
        durationMs: 10,
        status: "success",
      },
      {
        id: 2,
        timestamp: new Date(now + 1000).toISOString(),
        tool: "a",
        durationMs: 10,
        status: "success",
      },
    ];
    expect(log.coOccurrence()).toEqual([]);
  });

  it("counts pairs within window", () => {
    const log = new ActivityLog();
    const now = Date.now();
    (log as any).entries = [
      {
        id: 1,
        timestamp: new Date(now).toISOString(),
        tool: "getBufferContent",
        durationMs: 10,
        status: "success",
      },
      {
        id: 2,
        timestamp: new Date(now + 100).toISOString(),
        tool: "editText",
        durationMs: 10,
        status: "success",
      },
      {
        id: 3,
        timestamp: new Date(now + 200).toISOString(),
        tool: "getBufferContent",
        durationMs: 10,
        status: "success",
      },
      {
        id: 4,
        timestamp: new Date(now + 300).toISOString(),
        tool: "editText",
        durationMs: 10,
        status: "success",
      },
    ];
    const pairs = log.coOccurrence(60_000);
    const top = pairs[0];
    expect(top).toBeDefined();
    expect(top!.pair).toBe("editText|getBufferContent");
    expect(top!.count).toBeGreaterThanOrEqual(2);
  });

  it("excludes pairs outside the window", () => {
    const log = new ActivityLog();
    const now = Date.now();
    (log as any).entries = [
      {
        id: 1,
        timestamp: new Date(now).toISOString(),
        tool: "a",
        durationMs: 10,
        status: "success",
      },
      // 10 minutes later — outside 5-min default window
      {
        id: 2,
        timestamp: new Date(now + 10 * 60 * 1000 + 1).toISOString(),
        tool: "b",
        durationMs: 10,
        status: "success",
      },
    ];
    expect(log.coOccurrence(DEFAULT_CO_OCCURRENCE_WINDOW_MS)).toEqual([]);
  });

  it("pair key is alphabetically ordered (a|b not b|a)", () => {
    const log = new ActivityLog();
    const now = Date.now();
    (log as any).entries = [
      {
        id: 1,
        timestamp: new Date(now).toISOString(),
        tool: "z",
        durationMs: 10,
        status: "success",
      },
      {
        id: 2,
        timestamp: new Date(now + 100).toISOString(),
        tool: "a",
        durationMs: 10,
        status: "success",
      },
    ];
    const pairs = log.coOccurrence(60_000);
    expect(pairs[0]?.pair).toBe("a|z");
  });

  it("sorts by count descending", () => {
    const log = new ActivityLog();
    const now = Date.now();
    // a+b appear 3 times together, c+d appear once
    const entries = [];
    for (let i = 0; i < 3; i++) {
      entries.push({
        id: entries.length + 1,
        timestamp: new Date(now + entries.length * 100).toISOString(),
        tool: "a",
        durationMs: 10,
        status: "success",
      });
      entries.push({
        id: entries.length + 1,
        timestamp: new Date(now + entries.length * 100).toISOString(),
        tool: "b",
        durationMs: 10,
        status: "success",
      });
    }
    entries.push({
      id: entries.length + 1,
      timestamp: new Date(now + entries.length * 100).toISOString(),
      tool: "c",
      durationMs: 10,
      status: "success",
    });
    entries.push({
      id: entries.length + 1,
      timestamp: new Date(now + entries.length * 100).toISOString(),
      tool: "d",
      durationMs: 10,
      status: "success",
    });
    (log as any).entries = entries;
    const pairs = log.coOccurrence(60_000);
    expect(pairs[0]?.pair).toBe("a|b");
    expect(pairs[0]?.count).toBeGreaterThan(pairs[1]?.count ?? 0);
  });
});

describe("ActivityLog — disk persistence", () => {
  it("appends entry to disk when persistPath is set", async () => {
    const log = new ActivityLog();
    log.setPersistPath("/tmp/activity.jsonl");
    log.record("read", 10, "success");
    // Wait for the fire-and-forget async append to complete
    await vi.waitFor(() =>
      expect(mockFs.promises.appendFile).toHaveBeenCalled(),
    );
    const written = (
      mockFs.promises.appendFile as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[1] as string;
    expect(written).toContain('"kind":"tool"');
    expect(written).toContain('"tool":"read"');
  });

  it("creates directory when it does not exist", async () => {
    mockFs.existsSync = vi.fn(() => false);
    const log = new ActivityLog();
    log.setPersistPath("/tmp/newdir/activity.jsonl");
    log.record("t", 5, "success");
    await vi.waitFor(() => expect(mockFs.mkdirSync).toHaveBeenCalled());
  });

  it("rotates file when size exceeds 1 MB", async () => {
    (mockFs.promises as unknown as Record<string, unknown>).stat = vi.fn(() =>
      Promise.resolve({ size: 1024 * 1024 + 1 }),
    );
    (mockFs.promises as unknown as Record<string, unknown>).readFile = vi.fn(
      () =>
        Promise.resolve(
          '{"kind":"tool","id":1,"timestamp":"t","tool":"x","durationMs":1,"status":"success"}\n',
        ),
    );
    const writeMock = vi.fn(() => Promise.resolve());
    (mockFs.promises as unknown as Record<string, unknown>).writeFile =
      writeMock;
    const log = new ActivityLog();
    log.setPersistPath("/tmp/big.jsonl");
    log.record("y", 5, "success");
    await vi.waitFor(() => expect(writeMock).toHaveBeenCalled());
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

  it("swallows appendFile errors silently", async () => {
    (mockFs.promises as unknown as Record<string, unknown>).appendFile = vi.fn(
      () => Promise.reject(new Error("disk full")),
    );
    const log = new ActivityLog();
    log.setPersistPath("/tmp/fail.jsonl");
    expect(() => log.record("t", 10, "success")).not.toThrow();
    // Give the async rejection a chance to surface (it should be swallowed)
    await new Promise((r) => setTimeout(r, 20));
  });

  it("appends lifecycle events to disk", async () => {
    const log = new ActivityLog();
    log.setPersistPath("/tmp/lc.jsonl");
    log.recordEvent("started", { port: 1234 });
    await vi.waitFor(() =>
      expect(mockFs.promises.appendFile).toHaveBeenCalled(),
    );
    const written = (
      mockFs.promises.appendFile as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[1] as string;
    expect(written).toContain('"kind":"lifecycle"');
    expect(written).toContain('"event":"started"');
  });
});

describe("ActivityLog.windowedStats", () => {
  it("returns stats only for entries within the window", () => {
    vi.useFakeTimers();
    const log = new ActivityLog();
    const now = Date.now();
    vi.setSystemTime(now - 120_000); // 2 minutes ago — outside 1-minute window
    log.record("oldTool", 50, "success");
    vi.setSystemTime(now - 30_000); // 30s ago — inside
    log.record("newTool", 100, "success");
    log.record("newTool", 200, "error", "fail");
    vi.setSystemTime(now);
    const stats = log.windowedStats(60_000); // 1-minute window
    expect(stats.oldTool).toBeUndefined();
    expect(stats.newTool).toBeDefined();
    expect(stats.newTool!.count).toBe(2);
    expect(stats.newTool!.errors).toBe(1);
    expect(stats.newTool!.avgDurationMs).toBe(150);
    vi.useRealTimers();
  });

  it("returns empty object when no entries in window", () => {
    const log = new ActivityLog();
    const stats = log.windowedStats(60_000);
    expect(Object.keys(stats)).toHaveLength(0);
  });
});

describe("ActivityLog.recordRateLimitRejection", () => {
  it("starts at 0 and increments", () => {
    const log = new ActivityLog();
    expect(log.getRateLimitRejections()).toBe(0);
    log.recordRateLimitRejection();
    log.recordRateLimitRejection();
    expect(log.getRateLimitRejections()).toBe(2);
  });
});

describe("ActivityLog.findApprovalByCallId", () => {
  it("returns null decision when callId is not logged", async () => {
    const { ActivityLog } = await import("../activityLog.js");
    const log = new ActivityLog();
    const out = log.findApprovalByCallId("missing");
    expect(out.decision).toBeNull();
    expect(out.nearby).toEqual([]);
  });

  it("finds the decision and same-session lifecycle events in window", async () => {
    const { ActivityLog } = await import("../activityLog.js");
    const log = new ActivityLog();
    log.recordEvent("approval_decision", {
      callId: "call-1",
      toolName: "Bash",
      decision: "allow",
      sessionId: "sess-a",
    });
    // Same session, within ±60s.
    log.recordEvent("session_resumed", { sessionId: "sess-a" });
    // Different session — must be excluded.
    log.recordEvent("claude_connected", { sessionId: "sess-other" });

    const out = log.findApprovalByCallId("call-1");
    expect(out.decision?.metadata?.callId).toBe("call-1");
    expect(out.nearby).toHaveLength(1);
    expect(out.nearby[0]).toMatchObject({
      kind: "lifecycle",
      event: "session_resumed",
    });
  });

  it("excludes the decision itself from nearby list", async () => {
    const { ActivityLog } = await import("../activityLog.js");
    const log = new ActivityLog();
    log.recordEvent("approval_decision", {
      callId: "call-2",
      sessionId: "sess-b",
    });
    const out = log.findApprovalByCallId("call-2");
    expect(out.nearby.every((e) => e.id !== out.decision?.id)).toBe(true);
  });

  it("returns empty nearby when decision has no sessionId", async () => {
    const { ActivityLog } = await import("../activityLog.js");
    const log = new ActivityLog();
    log.recordEvent("approval_decision", { callId: "call-3" });
    const out = log.findApprovalByCallId("call-3");
    expect(out.decision).not.toBeNull();
    expect(out.nearby).toEqual([]);
  });
});
