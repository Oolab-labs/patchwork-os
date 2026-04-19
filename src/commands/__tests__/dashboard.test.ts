import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countRecipes,
  type DashboardData,
  loadInboxItems,
  loadRecentRuns,
  type RunEntry,
  renderDashboard,
} from "../dashboard.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-dash-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── loadRecentRuns ────────────────────────────────────────────────────────────

describe("loadRecentRuns", () => {
  it("returns empty array when runs.jsonl missing", () => {
    expect(loadRecentRuns(tmp)).toEqual([]);
  });

  it("parses valid JSONL entries", () => {
    const entries: RunEntry[] = [
      {
        seq: 1,
        recipeName: "daily-status",
        status: "done",
        createdAt: 1000,
        durationMs: 5000,
      },
      {
        seq: 2,
        recipeName: "ambient-journal",
        status: "error",
        createdAt: 2000,
      },
    ];
    writeFileSync(
      path.join(tmp, "runs.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n"),
    );
    const runs = loadRecentRuns(tmp, 10);
    expect(runs).toHaveLength(2);
    // most recent first
    expect(runs[0]!.seq).toBe(2);
  });

  it("skips malformed lines", () => {
    writeFileSync(
      path.join(tmp, "runs.jsonl"),
      '{"seq":1,"status":"done","recipeName":"ok"}\nnot-json\n{"seq":3,"status":"done","recipeName":"also-ok"}\n',
    );
    const runs = loadRecentRuns(tmp, 10);
    expect(runs.map((r) => r.seq)).toContain(1);
    expect(runs.map((r) => r.seq)).toContain(3);
  });

  it("respects limit", () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ seq: i + 1, status: "done", createdAt: i * 1000 }),
    );
    writeFileSync(path.join(tmp, "runs.jsonl"), lines.join("\n"));
    const runs = loadRecentRuns(tmp, 5);
    expect(runs).toHaveLength(5);
  });
});

// ── loadInboxItems ────────────────────────────────────────────────────────────

describe("loadInboxItems", () => {
  it("returns empty array when inbox missing", () => {
    expect(loadInboxItems(tmp)).toEqual([]);
  });

  it("lists items with preview", () => {
    const inboxDir = path.join(tmp, "inbox");
    mkdirSync(inboxDir);
    writeFileSync(
      path.join(inboxDir, "failing-tests.md"),
      "# Failures\nTest A failed\nTest B failed\n",
    );
    writeFileSync(
      path.join(inboxDir, "daily-status.md"),
      "# Status\nAll good\n",
    );
    const items = loadInboxItems(tmp);
    expect(items).toHaveLength(2);
    expect(items[0]!.preview).toBeTruthy();
  });

  it("assigns sequential index starting at 1", () => {
    const inboxDir = path.join(tmp, "inbox");
    mkdirSync(inboxDir);
    writeFileSync(path.join(inboxDir, "a.md"), "a");
    writeFileSync(path.join(inboxDir, "b.md"), "b");
    const items = loadInboxItems(tmp);
    expect(items.map((i) => i.index)).toContain(1);
    expect(items.map((i) => i.index)).toContain(2);
  });
});

// ── countRecipes ──────────────────────────────────────────────────────────────

describe("countRecipes", () => {
  it("returns 0 when recipes dir missing", () => {
    expect(countRecipes(tmp)).toBe(0);
  });

  it("counts yaml, yml, json but not .permissions.json", () => {
    const recipesDir = path.join(tmp, "recipes");
    mkdirSync(recipesDir);
    writeFileSync(path.join(recipesDir, "a.yaml"), "name: a");
    writeFileSync(path.join(recipesDir, "b.yml"), "name: b");
    writeFileSync(path.join(recipesDir, "c.json"), "{}");
    writeFileSync(path.join(recipesDir, "c.json.permissions.json"), "{}");
    expect(countRecipes(tmp)).toBe(3);
  });
});

// ── renderDashboard ───────────────────────────────────────────────────────────

describe("renderDashboard", () => {
  const BASE: DashboardData = {
    version: "0.2.0-alpha.0",
    recipeCount: 5,
    recentRuns: [],
    inboxItems: [],
  };
  const NOW = new Date("2026-04-18T12:00:00Z");

  it("renders header with version and recipe count", () => {
    const out = renderDashboard(BASE, NOW);
    expect(out).toContain("Patchwork OS");
    expect(out).toContain("0.2.0-alpha.0");
    expect(out).toContain("5");
  });

  it("shows empty-state message when no runs", () => {
    const out = renderDashboard(BASE, NOW);
    expect(out).toContain("No runs yet");
  });

  it("renders run entries with status badges", () => {
    const data: DashboardData = {
      ...BASE,
      recentRuns: [
        {
          seq: 1,
          recipeName: "daily-status",
          status: "done",
          createdAt: NOW.getTime() - 60_000,
          durationMs: 5000,
        },
        {
          seq: 2,
          recipeName: "watch-failing-tests",
          status: "error",
          createdAt: NOW.getTime() - 120_000,
        },
      ],
    };
    const out = renderDashboard(data, NOW);
    expect(out).toContain("daily-status");
    expect(out).toContain("done");
    expect(out).toContain("watch-failing-tests");
    expect(out).toContain("error");
  });

  it("renders inbox items with index and filename", () => {
    const data: DashboardData = {
      ...BASE,
      inboxItems: [
        {
          index: 1,
          filename: "failing-tests.md",
          fullPath: "/tmp/failing-tests.md",
          mtime: NOW.getTime() - 300_000,
          preview: "3 tests failed",
        },
        {
          index: 2,
          filename: "stale-branches.md",
          fullPath: "/tmp/stale-branches.md",
          mtime: NOW.getTime() - 600_000,
          preview: "old-branch",
        },
      ],
    };
    const out = renderDashboard(data, NOW);
    expect(out).toContain("failing-tests.md");
    expect(out).toContain("stale-branches.md");
    expect(out).toContain("3 tests failed");
    expect(out).toContain("INBOX");
  });

  it("shows empty inbox message when inbox is empty", () => {
    const out = renderDashboard(BASE, NOW);
    expect(out).toContain("Empty");
  });

  it("includes RECENT section header", () => {
    const out = renderDashboard(BASE, NOW);
    expect(out).toContain("RECENT");
  });
});
