import { describe, expect, it } from "vitest";
import type { RunRecord } from "../shadowRun.js";
import { destructiveToolClassifier, runShadowScan } from "../shadowRun.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    recipeName: "test-recipe",
    toolName: "readFile",
    args: {},
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── runShadowScan ─────────────────────────────────────────────────────────────

describe("runShadowScan", () => {
  it("counts scanned and reclassified correctly for 3 runs with 1 reclassified", async () => {
    const runs: RunRecord[] = [
      makeRun({ id: "r1", toolName: "readFile" }),
      makeRun({ id: "r2", toolName: "deleteFile" }),
      makeRun({ id: "r3", toolName: "getDocumentSymbols" }),
    ];

    const result = await runShadowScan({
      loadPastRuns: async () => runs,
      classifier: destructiveToolClassifier,
    });

    expect(result.scanned).toBe(3);
    expect(result.reclassified).toBe(1);
    expect(result.classifications).toHaveLength(3);
    const reclassified = result.classifications.filter((c) => c.reclassified);
    expect(reclassified).toHaveLength(1);
    expect(reclassified[0]!.runId).toBe("r2");
  });

  it("since filter excludes runs before the cutoff", async () => {
    const runs: RunRecord[] = [
      makeRun({ id: "old", timestamp: "2025-12-31T23:59:59.000Z" }),
      makeRun({ id: "new", timestamp: "2026-02-01T00:00:00.000Z" }),
    ];

    const result = await runShadowScan({
      loadPastRuns: async () => runs,
      classifier: destructiveToolClassifier,
      since: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result.scanned).toBe(1);
    expect(result.classifications[0]!.runId).toBe("new");
  });

  it("limit caps result count", async () => {
    const runs: RunRecord[] = Array.from({ length: 10 }, (_, i) =>
      makeRun({ id: `r${i}` }),
    );

    const result = await runShadowScan({
      loadPastRuns: async () => runs,
      classifier: destructiveToolClassifier,
      limit: 3,
    });

    expect(result.scanned).toBe(3);
    expect(result.classifications).toHaveLength(3);
  });

  it("loadPastRuns throwing returns graceful error result without propagating", async () => {
    const result = await runShadowScan({
      loadPastRuns: async () => {
        throw new Error("disk read failed");
      },
      classifier: destructiveToolClassifier,
    });

    expect(result.scanned).toBe(0);
    expect(result.reclassified).toBe(0);
    expect(result.classifications).toEqual([]);
    expect(result.summary).toContain("disk read failed");
  });

  it("empty run set returns scanned: 0, reclassified: 0", async () => {
    const result = await runShadowScan({
      loadPastRuns: async () => [],
      classifier: destructiveToolClassifier,
    });

    expect(result.scanned).toBe(0);
    expect(result.reclassified).toBe(0);
    expect(result.classifications).toEqual([]);
  });

  it("summary string is non-empty", async () => {
    const result = await runShadowScan({
      loadPastRuns: async () => [makeRun({ id: "r1" })],
      classifier: destructiveToolClassifier,
    });

    expect(result.summary.length).toBeGreaterThan(0);
  });
});

// ── destructiveToolClassifier ─────────────────────────────────────────────────

describe("destructiveToolClassifier", () => {
  it("flags deleteFile as review with reason", () => {
    const run = makeRun({ id: "r1", toolName: "deleteFile" });
    const result = destructiveToolClassifier(run);

    expect(result.newTier).toBe("review");
    expect(result.reclassified).toBe(true);
    expect(result.reason).toContain("deleteFile");
    expect(result.previousTier).toBe("safe");
  });

  it("flags runInTerminal as review", () => {
    const run = makeRun({ id: "r2", toolName: "runInTerminal" });
    const result = destructiveToolClassifier(run);

    expect(result.newTier).toBe("review");
    expect(result.reclassified).toBe(true);
  });

  it("flags searchAndReplace as review", () => {
    const run = makeRun({ id: "r3", toolName: "searchAndReplace" });
    const result = destructiveToolClassifier(run);

    expect(result.newTier).toBe("review");
    expect(result.reclassified).toBe(true);
  });

  it("leaves safe tools as safe with no reason", () => {
    const run = makeRun({ id: "r4", toolName: "readFile" });
    const result = destructiveToolClassifier(run);

    expect(result.newTier).toBe("safe");
    expect(result.reclassified).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("populates runId, recipeName, toolName from the run", () => {
    const run = makeRun({
      id: "my-id",
      recipeName: "my-recipe",
      toolName: "deleteFile",
    });
    const result = destructiveToolClassifier(run);

    expect(result.runId).toBe("my-id");
    expect(result.recipeName).toBe("my-recipe");
    expect(result.toolName).toBe("deleteFile");
  });
});
