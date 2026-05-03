import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityLog } from "../activityLog.js";
import { computeAutomationSuggestions } from "../automationSuggestions.js";
import { RecipeRunLog } from "../runLog.js";

/**
 * Helper to feed activity entries with controlled timestamps. Bypasses
 * the public `record()` so tests can set timestamps in the past and
 * exercise the time-window filter on `queryAll`.
 */
function recordAt(
  log: ActivityLog,
  tool: string,
  timestamp: string,
  status: "success" | "error" = "success",
): void {
  // Use the public record API; then overwrite the just-pushed entry's
  // timestamp via the same private array. This is a test seam — the
  // alternative would be a public seam ("recordWithTimestamp") that
  // production code shouldn't have.
  log.record(tool, 50, status);
  // biome-ignore lint/suspicious/noExplicitAny: test seam into private array
  const entries = (log as any).entries as Array<{ timestamp: string }>;
  const last = entries[entries.length - 1];
  if (last) last.timestamp = timestamp;
}

const NOW = Date.now();
const ONE_DAY_AGO = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
const TWO_DAYS_AGO = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
const TEN_DAYS_AGO = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString();

describe("computeAutomationSuggestions", () => {
  // RecipeRunLog requires a real directory because it appends to disk
  // on `startRun` / `recordCompleted`. Use a fresh tmp dir per test.
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "patchwork-suggest-test-"));
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("co-occurring pairs", () => {
    it("suggests a pair that fires ≥ minCount times within the window", () => {
      const log = new ActivityLog();
      // Five tight (within 5 min) co-occurrences of (Read, gitDiff).
      for (let i = 0; i < 5; i++) {
        const t1 = new Date(NOW - i * 30 * 60 * 1000).toISOString();
        const t2 = new Date(NOW - i * 30 * 60 * 1000 + 60_000).toISOString();
        recordAt(log, "Read", t1);
        recordAt(log, "gitDiff", t2);
      }

      const suggestions = computeAutomationSuggestions({
        activityLog: log,
        listToolNamesFn: () => [], // no installed-tools noise
        coOccurrenceMinCount: 5,
      });
      const pair = suggestions.find((s) => s.kind === "co_occurring_pair");
      expect(pair).toBeDefined();
      expect(pair?.details?.pair).toEqual(["Read", "gitDiff"]);
      expect(pair?.details?.count).toBeGreaterThanOrEqual(5);
    });

    it("does not suggest a pair below the min-count threshold", () => {
      const log = new ActivityLog();
      // Only 2 co-occurrences — below the default 5.
      for (let i = 0; i < 2; i++) {
        const t1 = new Date(NOW - i * 60_000).toISOString();
        const t2 = new Date(NOW - i * 60_000 + 1000).toISOString();
        recordAt(log, "Read", t1);
        recordAt(log, "gitDiff", t2);
      }
      const suggestions = computeAutomationSuggestions({
        activityLog: log,
        listToolNamesFn: () => [],
      });
      expect(
        suggestions.find((s) => s.kind === "co_occurring_pair"),
      ).toBeUndefined();
    });

    it("does not suggest a pair that already appears together in a successful recipe run", () => {
      const log = new ActivityLog();
      for (let i = 0; i < 5; i++) {
        const t1 = new Date(NOW - i * 30 * 60_000).toISOString();
        const t2 = new Date(NOW - i * 30 * 60_000 + 60_000).toISOString();
        recordAt(log, "Read", t1);
        recordAt(log, "gitDiff", t2);
      }

      const runLog = new RecipeRunLog({ dir: tmpDir });
      const seq = runLog.startRun({
        taskId: "t-1",
        recipeName: "browse",
        trigger: "manual",
        createdAt: NOW,
        model: "claude",
      });
      runLog.completeRun(seq, {
        status: "done",
        doneAt: NOW + 100,
        durationMs: 100,
        stepResults: [
          { tool: "Read", durationMs: 10, status: "ok" },
          { tool: "gitDiff", durationMs: 10, status: "ok" },
        ],
      });

      const suggestions = computeAutomationSuggestions({
        activityLog: log,
        recipeRunLog: runLog,
        listToolNamesFn: () => [],
        coOccurrenceMinCount: 5,
      });
      expect(
        suggestions.find((s) => s.kind === "co_occurring_pair"),
      ).toBeUndefined();
    });

    it("respects the activity time window — old co-occurrences don't count", () => {
      const log = new ActivityLog();
      // 5 co-occurrences but they're all 10 days old.
      for (let i = 0; i < 5; i++) {
        const base = new Date(
          NOW - (10 * 24 * 60 + i) * 60 * 1000,
        ).toISOString();
        const next = new Date(
          NOW - (10 * 24 * 60 + i) * 60 * 1000 + 60_000,
        ).toISOString();
        recordAt(log, "Read", base);
        recordAt(log, "gitDiff", next);
      }

      // Default lookback is 7 days — 10-day-old entries excluded.
      const suggestions = computeAutomationSuggestions({
        activityLog: log,
        listToolNamesFn: () => [],
        coOccurrenceMinCount: 5,
      });
      expect(
        suggestions.find((s) => s.kind === "co_occurring_pair"),
      ).toBeUndefined();
    });
  });

  describe("installed-but-unused", () => {
    it("flags installed tools that have never been called in the window", () => {
      const log = new ActivityLog();
      recordAt(log, "Read", ONE_DAY_AGO);
      // gitDiff is installed but has no activity.
      const suggestions = computeAutomationSuggestions({
        activityLog: log,
        listToolNamesFn: () => ["Read", "gitDiff", "WebFetch"],
      });
      const sig = suggestions.find((s) => s.kind === "installed_but_unused");
      expect(sig).toBeDefined();
      expect(sig?.details?.unusedTools).toEqual(
        expect.arrayContaining(["gitDiff", "WebFetch"]),
      );
      expect(sig?.details?.unusedTools).not.toContain("Read");
    });

    it("does not flag when every installed tool has been used", () => {
      const log = new ActivityLog();
      recordAt(log, "Read", ONE_DAY_AGO);
      recordAt(log, "gitDiff", TWO_DAYS_AGO);
      const suggestions = computeAutomationSuggestions({
        activityLog: log,
        listToolNamesFn: () => ["Read", "gitDiff"],
      });
      expect(
        suggestions.find((s) => s.kind === "installed_but_unused"),
      ).toBeUndefined();
    });

    it("does not flag when no tools are registered", () => {
      const log = new ActivityLog();
      const suggestions = computeAutomationSuggestions({
        activityLog: log,
        listToolNamesFn: () => [],
      });
      expect(
        suggestions.find((s) => s.kind === "installed_but_unused"),
      ).toBeUndefined();
    });

    it("rolls up to a single suggestion with examples + count, not one per tool", () => {
      const log = new ActivityLog();
      const installed = Array.from({ length: 12 }, (_, i) => `tool_${i}`);
      const suggestions = computeAutomationSuggestions({
        activityLog: log,
        listToolNamesFn: () => installed,
      });
      const sigs = suggestions.filter((s) => s.kind === "installed_but_unused");
      expect(sigs).toHaveLength(1);
      expect(sigs[0]?.label).toMatch(/12 installed tools/);
      expect(sigs[0]?.label).toMatch(/\+7 more/); // 12 unused, 5 examples shown
    });

    it("counts entries from outside the window as 'unused' (window-bounded)", () => {
      const log = new ActivityLog();
      // Only old activity — older than the 7-day default window.
      recordAt(log, "Read", TEN_DAYS_AGO);
      const suggestions = computeAutomationSuggestions({
        activityLog: log,
        listToolNamesFn: () => ["Read"],
      });
      const sig = suggestions.find((s) => s.kind === "installed_but_unused");
      expect(sig).toBeDefined();
      expect(sig?.details?.unusedTools).toContain("Read");
    });
  });

  describe("recipe trust graduation", () => {
    it("flags a recipe with ≥ 10 done runs, no failures", () => {
      const runLog = new RecipeRunLog({ dir: tmpDir });
      for (let i = 0; i < 10; i++) {
        const seq = runLog.startRun({
          taskId: `t-${i}`,
          recipeName: "daily-status",
          trigger: "cron",
          createdAt: NOW,
          model: "claude",
        });
        runLog.completeRun(seq, {
          status: "done",
          doneAt: NOW + 100,
          durationMs: 100,
          stepResults: [],
        });
      }

      const suggestions = computeAutomationSuggestions({
        activityLog: new ActivityLog(),
        recipeRunLog: runLog,
        listToolNamesFn: () => [],
      });
      const sig = suggestions.find((s) => s.kind === "recipe_trust_graduation");
      expect(sig).toBeDefined();
      expect(sig?.details?.recipeName).toBe("daily-status");
      expect(sig?.details?.runCount).toBe(10);
    });

    it("does NOT flag a recipe with even one error in its run history", () => {
      const runLog = new RecipeRunLog({ dir: tmpDir });
      for (let i = 0; i < 10; i++) {
        const seq = runLog.startRun({
          taskId: `t-${i}`,
          recipeName: "flaky",
          trigger: "cron",
          createdAt: NOW,
          model: "claude",
        });
        runLog.completeRun(seq, {
          status: i === 5 ? "error" : "done",
          doneAt: NOW + 100,
          durationMs: 100,
          stepResults: [],
          ...(i === 5 && { errorMessage: "step failed" }),
        });
      }

      const suggestions = computeAutomationSuggestions({
        activityLog: new ActivityLog(),
        recipeRunLog: runLog,
        listToolNamesFn: () => [],
      });
      expect(
        suggestions.find((s) => s.kind === "recipe_trust_graduation"),
      ).toBeUndefined();
    });

    it("does NOT flag a recipe below the run-count threshold", () => {
      const runLog = new RecipeRunLog({ dir: tmpDir });
      for (let i = 0; i < 9; i++) {
        const seq = runLog.startRun({
          taskId: `t-${i}`,
          recipeName: "tooFresh",
          trigger: "cron",
          createdAt: NOW,
          model: "claude",
        });
        runLog.completeRun(seq, {
          status: "done",
          doneAt: NOW + 100,
          durationMs: 100,
          stepResults: [],
        });
      }

      const suggestions = computeAutomationSuggestions({
        activityLog: new ActivityLog(),
        recipeRunLog: runLog,
        listToolNamesFn: () => [],
      });
      expect(
        suggestions.find((s) => s.kind === "recipe_trust_graduation"),
      ).toBeUndefined();
    });

    it("ranks multiple graduation candidates by run count (most-frequent first)", () => {
      const runLog = new RecipeRunLog({ dir: tmpDir });
      for (let i = 0; i < 12; i++) {
        const seq = runLog.startRun({
          taskId: `quiet-${i}`,
          recipeName: "quiet",
          trigger: "manual",
          createdAt: NOW,
          model: "claude",
        });
        runLog.completeRun(seq, {
          status: "done",
          doneAt: NOW + 100,
          durationMs: 100,
          stepResults: [],
        });
      }
      for (let i = 0; i < 30; i++) {
        const seq = runLog.startRun({
          taskId: `busy-${i}`,
          recipeName: "busy",
          trigger: "manual",
          createdAt: NOW,
          model: "claude",
        });
        runLog.completeRun(seq, {
          status: "done",
          doneAt: NOW + 100,
          durationMs: 100,
          stepResults: [],
        });
      }

      const suggestions = computeAutomationSuggestions({
        activityLog: new ActivityLog(),
        recipeRunLog: runLog,
        listToolNamesFn: () => [],
      });
      const graduations = suggestions.filter(
        (s) => s.kind === "recipe_trust_graduation",
      );
      expect(graduations).toHaveLength(2);
      expect(graduations[0]?.details?.recipeName).toBe("busy");
      expect(graduations[1]?.details?.recipeName).toBe("quiet");
    });
  });

  describe("composition", () => {
    it("returns an empty array for empty inputs", () => {
      const suggestions = computeAutomationSuggestions({
        activityLog: new ActivityLog(),
        listToolNamesFn: () => [],
      });
      expect(suggestions).toEqual([]);
    });

    it("returns a deterministic order across runs", () => {
      const log = new ActivityLog();
      for (let i = 0; i < 5; i++) {
        const t = new Date(NOW - i * 60 * 1000).toISOString();
        recordAt(log, "Read", t);
        recordAt(log, "gitDiff", new Date(Date.parse(t) + 5000).toISOString());
      }
      const a = computeAutomationSuggestions({
        activityLog: log,
        listToolNamesFn: () => ["Read", "gitDiff", "WebFetch"],
        coOccurrenceMinCount: 5,
      });
      const b = computeAutomationSuggestions({
        activityLog: log,
        listToolNamesFn: () => ["Read", "gitDiff", "WebFetch"],
        coOccurrenceMinCount: 5,
      });
      expect(b).toEqual(a);
    });
  });
});
