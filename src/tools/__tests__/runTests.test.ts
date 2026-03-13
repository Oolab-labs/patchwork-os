import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock individual test runners so runTests.ts doesn't invoke real processes
vi.mock("../testRunners/vitestJest.js", () => ({
  vitestRunner: {
    name: "vitest",
    cacheTtl: 30_000,
    detect: vi.fn(() => true),
    run: vi.fn(async () => [
      { name: "a passes", status: "passed", source: "vitest", file: "a.test.ts", line: 1, durationMs: 10 },
      { name: "b fails", status: "failed", source: "vitest", file: "b.test.ts", line: 5, durationMs: 5, message: "Expected 1" },
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

import { vitestRunner } from "../testRunners/vitestJest.js";
import { createRunTestsTool } from "../runTests.js";

const probes = {
  biome: false, eslint: false, tsc: false, cargo: false, go: false,
  pyright: false, ruff: false, node: true, npm: true, npx: true,
  git: true, gh: false, python: false, codex: false,
  vitest: true, jest: false, pytest: false,
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
    expect(vi.mocked(vitestRunner.run)).toHaveBeenCalledWith(ws, "someFilter", undefined);
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
    vi.mocked(vitestRunner.run).mockRejectedValueOnce(new Error("runner crashed"));
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
});
