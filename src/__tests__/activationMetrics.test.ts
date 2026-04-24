import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analyticsPrefModule = await vi.hoisted(async () => ({
  getAnalyticsPref: vi.fn<() => boolean | null>(() => null),
}));

vi.mock("../analyticsPrefs.js", () => analyticsPrefModule);

const {
  computeSummary,
  loadMetrics,
  recordApprovalCompleted,
  recordApprovalPrompted,
  recordRecipeRun,
} = await import("../activationMetrics.js");

describe("activationMetrics", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-metrics-"));
    analyticsPrefModule.getAnalyticsPref.mockReturnValue(null);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loadMetrics returns an empty record when the file is missing", () => {
    const now = 1_700_000_000_000;
    const metrics = loadMetrics(tmp, now);
    expect(metrics).toEqual({
      installedAt: now,
      firstRecipeRunAt: null,
      recipeRunsTotal: 0,
      recipeRunsByDay: {},
      approvalsPrompted: 0,
      approvalsCompleted: 0,
    });
  });

  it("recordRecipeRun sets installedAt + firstRecipeRunAt on first call", () => {
    const now = Date.UTC(2026, 3, 15, 10, 0, 0);
    recordRecipeRun(tmp, now);
    const metrics = loadMetrics(tmp, now);
    expect(metrics.installedAt).toBe(now);
    expect(metrics.firstRecipeRunAt).toBe(now);
    expect(metrics.recipeRunsTotal).toBe(1);
    expect(metrics.recipeRunsByDay).toEqual({ "2026-04-15": 1 });
  });

  it("recordRecipeRun preserves firstRecipeRunAt across subsequent runs", () => {
    const first = Date.UTC(2026, 3, 15, 10, 0, 0);
    const later = Date.UTC(2026, 3, 16, 11, 0, 0);
    recordRecipeRun(tmp, first);
    recordRecipeRun(tmp, later);
    recordRecipeRun(tmp, later);

    const metrics = loadMetrics(tmp, later);
    expect(metrics.firstRecipeRunAt).toBe(first);
    expect(metrics.recipeRunsTotal).toBe(3);
    expect(metrics.recipeRunsByDay).toEqual({
      "2026-04-15": 1,
      "2026-04-16": 2,
    });
  });

  it("recordRecipeRun trims the per-day map to the last 14 days", () => {
    for (let i = 0; i < 20; i++) {
      const ts = Date.UTC(2026, 3, 1 + i, 10, 0, 0);
      recordRecipeRun(tmp, ts);
    }
    const metrics = loadMetrics(tmp);
    expect(Object.keys(metrics.recipeRunsByDay)).toHaveLength(14);
    expect(metrics.recipeRunsByDay["2026-04-01"]).toBeUndefined();
    expect(metrics.recipeRunsByDay["2026-04-20"]).toBe(1);
  });

  it("recordApprovalPrompted and recordApprovalCompleted increment independently", () => {
    recordApprovalPrompted(tmp);
    recordApprovalPrompted(tmp);
    recordApprovalPrompted(tmp);
    recordApprovalCompleted(tmp);

    const metrics = loadMetrics(tmp);
    expect(metrics.approvalsPrompted).toBe(3);
    expect(metrics.approvalsCompleted).toBe(1);
  });

  it("record operations are no-ops when analytics pref is explicitly false", () => {
    analyticsPrefModule.getAnalyticsPref.mockReturnValue(false);
    recordRecipeRun(tmp);
    recordApprovalPrompted(tmp);
    recordApprovalCompleted(tmp);

    const file = path.join(tmp, "telemetry.json");
    expect(() => statSync(file)).toThrow();
  });

  it("writes the telemetry file with 0o600 permissions", () => {
    recordRecipeRun(tmp);
    const file = path.join(tmp, "telemetry.json");
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tolerates a malformed telemetry file by returning fresh empty state", () => {
    writeFileSync(path.join(tmp, "telemetry.json"), "{ not json");
    const metrics = loadMetrics(tmp, 1_700_000_000_000);
    expect(metrics.recipeRunsTotal).toBe(0);
    expect(metrics.firstRecipeRunAt).toBeNull();
  });

  it("coerceMetrics drops invalid per-day keys and negative counts", () => {
    writeFileSync(
      path.join(tmp, "telemetry.json"),
      JSON.stringify({
        installedAt: 1,
        firstRecipeRunAt: null,
        recipeRunsTotal: -5,
        recipeRunsByDay: { "2026-04-15": 2, bogus: 3, "2026-99-99": 4 },
        approvalsPrompted: 1.7,
        approvalsCompleted: "nope",
      }),
    );
    const metrics = loadMetrics(tmp);
    expect(metrics.recipeRunsTotal).toBe(0);
    expect(metrics.recipeRunsByDay).toEqual({ "2026-04-15": 2 });
    expect(metrics.approvalsPrompted).toBe(1);
    expect(metrics.approvalsCompleted).toBe(0);
  });

  it("computeSummary derives time-to-first and rolling 7-day activity", () => {
    const install = Date.UTC(2026, 3, 10, 0, 0, 0);
    const first = Date.UTC(2026, 3, 12, 0, 0, 0);
    const now = Date.UTC(2026, 3, 20, 12, 0, 0);

    writeFileSync(
      path.join(tmp, "telemetry.json"),
      JSON.stringify({
        installedAt: install,
        firstRecipeRunAt: first,
        recipeRunsTotal: 5,
        recipeRunsByDay: {
          "2026-04-12": 1,
          "2026-04-15": 2,
          "2026-04-18": 1,
          "2026-04-20": 1,
        },
        approvalsPrompted: 10,
        approvalsCompleted: 7,
      }),
    );
    const summary = computeSummary(loadMetrics(tmp, now), now);
    expect(summary.timeToFirstRecipeRunMs).toBe(first - install);
    expect(summary.recipeRunsLast7Days).toBe(4);
    expect(summary.activeDaysLast7).toBe(3);
    expect(summary.approvalCompletionRate).toBeCloseTo(0.7);
  });

  it("computeSummary returns null approvalCompletionRate when none prompted", () => {
    const summary = computeSummary(loadMetrics(tmp), Date.now());
    expect(summary.approvalCompletionRate).toBeNull();
    expect(summary.timeToFirstRecipeRunMs).toBeNull();
  });
});
