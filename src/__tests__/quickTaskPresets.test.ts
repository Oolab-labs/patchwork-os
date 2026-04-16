import { describe, expect, it } from "vitest";
import {
  buildQuickTaskPresets,
  buildQuickTaskPrompt,
  PRESET_COOLDOWN_MS,
  QUICK_TASK_PRESET_IDS,
  QUICK_TASK_PRESETS_VERSION,
} from "../quickTaskPresets.js";

describe("quickTaskPresets", () => {
  it("exports stable constants", () => {
    expect(QUICK_TASK_PRESETS_VERSION).toBe(1);
    expect(PRESET_COOLDOWN_MS).toBe(5_000);
    expect(QUICK_TASK_PRESET_IDS).toContain("fixErrors");
    expect(QUICK_TASK_PRESET_IDS).toContain("runTests");
  });

  it("returns baseline presets with empty context", () => {
    const presets = buildQuickTaskPresets({});
    const ids = presets.map((p) => p.id);
    expect(ids).toContain("fixErrors");
    expect(ids).toContain("refactorFile");
    expect(ids).toContain("addTests");
    expect(ids).toContain("explainCode");
    expect(ids).toContain("optimizePerf");
    expect(ids).toContain("runTests");
    // resumeLastCancelled only appears with cancelled task
    expect(ids).not.toContain("resumeLastCancelled");
  });

  it("fixErrors label reflects error count and top file", () => {
    const presets = buildQuickTaskPresets({
      diagnostics: {
        errors: [{ message: "x", file: "/abs/path/foo.ts" }, { message: "y" }],
      },
    });
    const fx = presets.find((p) => p.id === "fixErrors");
    expect(fx?.label).toContain("2 errors");
    expect(fx?.label).toContain("foo.ts");
    expect(fx?.prompt).toContain("foo.ts");
  });

  it("refactorFile uses active file basename", () => {
    const presets = buildQuickTaskPresets({
      activeFile: "/a/b/c/widget.tsx",
    });
    const rf = presets.find((p) => p.id === "refactorFile");
    expect(rf?.label).toBe("Refactor widget.tsx");
    expect(rf?.prompt).toContain("/a/b/c/widget.tsx");
  });

  it("optimizePerf picks highest p99 tool", () => {
    const presets = buildQuickTaskPresets({
      perfReport: {
        latency: {
          perTool: {
            a: { p99: 10 },
            slowOne: { p99: 999 },
            b: { p99: 50 },
          },
        },
      },
    });
    const op = presets.find((p) => p.id === "optimizePerf");
    expect(op?.label).toContain("slowOne");
  });

  it("includes resumeLastCancelled when cancelled task present", () => {
    const presets = buildQuickTaskPresets({
      report: {
        recentAutomationTasks: [{ id: "task-abc", status: "cancelled" }],
      },
    });
    const r = presets.find((p) => p.id === "resumeLastCancelled");
    expect(r).toBeDefined();
    expect(r?.taskId).toBe("task-abc");
  });

  it("explainCode references last commit message when available", () => {
    const presets = buildQuickTaskPresets({
      recentCommits: [{ message: "feat: add foo" }],
    });
    const ex = presets.find((p) => p.id === "explainCode");
    expect(ex?.label).toBe("Explain changes from last commit");
    expect(ex?.prompt).toContain("feat: add foo");
  });

  it("buildQuickTaskPrompt returns prompt for known id", () => {
    const r = buildQuickTaskPrompt("fixErrors", {});
    expect(r?.prompt).toContain("getDiagnostics");
    expect(r?.resumeTaskId).toBeUndefined();
  });

  it("buildQuickTaskPrompt returns resumeTaskId for resumeLastCancelled", () => {
    const r = buildQuickTaskPrompt("resumeLastCancelled", {
      report: {
        recentAutomationTasks: [{ id: "t-9", status: "interrupted" }],
      },
    });
    expect(r?.resumeTaskId).toBe("t-9");
    expect(r?.prompt).toBe("");
  });

  it("buildQuickTaskPrompt returns null for unknown id", () => {
    expect(buildQuickTaskPrompt("bogus", {})).toBeNull();
  });
});
