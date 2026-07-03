import { describe, expect, it } from "vitest";
import {
  computeAvgDuration,
  computeSuccessPct,
  type RunHealthRecord,
} from "../recipeRunHealth";

describe("computeSuccessPct", () => {
  it("undefined/empty runs → null", () => {
    expect(computeSuccessPct(undefined)).toBeNull();
    expect(computeSuccessPct([])).toBeNull();
  });

  it("all runs in-flight (no settled runs) → null", () => {
    const runs: RunHealthRecord[] = [
      { status: "running" },
      { status: "queued" },
      { status: "pending" },
    ];
    expect(computeSuccessPct(runs)).toBeNull();
  });

  it("all success → 100", () => {
    const runs: RunHealthRecord[] = [
      { status: "done" },
      { status: "success" },
    ];
    expect(computeSuccessPct(runs)).toBe(100);
  });

  it("mixed success/error → percentage over settled runs only", () => {
    const runs: RunHealthRecord[] = [
      { status: "done" },
      { status: "error" },
      { status: "running" }, // excluded from denominator
      { status: "success" },
      { status: "error" },
    ];
    // settled = done, error, success, error → 4; ok = done, success → 2
    expect(computeSuccessPct(runs)).toBe(50);
  });

  it("single successful run → 100", () => {
    expect(computeSuccessPct([{ status: "done" }])).toBe(100);
  });

  it("single failed run → 0", () => {
    expect(computeSuccessPct([{ status: "error" }])).toBe(0);
  });
});

describe("computeAvgDuration", () => {
  it("undefined/empty runs → undefined", () => {
    expect(computeAvgDuration(undefined)).toBeUndefined();
    expect(computeAvgDuration([])).toBeUndefined();
  });

  it("no runs with valid duration → undefined", () => {
    const runs: RunHealthRecord[] = [
      { status: "running" },
      { status: "done", durationMs: 0 },
      { status: "done", durationMs: -5 },
    ];
    expect(computeAvgDuration(runs)).toBeUndefined();
  });

  it("averages only positive durations", () => {
    const runs: RunHealthRecord[] = [
      { status: "done", durationMs: 1000 },
      { status: "done", durationMs: 3000 },
      { status: "error" }, // no durationMs, excluded
    ];
    expect(computeAvgDuration(runs)).toBe(2000);
  });

  it("single run with duration → that duration", () => {
    expect(computeAvgDuration([{ status: "done", durationMs: 500 }])).toBe(500);
  });
});
