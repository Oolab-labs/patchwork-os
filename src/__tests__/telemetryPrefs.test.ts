import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAnalyticsPref,
  getAnalyticsPrefsAll,
  getTelemetryPrefs,
  recordAnalyticsSent,
  setAnalyticsPref,
  setTelemetryPrefs,
} from "../analyticsPrefs.js";

// Each test runs in its own isolated CLAUDE_CONFIG_DIR so writes don't
// bleed into the real ~/.claude/ide/analytics.json.
let tmpDir: string;

function ideDir() {
  return path.join(tmpDir, "ide");
}
function prefsFile() {
  return path.join(ideDir(), "analytics.json");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tel-prefs-test-"));
  process.env.CLAUDE_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getTelemetryPrefs — fresh install (no file)", () => {
  it("returns all false when no file exists", () => {
    expect(getTelemetryPrefs()).toEqual({
      crashReports: false,
      usageStats: false,
      localDiagnostics: false,
    });
  });
});

describe("getTelemetryPrefs — v1 migration (enabled-only file)", () => {
  it("maps enabled:true → crashReports:true, usageStats:true, localDiagnostics:false", () => {
    fs.mkdirSync(ideDir(), { recursive: true });
    fs.writeFileSync(
      prefsFile(),
      JSON.stringify({ enabled: true, decidedAt: "2025-01-01T00:00:00.000Z" }),
    );
    expect(getTelemetryPrefs()).toEqual({
      crashReports: true,
      usageStats: true,
      localDiagnostics: false,
    });
  });

  it("maps enabled:false → all false", () => {
    fs.mkdirSync(ideDir(), { recursive: true });
    fs.writeFileSync(
      prefsFile(),
      JSON.stringify({ enabled: false, decidedAt: "2025-01-01T00:00:00.000Z" }),
    );
    expect(getTelemetryPrefs()).toEqual({
      crashReports: false,
      usageStats: false,
      localDiagnostics: false,
    });
  });
});

describe("setTelemetryPrefs — full and partial update", () => {
  it("writes and reads back full prefs", () => {
    setTelemetryPrefs({
      crashReports: true,
      usageStats: false,
      localDiagnostics: true,
    });
    expect(getTelemetryPrefs()).toEqual({
      crashReports: true,
      usageStats: false,
      localDiagnostics: true,
    });
  });

  it("partial update only changes supplied fields", () => {
    setTelemetryPrefs({
      crashReports: true,
      usageStats: true,
      localDiagnostics: true,
    });
    setTelemetryPrefs({ usageStats: false });
    expect(getTelemetryPrefs()).toEqual({
      crashReports: true,
      usageStats: false,
      localDiagnostics: true,
    });
  });
});

describe("legacy getAnalyticsPref / setAnalyticsPref", () => {
  it("returns null when no file exists", () => {
    expect(getAnalyticsPref()).toBeNull();
  });

  it("setAnalyticsPref(true) makes getAnalyticsPref() return true", () => {
    setAnalyticsPref(true);
    expect(getAnalyticsPref()).toBe(true);
  });

  it("setAnalyticsPref(true) sets crashReports + usageStats true", () => {
    setAnalyticsPref(true);
    const p = getTelemetryPrefs();
    expect(p.crashReports).toBe(true);
    expect(p.usageStats).toBe(true);
  });

  it("setAnalyticsPref(false) makes getAnalyticsPref() return false", () => {
    setAnalyticsPref(true);
    setAnalyticsPref(false);
    expect(getAnalyticsPref()).toBe(false);
  });
});

describe("recordAnalyticsSent", () => {
  it("is a no-op when no prefs file exists", () => {
    // Should not throw
    expect(() => recordAnalyticsSent()).not.toThrow();
  });

  it("writes lastSentAt after setAnalyticsPref(true)", () => {
    setAnalyticsPref(true);

    const before = Date.now();
    recordAnalyticsSent();
    const after = Date.now();

    const prefs = getAnalyticsPrefsAll();
    expect(prefs).not.toBeNull();
    expect(typeof prefs!.lastSentAt).toBe("string");

    const ts = new Date(prefs!.lastSentAt!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("preserves enabled state when recording lastSentAt", () => {
    setAnalyticsPref(false);
    recordAnalyticsSent();

    expect(getAnalyticsPref()).toBe(false);
    const prefs = getAnalyticsPrefsAll();
    expect(typeof prefs!.lastSentAt).toBe("string");
  });

  it("updates lastSentAt on repeated calls", () => {
    setAnalyticsPref(true);
    recordAnalyticsSent();
    const prefs1 = getAnalyticsPrefsAll();

    // Small delay to ensure timestamp advances
    const ts1 = new Date(prefs1!.lastSentAt!).getTime();

    // Force clock to advance by at least 1 ms
    const spin = Date.now() + 1;
    while (Date.now() < spin) {
      /* busy wait */
    }

    recordAnalyticsSent();
    const prefs2 = getAnalyticsPrefsAll();
    const ts2 = new Date(prefs2!.lastSentAt!).getTime();

    expect(ts2).toBeGreaterThanOrEqual(ts1);
  });
});
