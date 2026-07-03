import { describe, expect, it } from "vitest";
import { deriveRecipeStatus, type RecipeStatusInput } from "../recipeStatus";

const base: RecipeStatusInput = {
  enabled: true,
  trigger: "cron",
  hasRuns: true,
  lastOutcome: "ok",
  lastWhen: "2h ago",
  lastDuration: "42s",
  scheduleText: "Every day at 7:00",
  nextRunPhrase: "next in 14h",
  recentHalt: null,
  disconnectedConnectors: [],
};

describe("deriveRecipeStatus — medallion", () => {
  it("healthy → green, no needs rows", () => {
    const v = deriveRecipeStatus(base);
    expect(v.medallion.tone).toBe("ok");
    expect(v.medallion.title).toBe("Working fine");
    expect(v.medallion.sentence).toContain("Ran 2h ago in 42s.");
    expect(v.medallion.sentence).toContain("Every day at 7:00");
    expect(v.medallion.sentence).toContain("next in 14h");
    expect(v.needs).toEqual([]);
  });

  it("paused wins over everything, muted tone", () => {
    const v = deriveRecipeStatus({ ...base, enabled: false, recentHalt: "tool_error" });
    expect(v.medallion.tone).toBe("muted");
    expect(v.medallion.title).toBe("Paused");
    // …and a needs row nudges resume (non-manual trigger).
    expect(v.needs.some((n) => n.fix?.action === "resume")).toBe(true);
  });

  it("halted → red medallion + a needs row with a fix", () => {
    const v = deriveRecipeStatus({ ...base, lastOutcome: "err", recentHalt: "auth_failure", disconnectedConnectors: [] });
    expect(v.medallion.tone).toBe("err");
    expect(v.medallion.title).toBe("Stopped — needs attention");
    expect(v.medallion.sentence).toMatch(/can't sign in/i);
    const row = v.needs.find((n) => n.key.startsWith("halt:"));
    expect(row?.fix?.action).toBe("reconnect");
  });

  it("disconnected connector → amber + a connect row; a redundant auth halt row is suppressed", () => {
    const v = deriveRecipeStatus({
      ...base,
      lastOutcome: "err",
      recentHalt: "auth_failure",
      disconnectedConnectors: ["GitHub"],
    });
    // err (halt) still drives the medallion, but the connector need is primary.
    expect(v.medallion.tone).toBe("err");
    const connectorRow = v.needs.find((n) => n.key === "connector:GitHub");
    expect(connectorRow?.fix?.action).toBe("connect-page");
    // The auth halt row is suppressed (the connector row covers the same cause).
    expect(v.needs.some((n) => n.key === "halt:auth_failure")).toBe(false);
  });

  it("running → ok tone, running title", () => {
    const v = deriveRecipeStatus({ ...base, lastOutcome: "running" });
    expect(v.medallion.title).toBe("Running now");
  });

  it("never run → muted onboarding sentence naming the schedule", () => {
    const v = deriveRecipeStatus({ ...base, hasRuns: false, lastOutcome: "other", lastWhen: undefined });
    expect(v.medallion.tone).toBe("muted");
    expect(v.medallion.title).toMatch(/hasn't run yet/);
    expect(v.medallion.sentence).toContain("Every day at 7:00");
  });

  it("partial failure → amber 'finished with problems'", () => {
    const v = deriveRecipeStatus({ ...base, lastOutcome: "warn" });
    expect(v.medallion.tone).toBe("warn");
    expect(v.medallion.title).toBe("Finished with problems");
  });

  it("rate_limited halt yields a no-button (wait) row", () => {
    const v = deriveRecipeStatus({ ...base, lastOutcome: "err", recentHalt: "rate_limited" });
    const row = v.needs.find((n) => n.key === "halt:rate_limited");
    expect(row).toBeTruthy();
    expect(row?.fix).toBeUndefined();
  });

  it("no jargon in medallion/needs sentences by default", () => {
    const banned = /cron|halt|disposition|actionClass|L[0-4]\b|expect:/;
    for (const input of [
      base,
      { ...base, enabled: false },
      { ...base, lastOutcome: "err" as const, recentHalt: "tool_error" as const },
      { ...base, hasRuns: false },
    ]) {
      const v = deriveRecipeStatus(input);
      expect(v.medallion.sentence).not.toMatch(banned);
      for (const n of v.needs) expect(n.sentence).not.toMatch(banned);
    }
  });
});
