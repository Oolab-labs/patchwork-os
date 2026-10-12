import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../../patchworkConfig.js";
import { RecipeScheduler } from "../scheduler.js";

/**
 * `nextRunTimes()` reports, per scheduled recipe, the instant the scheduler
 * itself will fire it next — computed by the same cron job that fires, in the
 * zone it was registered with. A dashboard shows this as "Next run".
 */

// 2026-10-12T00:00:00Z is 03:00 in Africa/Nairobi (UTC+3, no DST).
const NOW = Date.parse("2026-10-12T00:00:00.000Z");

describe("RecipeScheduler.nextRunTimes", () => {
  let tmp: string;
  let home: string;
  const prevHome = process.env.PATCHWORK_HOME;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-nextrun-"));
    home = path.join(tmp, ".patchwork");
    mkdirSync(home, { recursive: true });
    process.env.PATCHWORK_HOME = home;
    clearConfigCache();
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.PATCHWORK_HOME;
    else process.env.PATCHWORK_HOME = prevHome;
    clearConfigCache();
    rmSync(tmp, { recursive: true, force: true });
  });

  function recipesDir(): string {
    const dir = path.join(tmp, "recipes");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeRecipe(
    dir: string,
    name: string,
    trigger: { type: string; schedule?: string },
  ): void {
    writeFileSync(
      path.join(dir, `${name}.json`),
      JSON.stringify({
        name,
        version: "1",
        trigger,
        steps: [{ id: "main", agent: true, prompt: `run ${name}` }],
      }),
    );
  }

  function makeScheduler(
    dir: string,
    extra: { timezone?: string; disabledRecipes?: string[] } = {},
  ): RecipeScheduler {
    return new RecipeScheduler({
      recipesDir: dir,
      enqueue: () => "tid",
      disabledRecipes: extra.disabledRecipes ?? [],
      claim: { claimsDir: path.join(tmp, "claims") },
      ...(extra.timezone !== undefined ? { timezone: extra.timezone } : {}),
    });
  }

  it("cron job in a non-UTC zone yields the next instant in that zone", () => {
    const dir = recipesDir();
    writeRecipe(dir, "morning", { type: "cron", schedule: "0 9 * * *" });
    const s = makeScheduler(dir, { timezone: "Africa/Nairobi" });
    s.start();
    try {
      // 09:00 Nairobi on the same day = 06:00Z.
      expect(s.nextRunTimes().get("morning")).toBe(
        Date.parse("2026-10-12T06:00:00.000Z"),
      );
    } finally {
      s.stop();
    }
  });

  it("@every 5m yields start + 5m, then last fire + 5m", () => {
    const dir = recipesDir();
    writeRecipe(dir, "poll", { type: "cron", schedule: "@every 5m" });
    const s = makeScheduler(dir);
    s.start();
    try {
      expect(s.nextRunTimes().get("poll")).toBe(NOW + 5 * 60_000);
      vi.advanceTimersByTime(5 * 60_000);
      expect(s.nextRunTimes().get("poll")).toBe(NOW + 10 * 60_000);
    } finally {
      s.stop();
    }
  });

  it("disabled and manual recipes have no next run", () => {
    const dir = recipesDir();
    writeRecipe(dir, "off", { type: "cron", schedule: "0 9 * * *" });
    writeRecipe(dir, "by-hand", { type: "manual" });
    const s = makeScheduler(dir, {
      timezone: "UTC",
      disabledRecipes: ["off"],
    });
    s.start();
    try {
      const next = s.nextRunTimes();
      expect(next.has("off")).toBe(false);
      expect(next.has("by-hand")).toBe(false);
      expect(next.size).toBe(0);
    } finally {
      s.stop();
    }
  });

  it("is empty after stop()", () => {
    const dir = recipesDir();
    writeRecipe(dir, "morning", { type: "cron", schedule: "0 9 * * *" });
    writeRecipe(dir, "poll", { type: "cron", schedule: "@every 5m" });
    const s = makeScheduler(dir, { timezone: "UTC" });
    s.start();
    s.stop();
    expect(s.nextRunTimes().size).toBe(0);
  });

  it("moves when the configured zone changes and restart() runs", () => {
    const dir = recipesDir();
    writeRecipe(dir, "morning", { type: "cron", schedule: "0 9 * * *" });
    // No injected timezone: the scheduler reads recipes.timezone (default UTC).
    const s = makeScheduler(dir);
    s.start();
    try {
      expect(s.nextRunTimes().get("morning")).toBe(
        Date.parse("2026-10-12T09:00:00.000Z"),
      );
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ recipes: { timezone: "Africa/Nairobi" } }),
      );
      clearConfigCache();
      s.restart();
      expect(s.nextRunTimes().get("morning")).toBe(
        Date.parse("2026-10-12T06:00:00.000Z"),
      );
    } finally {
      s.stop();
    }
  });
});
