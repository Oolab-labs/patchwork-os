import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "../../activityTypes.js";
import {
  computeCoOccurrence,
  computePercentiles,
  computeStats,
  computeWindowedStats,
} from "../activityAnalytics.js";

function entry(
  id: number,
  tool: string,
  durationMs: number,
  status: "success" | "error" = "success",
  timestamp?: string,
): ActivityEntry {
  return {
    id,
    tool,
    durationMs,
    status,
    timestamp: timestamp ?? new Date(id * 1000).toISOString(),
  };
}

describe("computeStats", () => {
  it("returns empty record for no entries", () => {
    expect(computeStats([])).toEqual({});
  });

  it("computes count, avgDurationMs, errors for single tool", () => {
    const entries = [
      entry(1, "toolA", 100),
      entry(2, "toolA", 200),
      entry(3, "toolA", 300, "error"),
    ];
    const result = computeStats(entries);
    expect(result.toolA).toEqual({ count: 3, avgDurationMs: 200, errors: 1 });
  });

  it("handles multiple tools independently", () => {
    const entries = [entry(1, "toolA", 100), entry(2, "toolB", 50, "error")];
    const result = computeStats(entries);
    expect(result.toolA).toEqual({ count: 1, avgDurationMs: 100, errors: 0 });
    expect(result.toolB).toEqual({ count: 1, avgDurationMs: 50, errors: 1 });
  });

  it("does not mutate input array", () => {
    const entries = [entry(1, "toolA", 100)];
    const snapshot = [...entries];
    computeStats(entries);
    expect(entries).toEqual(snapshot);
  });
});

describe("computePercentiles", () => {
  it("returns empty record for no tools", () => {
    expect(computePercentiles(new Map())).toEqual({});
  });

  it("omits tools with fewer than 2 samples", () => {
    const samples = new Map([["toolA", [100]]]);
    expect(computePercentiles(samples)).toEqual({});
  });

  it("computes p50/p95/p99 for a tool with enough samples", () => {
    const data = Array.from({ length: 100 }, (_, i) => i + 1);
    const samples = new Map([["toolA", data]]);
    const result = computePercentiles(samples);
    expect(result.toolA).toBeDefined();
    expect(result.toolA!.p50).toBeGreaterThan(0);
    expect(result.toolA!.p95).toBeGreaterThanOrEqual(result.toolA!.p50);
    expect(result.toolA!.p99).toBeGreaterThanOrEqual(result.toolA!.p95);
    expect(result.toolA!.sampleCount).toBe(100);
  });

  it("does not mutate original samples array", () => {
    const arr = [10, 5, 20, 1];
    const snapshot = [...arr];
    const samples = new Map([["toolA", arr]]);
    computePercentiles(samples);
    expect(arr).toEqual(snapshot);
  });
});

describe("computeCoOccurrence", () => {
  it("returns empty array for no entries", () => {
    expect(computeCoOccurrence([], 60_000)).toEqual([]);
  });

  it("returns empty array for single entry", () => {
    expect(computeCoOccurrence([entry(1, "toolA", 100)], 60_000)).toEqual([]);
  });

  it("skips self-pairs", () => {
    const now = Date.now();
    const entries = [
      entry(1, "toolA", 100, "success", new Date(now).toISOString()),
      entry(2, "toolA", 100, "success", new Date(now + 100).toISOString()),
    ];
    expect(computeCoOccurrence(entries, 60_000)).toEqual([]);
  });

  it("counts co-occurring pairs within window", () => {
    const now = 1_700_000_000_000;
    const entries = [
      entry(1, "toolA", 10, "success", new Date(now).toISOString()),
      entry(2, "toolB", 10, "success", new Date(now + 1000).toISOString()),
      entry(3, "toolA", 10, "success", new Date(now + 2000).toISOString()),
      entry(4, "toolB", 10, "success", new Date(now + 3000).toISOString()),
    ];
    const result = computeCoOccurrence(entries, 60_000);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.pair).toBe("toolA|toolB");
    expect(result[0]!.count).toBeGreaterThan(0);
  });

  it("excludes pairs outside window", () => {
    const now = 1_700_000_000_000;
    const entries = [
      entry(1, "toolA", 10, "success", new Date(now).toISOString()),
      entry(2, "toolB", 10, "success", new Date(now + 999_999).toISOString()),
    ];
    // 1s window — toolB is 1000s later, outside
    expect(computeCoOccurrence(entries, 1_000)).toEqual([]);
  });

  it("sorts results by count desc", () => {
    const now = 1_700_000_000_000;
    const entries: ActivityEntry[] = [];
    // toolA|toolB appears 3 times, toolA|toolC appears once
    for (let i = 0; i < 3; i++) {
      entries.push(
        entry(
          i * 2 + 1,
          "toolA",
          10,
          "success",
          new Date(now + i * 10000).toISOString(),
        ),
      );
      entries.push(
        entry(
          i * 2 + 2,
          "toolB",
          10,
          "success",
          new Date(now + i * 10000 + 100).toISOString(),
        ),
      );
    }
    entries.push(
      entry(10, "toolA", 10, "success", new Date(now + 100000).toISOString()),
    );
    entries.push(
      entry(11, "toolC", 10, "success", new Date(now + 100100).toISOString()),
    );
    const result = computeCoOccurrence(entries, 5_000);
    expect(result[0]!.count).toBeGreaterThanOrEqual(result[1]?.count ?? 0);
  });

  it("respects maxPairs cap", () => {
    const now = 1_700_000_000_000;
    const entries: ActivityEntry[] = [];
    // Generate many distinct pairs
    for (let i = 0; i < 10; i++) {
      entries.push(
        entry(
          i * 2,
          `tool${i}`,
          10,
          "success",
          new Date(now + i * 100).toISOString(),
        ),
      );
      entries.push(
        entry(
          i * 2 + 1,
          `tool${i + 100}`,
          10,
          "success",
          new Date(now + i * 100 + 50).toISOString(),
        ),
      );
    }
    const result = computeCoOccurrence(entries, 60_000, 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });
});

describe("computeWindowedStats", () => {
  it("returns empty record when no entries", () => {
    expect(computeWindowedStats([], 60_000, Date.now())).toEqual({});
  });

  it("includes only entries within window", () => {
    const now = 1_700_000_000_000;
    // Entries MUST be in chronological ascending order (implementation reverse-scans)
    const entries = [
      entry(1, "toolB", 200, "success", new Date(now - 120_000).toISOString()),
      entry(2, "toolA", 100, "success", new Date(now - 5000).toISOString()),
    ];
    // 60s window — toolB is 120s old, outside
    const result = computeWindowedStats(entries, 60_000, now);
    expect(result.toolA).toBeDefined();
    expect(result.toolB).toBeUndefined();
  });

  it("computes errors within window", () => {
    const now = 1_700_000_000_000;
    const entries = [
      entry(1, "toolA", 100, "error", new Date(now - 1000).toISOString()),
      entry(2, "toolA", 200, "success", new Date(now - 2000).toISOString()),
    ];
    const result = computeWindowedStats(entries, 60_000, now);
    expect(result.toolA!.errors).toBe(1);
    expect(result.toolA!.count).toBe(2);
  });

  it("is deterministic — same now, same result", () => {
    const now = 1_700_000_000_000;
    const entries = [
      entry(1, "toolA", 100, "success", new Date(now - 1000).toISOString()),
    ];
    const r1 = computeWindowedStats(entries, 60_000, now);
    const r2 = computeWindowedStats(entries, 60_000, now);
    expect(r1).toEqual(r2);
  });
});
