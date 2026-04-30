/**
 * Reproducer tests for 5 alleged recipe-engine bugs.
 *
 * Per Bug Fix Protocol — these tests should FAIL on current code, proving
 * the bug, before any fix lands.
 *
 * Bug 1 — RefuteD: fire() returning {ok:true} pre-dispatch is documented
 *         fire-and-forget design (see RecipeOrchestrator.fire.test.ts).
 *         No reproducer.
 * Bug 2 — yamlRunner.ts:533 duplicate stepId when 2 steps reuse same tool.
 * Bug 3 — yamlRunner.ts:641 file.write w/ undefined path crashes render().
 * Bug 4 — chainedRunner.ts:647 cycle returns w/o completeRun → leaks running.
 * Bug 5 — validation.ts:300 file_watch trigger does not register {{file}}.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChainedRecipe,
  ExecutionDeps,
  RunOptions,
} from "../chainedRunner.js";
import { runChainedRecipe } from "../chainedRunner.js";
import { validateRecipeDefinition } from "../validation.js";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "alleged-bugs-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function deps(): RunnerDeps {
  return {
    now: () => new Date("2026-04-30T08:00:00Z"),
    logDir: tmpDir,
    readFile: () => {
      throw new Error("not found");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug 2 — duplicate stepIds when multiple steps reuse a tool with no `into`
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG 2 — yamlRunner stepId collision (line 533)", () => {
  it("two file.write steps without `into` produce distinct stepIds in stepResults", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const recipe: YamlRecipe = {
      name: "dup-id-bug",
      trigger: { type: "manual" },
      steps: [
        { tool: "file.write", path: path.join(tmpDir, "a.txt"), content: "A" },
        { tool: "file.write", path: path.join(tmpDir, "b.txt"), content: "B" },
      ],
    } as YamlRecipe;

    const localDeps: RunnerDeps = {
      ...deps(),
      writeFile: (p: string, c: string) => writes.push({ path: p, content: c }),
    };

    const result = await runYamlRecipe(recipe, localDeps, { testMode: true });
    const ids = (result.stepResults ?? []).map((s) => s.id);
    // BUG: both steps get stepId === "file.write" because no `into` and same tool
    expect(new Set(ids).size).toBe(ids.length); // expected: unique; actual: duplicate
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 3 — file.write with undefined path → render() crash
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG 3 — yamlRunner file.write undefined path (line 641)", () => {
  it("does not throw an unhandled error when step.path is undefined", async () => {
    const recipe = {
      name: "undef-path-bug",
      trigger: { type: "manual" },
      steps: [
        // path intentionally omitted — schema may allow it through
        { tool: "file.write", content: "x" },
      ],
    } as unknown as YamlRecipe;

    // BUG: render(step.path as string, ctx) — undefined cast to string,
    // render() blows up on `undefined.replace(...)` etc.
    await expect(
      runYamlRecipe(recipe, deps(), { testMode: true }),
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 4 — chainedRunner cycle returns without completeRun — leaks "running"
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG 4 — chainedRunner cycle leaks running entry (line 647)", () => {
  it("cyclic recipe finalizes the run-log entry (no orphan 'running' row)", async () => {
    const cyclic = {
      name: "cycle-bug",
      trigger: { type: "chained" },
      steps: [
        { id: "a", tool: "noop", awaits: ["b"] },
        { id: "b", tool: "noop", awaits: ["a"] },
      ],
    } as unknown as ChainedRecipe;

    const opts: RunOptions = {
      env: {},
      maxConcurrency: 4,
      maxDepth: 3,
      dryRun: false,
      runLogDir: tmpDir,
    } as RunOptions;

    const okDeps: ExecutionDeps = {
      executeTool: vi.fn().mockResolvedValue("ok"),
      executeAgent: vi.fn(),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };

    const r = await runChainedRecipe(cyclic, opts, okDeps);
    expect(r.success).toBe(false);

    const file = path.join(tmpDir, "runs.jsonl");
    const lines = existsSync(file)
      ? readFileSync(file, "utf-8").split("\n").filter(Boolean)
      : [];
    const rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

    // BUG: startRun was called at line 635, then early return at 648 means
    // completeRun is never invoked → row stays "running" forever.
    const running = rows.filter((row) => row.status === "running");
    expect(running).toEqual([]);
    // And there should be exactly one finalized error row.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.status === "error")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 5 — validation: file_watch trigger doesn't register {{file}}
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG 5 — validation file_watch missing {{file}} (line 300)", () => {
  it("recipe with file_watch trigger using {{file}} is valid (no 'Unknown template reference' error)", () => {
    const recipe = {
      name: "fw-bug",
      description: "watch + use file",
      trigger: { type: "file_watch", patterns: ["**/*.ts"] },
      steps: [
        {
          tool: "file.write",
          path: "/tmp/log.txt",
          content: "saw {{file}}",
        },
      ],
    };

    const result = validateRecipeDefinition(recipe);
    const fileRefErrors = result.issues.filter(
      (i) =>
        i.level === "error" &&
        i.message.includes("{{file}}") &&
        i.message.includes("Unknown template reference"),
    );
    // BUG: registerRecipeContextKeys checks on_file_save but not file_watch,
    // so {{file}} is flagged as unknown.
    expect(fileRefErrors).toEqual([]);
  });
});
