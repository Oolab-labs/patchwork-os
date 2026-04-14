import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock individual test runners so runTests.ts doesn't invoke real processes
vi.mock("../testRunners/vitestJest.js", () => ({
  vitestRunner: {
    name: "vitest",
    cacheTtl: 30_000,
    detect: vi.fn(() => true),
    run: vi.fn(async () => [
      {
        name: "a passes",
        status: "passed",
        source: "vitest",
        file: "a.test.ts",
        line: 1,
        durationMs: 10,
      },
      {
        name: "b fails",
        status: "failed",
        source: "vitest",
        file: "b.test.ts",
        line: 5,
        durationMs: 5,
        message: "Expected 1",
      },
    ]),
  },
  jestRunner: {
    name: "jest",
    cacheTtl: 30_000,
    detect: vi.fn(() => false),
    run: vi.fn(async () => []),
  },
}));

vi.mock("../testRunners/pytest.js", () => ({
  pytestRunner: {
    name: "pytest",
    cacheTtl: 30_000,
    detect: vi.fn(() => false),
    run: vi.fn(async () => []),
  },
}));

vi.mock("../testRunners/cargoTest.js", () => ({
  cargoTestRunner: {
    name: "cargo-test",
    cacheTtl: 30_000,
    detect: vi.fn(() => false),
    run: vi.fn(async () => []),
  },
}));

vi.mock("../testRunners/goTest.js", () => ({
  goTestRunner: {
    name: "go-test",
    cacheTtl: 30_000,
    detect: vi.fn(() => false),
    run: vi.fn(async () => []),
  },
}));

import { createRunTestsTool } from "../runTests.js";
import { vitestRunner } from "../testRunners/vitestJest.js";

const probes = {
  biome: false,
  eslint: false,
  tsc: false,
  cargo: false,
  go: false,
  pyright: false,
  ruff: false,
  node: true,
  npm: true,
  npx: true,
  git: true,
  gh: false,
  python: false,
  codex: false,
  vitest: true,
  jest: false,
  pytest: false,
} as any;

const ws = "/fake/ws";

beforeEach(() => vi.clearAllMocks());

describe("createRunTestsTool", () => {
  it("returns available:false when no probes provided", async () => {
    const tool = createRunTestsTool(ws); // no probes — runners empty
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.available).toBe(false);
    expect(data.runners).toEqual([]);
    expect(data.summary.total).toBe(0);
  });

  it("returns results from detected runners", async () => {
    const tool = createRunTestsTool(ws, probes);
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.available).toBe(true);
    expect(data.runners).toContain("vitest");
    expect(data.summary.total).toBe(2);
    expect(data.summary.passed).toBe(1);
    expect(data.summary.failed).toBe(1);
  });

  it("failures array contains only failed/errored results", async () => {
    const tool = createRunTestsTool(ws, probes);
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.failures).toHaveLength(1);
    expect(data.failures[0].name).toBe("b fails");
  });

  it("passes filter arg to runner", async () => {
    const tool = createRunTestsTool(ws, probes);
    await tool.handler({ filter: "someFilter" });
    expect(vi.mocked(vitestRunner.run)).toHaveBeenCalledWith(
      ws,
      "someFilter",
      undefined,
      undefined,
      undefined, // onLine — no progress fn provided
    );
  });

  it("returns error when named runner not found", async () => {
    const tool = createRunTestsTool(ws, probes);
    const result = await tool.handler({ runner: "nonexistent" });
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.available).toBe(true);
    expect(data.error).toContain("nonexistent");
    expect(data.runners).toContain("vitest");
  });

  it("filters to named runner when runner arg provided", async () => {
    const tool = createRunTestsTool(ws, probes);
    const result = await tool.handler({ runner: "vitest" });
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.runners).toEqual(["vitest"]);
    expect(data.summary.total).toBe(2);
  });

  it("noCache:true bypasses cache and re-runs", async () => {
    const tool = createRunTestsTool(ws, probes);
    // First call — populates cache
    await tool.handler({});
    vi.mocked(vitestRunner.run).mockClear();
    // Second call without noCache should use cache
    await tool.handler({});
    expect(vi.mocked(vitestRunner.run)).not.toHaveBeenCalled();
    // Third call with noCache:true — should re-run
    await tool.handler({ noCache: true });
    expect(vi.mocked(vitestRunner.run)).toHaveBeenCalledOnce();
  });

  it("caches results within TTL", async () => {
    const tool = createRunTestsTool(ws, probes);
    await tool.handler({});
    await tool.handler({});
    // Runner should only be called once (second call hits cache)
    expect(vi.mocked(vitestRunner.run)).toHaveBeenCalledTimes(1);
  });

  it("calls progress fn with 0 and 100", async () => {
    const tool = createRunTestsTool(ws, probes);
    const progress = vi.fn();
    await tool.handler({}, undefined, progress);
    expect(progress).toHaveBeenCalledWith(0, 100);
    expect(progress).toHaveBeenCalledWith(100, 100);
  });

  it("includes runnerErrors when a runner throws", async () => {
    vi.mocked(vitestRunner.run).mockRejectedValueOnce(
      new Error("runner crashed"),
    );
    const tool = createRunTestsTool(ws, probes);
    const result = await tool.handler({ noCache: true });
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.runnerErrors?.vitest).toContain("crashed");
  });

  it("does not include runnerErrors key when no errors", async () => {
    const tool = createRunTestsTool(ws, probes);
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.runnerErrors).toBeUndefined();
  });

  it("noCache eviction race: stale in-flight run does not overwrite fresh cache", async () => {
    // Set up a slow run followed by a noCache-triggered fresh run.
    // The slow run should NOT overwrite the fresh run's cache entry.
    let resolveSlowRun!: (v: any[]) => void;
    const slowRun = new Promise<any[]>((res) => {
      resolveSlowRun = res;
    });

    // First call starts with the slow runner
    vi.mocked(vitestRunner.run).mockReturnValueOnce(slowRun as any);
    const slowPromise = createRunTestsTool(ws, probes).handler({});

    // Simulate noCache call while slow run is in-flight — by using a second tool
    // instance sharing the same mock. The important invariant is tested by checking
    // that the generation mechanism prevents the stale write.
    // Here we test via the generation bump path: evict and re-run.
    const tool = createRunTestsTool(ws, probes);

    // Fresh run returns different results
    vi.mocked(vitestRunner.run).mockResolvedValueOnce([
      {
        name: "fresh test",
        status: "passed",
        source: "vitest",
        file: "fresh.test.ts",
        line: 1,
        durationMs: 5,
      },
    ] as any);

    // This noCache run should see the fresh results
    const freshResult = await tool.handler({ noCache: true });
    const freshData = JSON.parse(freshResult.content[0]?.text ?? "{}");
    expect(freshData.results[0]?.name).toBe("fresh test");

    // Resolve the slow run (simulates it completing after noCache evicted it)
    resolveSlowRun([
      {
        name: "stale test",
        status: "passed",
        source: "vitest",
        file: "stale.test.ts",
        line: 1,
        durationMs: 100,
      },
    ]);
    await slowPromise;

    // Cache should still contain the fresh result, not the stale one
    // (verify by calling without noCache — should hit cache with fresh result)
    vi.mocked(vitestRunner.run).mockClear();
    const cachedResult = await tool.handler({});
    const cachedData = JSON.parse(cachedResult.content[0]?.text ?? "{}");
    // The runner should not have been called again (we're reading from cache)
    // and the result should be the fresh one
    expect(cachedData.results[0]?.name).toBe("fresh test");
  });

  describe("progress streaming", () => {
    it("passes onLine fn to runner when progress fn provided", async () => {
      const tool = createRunTestsTool(ws, probes);
      const progress = vi.fn();
      await tool.handler({ noCache: true }, undefined, progress);
      // runner.run should be called with a non-undefined onLine callback as 5th arg
      const callArgs = vi.mocked(vitestRunner.run).mock.calls[0];
      expect(typeof callArgs?.[4]).toBe("function");
    });

    it("emits one progress notification per output line via onLine", async () => {
      // Mock runner that calls onLine 3 times during execution
      vi.mocked(vitestRunner.run).mockImplementationOnce(
        async (
          _cwd,
          _filter,
          _signal,
          _timeout,
          onLine?: (line: string) => void,
        ) => {
          onLine?.("test 1 passed");
          onLine?.("test 2 passed");
          onLine?.("test 3 failed");
          return [
            {
              name: "t1",
              status: "passed",
              source: "vitest",
              file: "t.test.ts",
              line: 1,
              durationMs: 1,
            },
          ] as any;
        },
      );

      const calls: Array<{ value: number; message?: string }> = [];
      const progress = (
        value: number,
        _total: number | undefined,
        message?: string,
      ) => {
        calls.push({ value, message });
      };
      const tool = createRunTestsTool(ws, probes);
      await tool.handler({ noCache: true }, undefined, progress);

      const lineCalls = calls.filter((c) => c.message !== undefined);
      expect(lineCalls).toHaveLength(3);
      expect(lineCalls[0]?.message).toBe("test 1 passed");
      expect(lineCalls[1]?.message).toBe("test 2 passed");
      expect(lineCalls[2]?.message).toBe("test 3 failed");
      // Values increment monotonically
      const values = lineCalls.map((c) => c.value);
      expect(values).toEqual([...values].sort((a, b) => a - b));
    });

    it("passes undefined onLine to runner when no progress fn provided", async () => {
      const tool = createRunTestsTool(ws, probes);
      await tool.handler({ noCache: true });
      const callArgs = vi.mocked(vitestRunner.run).mock.calls[0];
      expect(callArgs?.[4]).toBeUndefined();
    });

    it("total is undefined (indeterminate) for streaming progress calls", async () => {
      vi.mocked(vitestRunner.run).mockImplementationOnce(
        async (
          _cwd,
          _filter,
          _signal,
          _timeout,
          onLine?: (line: string) => void,
        ) => {
          onLine?.("running…");
          return [] as any;
        },
      );
      const totals: Array<number | undefined> = [];
      const progress = (_v: number, total: number | undefined) => {
        totals.push(total);
      };
      const tool = createRunTestsTool(ws, probes);
      await tool.handler({ noCache: true }, undefined, progress);
      // The onLine-triggered call should have total=undefined (not 0 or 100)
      const lineTotals = totals.slice(1, -1); // skip initial 0,100 and final 100,100
      expect(lineTotals.every((t) => t === undefined)).toBe(true);
    });
  });
});
