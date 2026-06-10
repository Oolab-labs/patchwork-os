/**
 * Regression: `timeout_ms` + `retry` must not cause duplicate write-tool
 * side effects (audit 2026-06-10 recipe-runners-2).
 *
 * A per-step wall-clock timeout fires via `Promise.race`; the underlying tool
 * keeps running in the background. With a non-zero `retry`, the runner used to
 * loop and re-issue `executeStep` for the same step — for a write tool whose
 * call is still in flight, the in-flight idempotency dedup short-circuits the
 * retry to the SAME promise, so the real side effect must fire exactly once.
 *
 * This test asserts that property at the side-effect boundary (a counter
 * incremented inside the tool's execute) so a future refactor that breaks the
 * dedup-on-timeout guarantee fails loudly instead of silently double-posting.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";
import "../tools/index.js";
import { hasTool, registerTool } from "../toolRegistry.js";

let tmpDir: string;
let writeSideEffectCount = 0;
let sideEffectCount = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "timeout-retry-dup-"));
  writeSideEffectCount = 0;
  sideEffectCount = 0;
  // A WRITE tool that records a side effect immediately, then sleeps long
  // enough that a small timeout_ms always fires while it is in flight.
  if (!hasTool("test.slowWrite")) {
    registerTool({
      id: "test.slowWrite",
      namespace: "test",
      description: "Record a side effect then sleep. Test-only WRITE tool.",
      paramsSchema: {
        type: "object",
        properties: { ms: { type: "number" } },
        required: ["ms"],
      },
      outputSchema: { type: "string" },
      riskDefault: "low",
      isWrite: true,
      execute: async ({ params }) => {
        // Side effect happens at invocation time (mirrors slack.post firing
        // the HTTP request before the response returns).
        writeSideEffectCount++;
        const ms = typeof params.ms === "number" ? params.ms : 0;
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        return JSON.stringify({ ok: true, posted: true });
      },
    });
  }
  // A NON-write tool with an external side effect — the idempotency ledger
  // does NOT dedup these, so a timeout-triggered retry would re-fire the
  // side effect. This is the residual hazard recipe-runners-2 targets.
  if (!hasTool("test.slowSideEffect")) {
    registerTool({
      id: "test.slowSideEffect",
      namespace: "test",
      description: "Record a side effect then sleep. Test-only non-write tool.",
      paramsSchema: {
        type: "object",
        properties: { ms: { type: "number" } },
        required: ["ms"],
      },
      outputSchema: { type: "string" },
      riskDefault: "low",
      isWrite: false,
      execute: async ({ params }) => {
        sideEffectCount++;
        const ms = typeof params.ms === "number" ? params.ms : 0;
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        return "ok";
      },
    });
  }
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function deps(): RunnerDeps {
  return {
    now: () => new Date("2026-06-10T08:00:00Z"),
    logDir: tmpDir,
    readFile: () => {
      throw new Error("not seeded");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  };
}

describe("timeout_ms + retry — duplicate side-effect protection", () => {
  it("fires a NON-write tool's side effect exactly once despite timeout + retry", async () => {
    // Without the recipe-runners-2 fix the runner re-issues the step after the
    // timeout; a non-write tool has no idempotency dedup, so the side effect
    // fires once per attempt → 2. With the fix it must fire exactly once.
    const recipe: YamlRecipe = {
      name: "timeout-retry-nonwrite",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "test.slowSideEffect",
          ms: 300,
          timeout_ms: 30,
          retry: 1,
          retryDelay: 10,
        },
      ],
    } as unknown as YamlRecipe;

    const result = await runYamlRecipe(recipe, { ...deps(), testMode: true });

    expect(result.stepResults?.[0]?.status).toBe("error");
    expect(result.stepResults?.[0]?.haltReason).toMatch(/step_timeout/i);
    expect(sideEffectCount).toBe(1);
  });

  it("fires a write tool's side effect exactly once despite timeout + retry", async () => {
    const recipe: YamlRecipe = {
      name: "timeout-retry-write",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "test.slowWrite",
          ms: 300,
          timeout_ms: 30,
          retry: 1,
          retryDelay: 10,
        },
      ],
    } as unknown as YamlRecipe;

    const result = await runYamlRecipe(recipe, { ...deps(), testMode: true });

    expect(result.stepResults?.[0]?.status).toBe("error");
    expect(writeSideEffectCount).toBe(1);
  });

  it("still retries a genuine (non-timeout) transient failure", async () => {
    // Guard against the fix over-reaching: a normal failure must still retry.
    let attempts = 0;
    if (!hasTool("test.flaky")) {
      registerTool({
        id: "test.flaky",
        namespace: "test",
        description: "Fails once then succeeds. Test-only.",
        paramsSchema: { type: "object", properties: {} },
        outputSchema: { type: "string" },
        riskDefault: "low",
        isWrite: false,
        execute: async () => {
          attempts++;
          if (attempts === 1) throw new Error("transient boom");
          return "ok";
        },
      });
    }
    const recipe: YamlRecipe = {
      name: "retry-nontimeout",
      trigger: { type: "manual" },
      steps: [{ tool: "test.flaky", retry: 1, retryDelay: 5 }],
    } as unknown as YamlRecipe;

    const result = await runYamlRecipe(recipe, { ...deps(), testMode: true });
    expect(result.stepResults?.[0]?.status).toBe("ok");
    expect(attempts).toBe(2);
  });
});
