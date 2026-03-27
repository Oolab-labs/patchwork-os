import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSummary } from "../../analyticsAggregator.js";
import { getAnalyticsPref, setAnalyticsPref } from "../../analyticsPrefs.js";

// ── analyticsAggregator ──────────────────────────────────────────────────────

describe("buildSummary", () => {
  it("returns empty toolStats for no entries", () => {
    const s = buildSummary([], 0, "1.0.0");
    expect(s.toolStats).toEqual([]);
    expect(s.bridgeVersion).toBe("1.0.0");
  });

  it("counts calls and errors per tool", () => {
    const entries = [
      { tool: "readFile", durationMs: 10, status: "success" as const },
      { tool: "readFile", durationMs: 20, status: "error" as const },
      { tool: "getDiagnostics", durationMs: 5, status: "success" as const },
    ];
    const s = buildSummary(entries, 1000, "2.0.0");
    const rf = s.toolStats.find((t) => t.tool === "readFile");
    expect(rf).toBeDefined();
    expect(rf!.calls).toBe(2);
    expect(rf!.errors).toBe(1);
    const diag = s.toolStats.find((t) => t.tool === "getDiagnostics");
    expect(diag!.calls).toBe(1);
    expect(diag!.errors).toBe(0);
  });

  it("computes p50 and p95 correctly", () => {
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const entries = durations.map((d) => ({
      tool: "readFile",
      durationMs: d,
      status: "success" as const,
    }));
    const s = buildSummary(entries, 5000, "1.0.0");
    const rf = s.toolStats[0]!;
    // p50 = index 5 of sorted [10..100] = 60
    expect(rf.p50Ms).toBe(60);
    // p95 = index 9 = 100
    expect(rf.p95Ms).toBe(100);
  });

  it("hashes unknown (plugin) tool names", () => {
    const entries = [
      {
        tool: "acmeCorp_deployProd",
        durationMs: 100,
        status: "success" as const,
      },
    ];
    const s = buildSummary(entries, 1000, "1.0.0");
    expect(s.toolStats[0]!.tool).toMatch(/^plugin:[0-9a-f]{8}$/);
    expect(s.toolStats[0]!.tool).not.toContain("acme");
  });

  it("sends built-in tool names verbatim", () => {
    const entries = [
      { tool: "getDiagnostics", durationMs: 5, status: "success" as const },
    ];
    const s = buildSummary(entries, 100, "1.0.0");
    expect(s.toolStats[0]!.tool).toBe("getDiagnostics");
  });

  it("sorts toolStats by call count descending", () => {
    const entries = [
      { tool: "readFile", durationMs: 10, status: "success" as const },
      { tool: "getDiagnostics", durationMs: 5, status: "success" as const },
      { tool: "getDiagnostics", durationMs: 5, status: "success" as const },
      { tool: "getDiagnostics", durationMs: 5, status: "success" as const },
    ];
    const s = buildSummary(entries, 1000, "1.0.0");
    expect(s.toolStats[0]!.tool).toBe("getDiagnostics");
    expect(s.toolStats[1]!.tool).toBe("readFile");
  });

  it("different plugin prefixes produce different hashes", () => {
    const entries = [
      { tool: "acme_tool", durationMs: 10, status: "success" as const },
      { tool: "beta_tool", durationMs: 10, status: "success" as const },
    ];
    const s = buildSummary(entries, 1000, "1.0.0");
    expect(s.toolStats[0]!.tool).not.toBe(s.toolStats[1]!.tool);
  });
});

// ── analyticsPrefs ───────────────────────────────────────────────────────────

describe("analyticsPrefs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-prefs-test-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no pref file exists", () => {
    expect(getAnalyticsPref()).toBeNull();
  });

  it("persists and reads back true", () => {
    setAnalyticsPref(true);
    expect(getAnalyticsPref()).toBe(true);
  });

  it("persists and reads back false", () => {
    setAnalyticsPref(false);
    expect(getAnalyticsPref()).toBe(false);
  });

  it("overwrites existing preference", () => {
    setAnalyticsPref(true);
    setAnalyticsPref(false);
    expect(getAnalyticsPref()).toBe(false);
  });

  it("creates file with 0o600 permissions", () => {
    setAnalyticsPref(true);
    const prefsFile = path.join(tmpDir, "ide", "analytics.json");
    const stat = fs.statSync(prefsFile);
    // Check owner read/write only (0o600)
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("returns null for corrupt JSON", () => {
    const prefsFile = path.join(tmpDir, "ide", "analytics.json");
    fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
    fs.writeFileSync(prefsFile, "not valid json");
    expect(getAnalyticsPref()).toBeNull();
  });
});
