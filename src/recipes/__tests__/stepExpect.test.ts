/**
 * Tests for per-step `expect` block (slice 2 of agentic-workflow primitives).
 *
 * Per Bug Fix Protocol — failing-first. expect block is a new primitive that
 * evaluates the step's output against assertions (equals/contains/matches/
 * schema) and either halts the run (`on_fail: halt`, default) or attaches a
 * warning (`on_fail: warn`) without changing status.
 *
 * Scope (v1): halt + warn only. `on_fail: judge` is intentionally NOT
 * implemented — synthesizing a judge to gate a step would violate the
 * augment-only invariant in judgeVerdict.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { categoriseHaltReason } from "../haltCategory.js";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "step-expect-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function deps(): RunnerDeps {
  return {
    now: () => new Date("2026-05-20T08:00:00Z"),
    logDir: tmpDir,
    readFile: (p: string) => {
      // Used by file.read steps to seed deterministic content.
      if (p.endsWith("ok.txt")) return "hello";
      if (p.endsWith("num.txt")) return "42";
      throw new Error(`not seeded: ${p}`);
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  };
}

describe("step.expect — equals", () => {
  it("passes when result equals expected value (step stays ok)", async () => {
    const recipe: YamlRecipe = {
      name: "expect-equals-pass",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.read",
          path: path.join(tmpDir, "ok.txt"),
          into: "content",
          expect: { equals: "hello" },
        },
      ],
    } as YamlRecipe;
    const result = await runYamlRecipe(recipe, deps(), { testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("ok");
    expect(result.errorMessage).toBeUndefined();
  });

  it("halts run when result does not equal expected (on_fail default = halt)", async () => {
    const recipe: YamlRecipe = {
      name: "expect-equals-fail",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.read",
          path: path.join(tmpDir, "ok.txt"),
          into: "content",
          expect: { equals: "goodbye" },
        },
      ],
    } as YamlRecipe;
    const result = await runYamlRecipe(recipe, deps(), { testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("error");
    expect(result.stepResults?.[0]?.haltReason).toMatch(/expect_failed/i);
    expect(categoriseHaltReason(result.stepResults?.[0]?.haltReason)).toBe(
      "expect_failed",
    );
    expect(result.errorMessage).toBeDefined();
  });

  it("on_fail: warn keeps step ok but attaches warning + run does not error", async () => {
    const recipe: YamlRecipe = {
      name: "expect-equals-warn",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.read",
          path: path.join(tmpDir, "ok.txt"),
          into: "content",
          expect: { equals: "goodbye", on_fail: "warn" },
        },
      ],
    } as YamlRecipe;
    const result = await runYamlRecipe(recipe, deps(), { testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("ok");
    expect(result.errorMessage).toBeUndefined();
    expect(
      result.stepResults?.[0]?.expectWarnings?.length ?? 0,
    ).toBeGreaterThan(0);
  });
});

describe("step.expect — contains", () => {
  it("passes when result contains substring", async () => {
    const recipe: YamlRecipe = {
      name: "expect-contains-pass",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.read",
          path: path.join(tmpDir, "ok.txt"),
          into: "content",
          expect: { contains: "ell" },
        },
      ],
    } as YamlRecipe;
    const result = await runYamlRecipe(recipe, deps(), { testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("ok");
  });

  it("array of contains: all must be present", async () => {
    const recipe: YamlRecipe = {
      name: "expect-contains-array",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.read",
          path: path.join(tmpDir, "ok.txt"),
          into: "content",
          expect: { contains: ["he", "lo", "MISSING"] },
        },
      ],
    } as YamlRecipe;
    const result = await runYamlRecipe(recipe, deps(), { testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("error");
    expect(result.stepResults?.[0]?.haltReason).toMatch(/MISSING/);
  });
});

describe("step.expect — matches (regex)", () => {
  it("passes when regex matches", async () => {
    const recipe: YamlRecipe = {
      name: "expect-matches-pass",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.read",
          path: path.join(tmpDir, "num.txt"),
          into: "content",
          expect: { matches: "^\\d+$" },
        },
      ],
    } as YamlRecipe;
    const result = await runYamlRecipe(recipe, deps(), { testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("ok");
  });

  it("halts when regex does not match", async () => {
    const recipe: YamlRecipe = {
      name: "expect-matches-fail",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.read",
          path: path.join(tmpDir, "ok.txt"),
          into: "content",
          expect: { matches: "^\\d+$" },
        },
      ],
    } as YamlRecipe;
    const result = await runYamlRecipe(recipe, deps(), { testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("error");
  });
});

describe("step.expect — schema (AJV)", () => {
  it("passes when JSON output matches schema", async () => {
    // file.read of a JSON-shaped file — store as string, expect.schema parses + validates.
    const recipe: YamlRecipe = {
      name: "expect-schema-pass",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.read",
          path: path.join(tmpDir, "num.txt"),
          into: "content",
          // "42" is a valid number per JSON; schema = {type: "number"} after JSON.parse
          expect: { schema: { type: "number" } },
        },
      ],
    } as YamlRecipe;
    const result = await runYamlRecipe(recipe, deps(), { testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("ok");
  });

  it("halts when JSON output violates schema", async () => {
    const recipe: YamlRecipe = {
      name: "expect-schema-fail",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.read",
          path: path.join(tmpDir, "ok.txt"),
          into: "content",
          expect: { schema: { type: "number" } },
        },
      ],
    } as YamlRecipe;
    const result = await runYamlRecipe(recipe, deps(), { testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("error");
  });
});
