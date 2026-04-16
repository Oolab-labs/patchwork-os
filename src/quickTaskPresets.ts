/**
 * Shared quick-task presets. Single source of truth for sidebar + CLI + MCP tool.
 *
 * This file is authoritative in the bridge repo at src/quickTaskPresets.ts.
 * The extension build (vscode-extension/esbuild.mjs) copies it to
 * vscode-extension/src/quickTaskPresets.ts so both trees typecheck independently.
 * DO NOT edit the copy — edit this file and rebuild.
 */

import * as path from "node:path";

export const QUICK_TASK_PRESETS_VERSION = 1;

export const PRESET_COOLDOWN_MS = 5_000;

export const QUICK_TASK_PRESET_IDS = [
  "fixErrors",
  "refactorFile",
  "addTests",
  "explainCode",
  "optimizePerf",
  "resumeLastCancelled",
  "runTests",
] as const;

export type QuickTaskPresetId = (typeof QUICK_TASK_PRESET_IDS)[number];

export interface PresetContext {
  activeFile?: string;
  brief?: {
    activeFile?: string;
    recentCommits?: Array<{ message: string }>;
    recentErrors?: Array<{ message: string }>;
  };
  recentCommits?: Array<{ message: string }>;
  diagnostics?: {
    errors?: Array<{ message: string; file?: string }>;
  } | null;
  report?: {
    recentAutomationTasks?: Array<{
      id: string;
      status: string;
      triggerSource?: string;
    }>;
  } | null;
  perfReport?: {
    latency?: {
      perTool?: Record<string, { p99: number }>;
    };
  } | null;
}

export interface QuickTaskPreset {
  id: QuickTaskPresetId;
  icon: string;
  label: string;
  prompt: string;
  taskId?: string;
}

export function buildQuickTaskPresets(ctx: PresetContext): QuickTaskPreset[] {
  const activeFile = ctx.activeFile ?? ctx.brief?.activeFile;
  const baseName = activeFile ? path.basename(activeFile) : "";

  // 1. fixErrors
  const diagErrors = ctx.diagnostics?.errors ?? [];
  const errorCount = diagErrors.length;
  const topErrorFile = diagErrors[0]?.file
    ? path.basename(diagErrors[0].file)
    : "";
  const fixErrors: QuickTaskPreset =
    errorCount > 0
      ? {
          id: "fixErrors",
          icon: '<i class="codicon codicon-error"></i>',
          label: `Fix ${errorCount} error${errorCount === 1 ? "" : "s"}${topErrorFile ? ` in ${topErrorFile}` : ""}`,
          prompt: `Call getDiagnostics to get all current errors and warnings${topErrorFile ? ` (start with ${topErrorFile})` : ""}. Fix every error precisely — do not break working code. Run tests after fixing to confirm nothing regressed.`,
        }
      : {
          id: "fixErrors",
          icon: '<i class="codicon codicon-error"></i>',
          label: "Fix all errors",
          prompt:
            "Call getDiagnostics to get all current errors and warnings. Fix every error precisely — do not break working code. Run tests after fixing to confirm nothing regressed.",
        };

  // 2. refactorFile
  const refactorFile: QuickTaskPreset = baseName
    ? {
        id: "refactorFile",
        icon: '<i class="codicon codicon-symbol-misc"></i>',
        label: `Refactor ${baseName}`,
        prompt: `Refactor ${activeFile ?? "the active file"} for clarity, readability, and maintainability. Keep all existing behaviour identical. Use getBufferContent to read the current file before making changes.`,
      }
    : {
        id: "refactorFile",
        icon: '<i class="codicon codicon-symbol-misc"></i>',
        label: "Refactor this file",
        prompt:
          "Refactor the active file for clarity, readability, and maintainability. Keep all existing behaviour identical. Use getBufferContent to read the current file before making changes.",
      };

  // 3. addTests
  const failedTestTask = ctx.report?.recentAutomationTasks?.find(
    (t) =>
      t.status === "error" &&
      (t.triggerSource ?? "").toLowerCase().includes("test"),
  );
  const addTests: QuickTaskPreset = failedTestTask
    ? {
        id: "addTests",
        icon: '<i class="codicon codicon-beaker"></i>',
        label: "Add tests for failing flow",
        prompt:
          "A recent test run failed. Use getDiagnostics and getBufferContent to identify the failing logic, then write targeted tests that cover the failing flow and edge cases.",
      }
    : {
        id: "addTests",
        icon: '<i class="codicon codicon-beaker"></i>',
        label: `Add tests for ${baseName || "this file"}`,
        prompt:
          "Write comprehensive unit tests for the functions in the active file. Use getBufferContent to read the file. Match the existing test style and patterns in the project. Cover edge cases.",
      };

  // 4. explainCode
  const recentCommits = ctx.recentCommits ?? ctx.brief?.recentCommits;
  const lastCommit = recentCommits?.[0];
  const explainCode: QuickTaskPreset = lastCommit
    ? {
        id: "explainCode",
        icon: '<i class="codicon codicon-book"></i>',
        label: "Explain changes from last commit",
        prompt: `Use getGitDiff or getGitLog to get the last commit diff, then explain what changed, why the changes were made, and any non-obvious patterns. Last commit: ${lastCommit.message}`,
      }
    : {
        id: "explainCode",
        icon: '<i class="codicon codicon-book"></i>',
        label: `Explain ${baseName || "this file"}`,
        prompt:
          "Read the active file with getBufferContent and explain what it does: its purpose, key functions, data flow, and any non-obvious patterns. Keep it concise and technical.",
      };

  // 5. optimizePerf
  let slowestTool: string | null = null;
  const perTool = ctx.perfReport?.latency?.perTool;
  if (perTool) {
    let maxP99 = -1;
    for (const [tool, v] of Object.entries(perTool)) {
      if (v.p99 > maxP99) {
        maxP99 = v.p99;
        slowestTool = tool;
      }
    }
  }
  const optimizePerf: QuickTaskPreset = slowestTool
    ? {
        id: "optimizePerf",
        icon: '<i class="codicon codicon-dashboard"></i>',
        label: `Optimize slowest fn (${slowestTool})`,
        prompt: `Use getPerformanceReport to find the bottleneck and optimize ${slowestTool}. Identify the root cause of the latency, propose fixes, and apply the most impactful improvements.`,
      }
    : {
        id: "optimizePerf",
        icon: '<i class="codicon codicon-dashboard"></i>',
        label: "Optimize performance",
        prompt:
          "Analyse the active file for performance issues: unnecessary re-renders, expensive loops, blocking I/O, memory leaks. Use getBufferContent to read it, then propose and apply the most impactful fixes.",
      };

  const presets: QuickTaskPreset[] = [
    fixErrors,
    refactorFile,
    addTests,
    explainCode,
    optimizePerf,
  ];

  // 6. resumeLastCancelled — only if cancelled task exists
  const cancelledTask = ctx.report?.recentAutomationTasks?.find(
    (t) => t.status === "cancelled" || t.status === "interrupted",
  );
  if (cancelledTask) {
    presets.push({
      id: "resumeLastCancelled",
      icon: '<i class="codicon codicon-debug-continue"></i>',
      label: "Resume last cancelled task",
      prompt: "",
      taskId: cancelledTask.id,
    });
  }

  // 7. runTests — always
  presets.push({
    id: "runTests",
    icon: '<i class="codicon codicon-play"></i>',
    label: "Run full test suite",
    prompt:
      "Run the full test suite using the appropriate test runner. Report all failures with file and line numbers.",
  });

  return presets;
}

/**
 * Build the prompt for a given preset id. Returns null if the id is unknown.
 * For `resumeLastCancelled`, returns `resumeTaskId` instead of a prompt — caller
 * should dispatch to `resumeClaudeTask` rather than `runClaudeTask`.
 */
export function buildQuickTaskPrompt(
  presetId: string,
  ctx: PresetContext,
): { prompt: string; resumeTaskId?: string } | null {
  const presets = buildQuickTaskPresets(ctx);
  const preset = presets.find((p) => p.id === presetId);
  if (!preset) return null;
  if (preset.id === "resumeLastCancelled" && preset.taskId) {
    return { prompt: "", resumeTaskId: preset.taskId };
  }
  return { prompt: preset.prompt };
}
