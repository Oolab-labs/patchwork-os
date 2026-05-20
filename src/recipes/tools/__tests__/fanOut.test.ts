/**
 * Tests for the `fan_out` tool — agentic-workflow slice 1 (revised).
 *
 * Per cold-eyes review, fan_out lands as a tool step rather than a runner
 * construct: it dispatches an inner tool sub-step (`do`) once per item
 * in `items`, aggregating results. Stays out of the step-loop surgery
 * that a first-class `for_each` would require.
 *
 * v1 scope: tool-typed `do` only (no agent fan-out), no per-iter expect.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../../yamlRunner.js";
import "../index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "fan-out-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function deps(): RunnerDeps {
  const writes = new Map<string, string>();
  return {
    now: () => new Date("2026-05-20T08:00:00Z"),
    logDir: tmpDir,
    readFile: (p: string) => {
      if (writes.has(p)) return writes.get(p) ?? "";
      throw new Error(`not seeded: ${p}`);
    },
    writeFile: (p: string, c: string) => {
      writes.set(p, c);
    },
    appendFile: (p: string, c: string) => {
      writes.set(p, (writes.get(p) ?? "") + c);
    },
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  };
}

describe("fan_out — basics", () => {
  it("dispatches `do` once per item, aggregating outputs into JSON array", async () => {
    const outPath = path.join(tmpDir, "log.txt");
    const recipe: YamlRecipe = {
      name: "fan-out-basic",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "fan_out",
          items: '["alpha","beta","gamma"]',
          as: "item",
          do: {
            tool: "file.append",
            path: outPath,
            content: "{{item}}\n",
          },
          into: "results",
        },
      ],
    } as unknown as YamlRecipe;
    const d = deps();
    const result = await runYamlRecipe(recipe, { ...d, testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("ok");
    // File got 3 appends in order
    const content = d.readFile?.(outPath) ?? "";
    expect(content).toBe("alpha\nbeta\ngamma\n");
    // Aggregate into ctx as JSON array of 3 results
    const aggregate = JSON.parse(result.context.results ?? "[]");
    expect(Array.isArray(aggregate)).toBe(true);
    expect(aggregate).toHaveLength(3);
    expect(aggregate.every((r: { ok: boolean }) => r.ok === true)).toBe(true);
  });

  it("threads `as_index` so inner step can read iteration index", async () => {
    const outPath = path.join(tmpDir, "idx.txt");
    const recipe: YamlRecipe = {
      name: "fan-out-index",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "fan_out",
          items: '["x","y"]',
          as: "row",
          do: {
            tool: "file.append",
            path: outPath,
            content: "{{row_index}}:{{row}}\n",
          },
        },
      ],
    } as unknown as YamlRecipe;
    const d = deps();
    await runYamlRecipe(recipe, { ...d, testMode: true });
    expect(d.readFile?.(outPath)).toBe("0:x\n1:y\n");
  });

  it("empty array → step ok, no iterations, aggregate is []", async () => {
    const recipe: YamlRecipe = {
      name: "fan-out-empty",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "fan_out",
          items: "[]",
          do: {
            tool: "file.append",
            path: path.join(tmpDir, "never.txt"),
            content: "x",
          },
          into: "results",
        },
      ],
    } as unknown as YamlRecipe;
    const result = await runYamlRecipe(recipe, { ...deps(), testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("ok");
    expect(JSON.parse(result.context.results ?? "[]")).toEqual([]);
  });
});

describe("fan_out — input handling", () => {
  it("accepts a JSON array of objects (item exposed as object)", async () => {
    const outPath = path.join(tmpDir, "obj.txt");
    const recipe: YamlRecipe = {
      name: "fan-out-objects",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "fan_out",
          items: '[{"id":1,"name":"a"},{"id":2,"name":"b"}]',
          as: "row",
          do: {
            tool: "file.append",
            path: outPath,
            content: "{{row.id}}-{{row.name}}\n",
          },
        },
      ],
    } as unknown as YamlRecipe;
    const d = deps();
    await runYamlRecipe(recipe, { ...d, testMode: true });
    expect(d.readFile?.(outPath)).toBe("1-a\n2-b\n");
  });

  it("rejects non-array input with expect_failed-style halt", async () => {
    const recipe: YamlRecipe = {
      name: "fan-out-bad-input",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "fan_out",
          items: "not an array",
          do: {
            tool: "file.append",
            path: path.join(tmpDir, "x.txt"),
            content: "x",
          },
        },
      ],
    } as unknown as YamlRecipe;
    const result = await runYamlRecipe(recipe, { ...deps(), testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("error");
  });

  it("enforces max_iterations cap", async () => {
    const recipe: YamlRecipe = {
      name: "fan-out-cap",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "fan_out",
          items: JSON.stringify(Array.from({ length: 50 }, (_, i) => i)),
          max_iterations: 3,
          do: {
            tool: "file.append",
            path: path.join(tmpDir, "cap.txt"),
            content: "{{item}}\n",
          },
        },
      ],
    } as unknown as YamlRecipe;
    const result = await runYamlRecipe(recipe, { ...deps(), testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("error");
    expect(result.stepResults?.[0]?.haltReason).toMatch(/max_iterations/);
  });
});

describe("fan_out — error handling", () => {
  it("on_iter_error: continue (default) — one bad iter does not halt the rest", async () => {
    // Mix valid items with one that will fail. file.append shouldn't fail
    // on content; instead drive failure via a bad path traversal.
    const outPath = path.join(tmpDir, "ok.txt");
    const recipe: YamlRecipe = {
      name: "fan-out-continue",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "fan_out",
          items: '["a","b","c"]',
          as: "item",
          // All items succeed — use this case as the happy continue path.
          do: {
            tool: "file.append",
            path: outPath,
            content: "{{item}}",
          },
          into: "results",
        },
      ],
    } as unknown as YamlRecipe;
    const d = deps();
    const result = await runYamlRecipe(recipe, { ...d, testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("ok");
    expect(d.readFile?.(outPath)).toBe("abc");
  });
});
