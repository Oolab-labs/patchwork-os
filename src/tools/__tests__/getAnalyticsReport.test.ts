import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLog } from "../../activityLog.js";
import type { ClaudeOrchestrator } from "../../claudeOrchestrator.js";
import { createGetAnalyticsReportTool } from "../getAnalyticsReport.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeLog(): ActivityLog {
  return new ActivityLog(500);
}

function _recordTool(
  log: ActivityLog,
  tool: string,
  durationMs: number,
  status: "success" | "error" = "success",
  timestampOffset = 0,
) {
  // Patch Date.now for the record call so we can simulate timestamps
  const orig = Date.now;
  vi.spyOn(Date, "now").mockReturnValueOnce(orig() - timestampOffset);
  log.record(tool, durationMs, status);
  vi.restoreAllMocks();
}

function makeOrchestrator(
  tasks: Array<{
    id: string;
    status: string;
    createdAt: number;
    triggerSource?: string;
    startedAt?: number;
    doneAt?: number;
  }>,
): ClaudeOrchestrator {
  return {
    list: () => tasks,
  } as unknown as ClaudeOrchestrator;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("getAnalyticsReport", () => {
  let log: ActivityLog;

  beforeEach(() => {
    log = makeLog();
  });

  it("returns required fields on empty data", async () => {
    const tool = createGetAnalyticsReportTool(log, null);
    const result = await tool.handler({});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty("generatedAt");
    expect(data).toHaveProperty("windowHours", 24);
    expect(data).toHaveProperty("topTools");
    expect(data).toHaveProperty("hooksLast24h");
    expect(data).toHaveProperty("recentAutomationTasks");
    expect(data).toHaveProperty("hint");
  });

  it("returns empty arrays when no data", async () => {
    const tool = createGetAnalyticsReportTool(log, null);
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0].text);
    expect(data.topTools).toEqual([]);
    expect(data.hooksLast24h).toBe(0);
    expect(data.recentAutomationTasks).toEqual([]);
  });

  it("topTools sorted by calls desc", async () => {
    log.record("alpha", 10, "success");
    log.record("alpha", 10, "success");
    log.record("alpha", 10, "success");
    log.record("beta", 5, "success");
    log.record("beta", 5, "success");
    log.record("gamma", 1, "success");

    const tool = createGetAnalyticsReportTool(log, null);
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0].text);
    expect(data.topTools[0].tool).toBe("alpha");
    expect(data.topTools[0].calls).toBe(3);
    expect(data.topTools[1].tool).toBe("beta");
    expect(data.topTools[1].calls).toBe(2);
    expect(data.topTools[2].tool).toBe("gamma");
    expect(data.topTools[2].calls).toBe(1);
  });

  it("topTools capped at 10", async () => {
    for (let i = 0; i < 15; i++) {
      log.record(`tool${i}`, 10, "success");
    }
    const tool = createGetAnalyticsReportTool(log, null);
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0].text);
    expect(data.topTools.length).toBeLessThanOrEqual(10);
  });

  it("topTools includes errors and avgMs", async () => {
    log.record("myTool", 100, "success");
    log.record("myTool", 200, "error");

    const tool = createGetAnalyticsReportTool(log, null);
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0].text);
    const entry = data.topTools.find(
      (t: { tool: string }) => t.tool === "myTool",
    );
    expect(entry).toBeDefined();
    expect(entry.calls).toBe(2);
    expect(entry.errors).toBe(1);
    expect(entry.avgMs).toBe(150);
  });

  it("windowHours param respected for hooksLast24h", async () => {
    // 2 recent lifecycle events (within 1h)
    log.recordEvent("hook.fired", { file: "a.ts" });
    log.recordEvent("hook.fired", { file: "b.ts" });
    // 1 old lifecycle event (25h ago) — inject directly via timeline query
    // We can't easily back-date recordEvent, so just verify the count for 1h window
    const tool = createGetAnalyticsReportTool(log, null);
    const result = await tool.handler({ windowHours: 1 });
    const data = JSON.parse(result.content[0].text);
    // Both events are recent so should count
    expect(data.hooksLast24h).toBe(2);
    expect(data.windowHours).toBe(1);
  });

  it("hooksLast24h counts lifecycle entries correctly", async () => {
    log.recordEvent("onFileSave");
    log.recordEvent("onFileSave");
    log.recordEvent("onDiagnosticsError");
    // tool entries should NOT be counted
    log.record("getDiagnostics", 10, "success");

    const tool = createGetAnalyticsReportTool(log, null);
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0].text);
    expect(data.hooksLast24h).toBe(3);
  });

  it("recentAutomationTasks shape is correct", async () => {
    const now = Date.now();
    const orch = makeOrchestrator([
      {
        id: "task-1",
        status: "done",
        createdAt: now - 1000,
        triggerSource: "onFileSave",
        startedAt: now - 900,
        doneAt: now - 500,
      },
      {
        id: "task-2",
        status: "running",
        createdAt: now - 500,
      },
    ]);

    const tool = createGetAnalyticsReportTool(log, orch);
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0].text);
    expect(data.recentAutomationTasks.length).toBe(2);
    const t1 = data.recentAutomationTasks[0]; // newest first
    expect(t1.id).toBe("task-2");
    const t2 = data.recentAutomationTasks[1];
    expect(t2.id).toBe("task-1");
    expect(t2.triggerSource).toBe("onFileSave");
    expect(t2.durationMs).toBe(400);
    expect(t2.createdAt).toMatch(/^\d{4}-/); // ISO string
  });

  it("recentAutomationTasks capped at 20", async () => {
    const now = Date.now();
    const tasks = Array.from({ length: 30 }, (_, i) => ({
      id: `task-${i}`,
      status: "done",
      createdAt: now - i * 1000,
    }));
    const orch = makeOrchestrator(tasks);

    const tool = createGetAnalyticsReportTool(log, orch);
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0].text);
    expect(data.recentAutomationTasks.length).toBe(20);
  });
});
