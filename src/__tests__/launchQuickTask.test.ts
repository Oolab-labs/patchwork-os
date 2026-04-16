import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetQuickTaskCooldown,
  createLaunchQuickTaskTool,
} from "../tools/launchQuickTask.js";

function mkStruct(data: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function mkDeps(
  overrides: Partial<Parameters<typeof createLaunchQuickTaskTool>[0]> = {},
) {
  const runCalls: unknown[] = [];
  const resumeCalls: unknown[] = [];
  const baseDeps = {
    runTask: async (a: Record<string, unknown>) => {
      runCalls.push(a);
      return mkStruct({ taskId: "task-1", status: "pending" });
    },
    resumeTask: async (a: Record<string, unknown>) => {
      resumeCalls.push(a);
      return mkStruct({ newTaskId: "task-resumed", status: "running" });
    },
    getHandoff: async () => mkStruct({ note: null }),
    getContext: async () => mkStruct({ activeFile: "foo.ts", brief: {} }),
    getDiagnostics: async () => mkStruct({ errors: [] }),
    getPerfReport: async () => mkStruct({ latency: { perTool: {} } }),
    getAnalyticsReport: async () => mkStruct({ recentAutomationTasks: [] }),
  };
  return {
    deps: { ...baseDeps, ...overrides },
    runCalls,
    resumeCalls,
  };
}

describe("launchQuickTask", () => {
  beforeEach(() => {
    _resetQuickTaskCooldown();
  });

  it("rejects unknown preset", async () => {
    const { deps } = mkDeps();
    const tool = createLaunchQuickTaskTool(deps);
    const res = (await tool.handler({ presetId: "bogus" })) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
  });

  it("invokes runTask with built prompt for fixErrors", async () => {
    const { deps, runCalls } = mkDeps();
    const tool = createLaunchQuickTaskTool(deps);
    const res = (await tool.handler({ presetId: "fixErrors" })) as {
      structuredContent?: { taskId?: string; presetId?: string };
    };
    expect(res.structuredContent?.taskId).toBe("task-1");
    expect(res.structuredContent?.presetId).toBe("fixErrors");
    expect(runCalls.length).toBe(1);
    const args = runCalls[0] as { prompt: string };
    expect(args.prompt).toContain("getDiagnostics");
  });

  it("enforces cooldown between same-preset invocations", async () => {
    let clock = 1000;
    const { deps } = mkDeps({ now: () => clock });
    const tool = createLaunchQuickTaskTool(deps);
    const first = await tool.handler({ presetId: "fixErrors" });
    expect((first as { isError?: boolean }).isError).toBeFalsy();

    // 1s later — still on cooldown (5s window)
    clock += 1000;
    const second = (await tool.handler({
      presetId: "fixErrors",
      source: "cli",
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(second.isError).toBe(true);
    const errText = second.content?.[0]?.text ?? "";
    expect(errText).toContain("cooldown");
  });

  it("allows invocation after cooldown expires", async () => {
    let clock = 1000;
    const { deps } = mkDeps({ now: () => clock });
    const tool = createLaunchQuickTaskTool(deps);
    await tool.handler({ presetId: "fixErrors" });
    clock += 6000; // past 5s cooldown
    const res = (await tool.handler({ presetId: "fixErrors" })) as {
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
  });

  it("allows parallel invocations of different presets", async () => {
    const { deps } = mkDeps();
    const tool = createLaunchQuickTaskTool(deps);
    const a = (await tool.handler({ presetId: "fixErrors" })) as {
      isError?: boolean;
    };
    const b = (await tool.handler({ presetId: "runTests" })) as {
      isError?: boolean;
    };
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
  });

  it("dispatches to resumeTask for resumeLastCancelled", async () => {
    const { deps, resumeCalls, runCalls } = mkDeps({
      getAnalyticsReport: async () =>
        mkStruct({
          recentAutomationTasks: [{ id: "prev-task", status: "cancelled" }],
        }),
    });
    const tool = createLaunchQuickTaskTool(deps);
    const res = (await tool.handler({ presetId: "resumeLastCancelled" })) as {
      structuredContent?: { taskId?: string; resumed?: boolean };
    };
    expect(res.structuredContent?.resumed).toBe(true);
    expect(res.structuredContent?.taskId).toBe("task-resumed");
    expect(resumeCalls.length).toBe(1);
    expect(runCalls.length).toBe(0);
  });

  it("appends prior handoff context when note is non-empty + not auto-snapshot", async () => {
    const { deps, runCalls } = mkDeps({
      getHandoff: async () => mkStruct({ note: "Working on auth flow" }),
    });
    const tool = createLaunchQuickTaskTool(deps);
    await tool.handler({ presetId: "refactorFile" });
    const args = runCalls[0] as { prompt: string };
    expect(args.prompt).toContain("Prior context:");
    expect(args.prompt).toContain("Working on auth flow");
  });

  it("ignores auto-snapshot handoff notes", async () => {
    const { deps, runCalls } = mkDeps({
      getHandoff: async () =>
        mkStruct({ note: "[auto-snapshot 2026-04-16T10:00:00Z]\nfoo" }),
    });
    const tool = createLaunchQuickTaskTool(deps);
    await tool.handler({ presetId: "refactorFile" });
    const args = runCalls[0] as { prompt: string };
    expect(args.prompt).not.toContain("Prior context:");
    expect(args.prompt).not.toContain("auto-snapshot");
  });

  it("cooldown tracks source for diagnostic message", async () => {
    let clock = 1000;
    const { deps } = mkDeps({ now: () => clock });
    const tool = createLaunchQuickTaskTool(deps);
    await tool.handler({ presetId: "fixErrors", source: "sidebar" });
    clock += 500;
    const res = (await tool.handler({
      presetId: "fixErrors",
      source: "cli",
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    const errText = res.content?.[0]?.text ?? "";
    expect(errText).toContain("sidebar");
  });
});
