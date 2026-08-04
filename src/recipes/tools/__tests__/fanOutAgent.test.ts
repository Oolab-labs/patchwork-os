/**
 * `fan_out` agent sub-steps (v2a) — one agent call per item.
 *
 * v1 rejected `do.agent` outright, so the only way to run an AI step once per
 * item was `parallel: {each}`, which no runner implements. That left a common
 * shape unexpressible: scrub/classify/extract N documents, then synthesise.
 *
 * The load-bearing constraint is BUDGET. `RunBudget` and the per-step usage
 * accumulator are closure locals of `runYamlRecipe`; a tool cannot reach them.
 * N agent calls made inside a tool step would therefore spend real money that
 * `admit()` never sees — which is exactly the S1 finding that left the chained
 * path's budget unenforced. So fan_out does not call the agent itself: the
 * runner injects `runNestedAgent`, which admits against the budget, executes,
 * reconciles usage, and applies the same failure detection as a normal agent
 * step. With no executor injected, agent sub-steps are REFUSED rather than
 * silently run un-budgeted.
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

let tmpDir: string;
let prompts: string[];

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "fanout-agent-"));
  prompts = [];
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A recipe whose single step fans an agent over three documents. */
function fanRecipe(over = '["alpha","beta","gamma"]', extra = {}): YamlRecipe {
  return {
    name: "fan-agent",
    trigger: { type: "manual" },
    steps: [
      {
        tool: "fan_out",
        items: over,
        as: "doc",
        into: "scrubbed",
        do: {
          // `driver` is pinned deliberately: with it omitted, agentExecutor's
          // auto-detect resolves a real driver and a test will call a LIVE
          // model (observed: a genuine completion, ~3s, despite claudeFn being
          // injected). Pre-existing behaviour of the agent path, not of
          // fan_out — but a trap worth naming here.
          agent: {
            prompt: "Scrub this document: {{doc}}",
            driver: "anthropic",
          },
          ...extra,
        },
      },
    ],
  } as unknown as YamlRecipe;
}

function deps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    testMode: true,
    now: () => new Date("2026-08-04T08:00:00Z"),
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
    // Every driver routes through claudeFn in these tests.
    claudeFn: async (prompt: string) => {
      prompts.push(prompt);
      return `redacted(${prompt.split(": ").pop()})`;
    },
    ...overrides,
  } as RunnerDeps;
}

describe("fan_out — agent sub-steps", () => {
  it("runs the agent once per item, with the loop variable bound", async () => {
    const result = await runYamlRecipe(fanRecipe(), deps());

    expect(prompts).toEqual([
      "Scrub this document: alpha",
      "Scrub this document: beta",
      "Scrub this document: gamma",
    ]);
    expect(result.stepResults[0]?.status).toBe("ok");
  });

  it("aggregates per-iteration output in order", async () => {
    const result = await runYamlRecipe(fanRecipe(), deps());
    const agg = JSON.parse(result.context.scrubbed ?? "[]");

    expect(agg).toHaveLength(3);
    expect(agg.map((r: { index: number }) => r.index)).toEqual([0, 1, 2]);
    expect(agg.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(agg[0].output).toContain("alpha");
  });

  it("treats an agent failure marker as a failed iteration, not a success", async () => {
    const result = await runYamlRecipe(
      fanRecipe(),
      deps({
        claudeFn: async (prompt: string) =>
          prompt.includes("beta")
            ? "[agent step failed: model refused]"
            : "clean",
      }),
    );
    const agg = JSON.parse(result.context.scrubbed ?? "[]");

    expect(agg.map((r: { ok: boolean }) => r.ok)).toEqual([true, false, true]);
    expect(agg[1].error).toMatch(/agent step failed/i);
  });

  it("halts the loop when the run budget is exhausted, keeping partial results", async () => {
    // A tiny cap: the first iteration's usage blows it, so iteration 2 is
    // never admitted. The point is that the budget SEES fan_out's spend —
    // an un-budgeted loop is the failure this seam exists to prevent.
    const recipe = {
      ...fanRecipe(),
      budget: { tokensMax: 10, on_breach: "halt" },
    } as unknown as YamlRecipe;

    const result = await runYamlRecipe(
      recipe,
      deps({
        claudeFn: async () => ({
          text: "ok",
          usage: { inputTokens: 50, outputTokens: 50 },
        }),
      }),
    );

    // Not all three ran.
    expect(prompts.length).toBeLessThan(3);
    expect(JSON.stringify(result)).toMatch(/budget/i);
  });

  it("refuses agent sub-steps when no executor is wired, rather than running them un-budgeted", async () => {
    const { executeTool } = await import("../../toolRegistry.js");
    // Calling the tool directly — no runner, so no `runNestedAgent` injected.
    await expect(
      executeTool("fan_out", {
        params: {
          items: '["a"]',
          do: { agent: { prompt: "hi {{item}}" } },
        },
        step: {},
        ctx: {},
        // biome-ignore lint/suspicious/noExplicitAny: minimal deps for this path
        deps: { testMode: true } as any,
      }),
    ).rejects.toThrow(/agent sub-steps/i);
  });

  it("still rejects a nested fan_out", async () => {
    const result = await runYamlRecipe(
      {
        name: "nested",
        trigger: { type: "manual" },
        steps: [
          {
            tool: "fan_out",
            items: '["a"]',
            do: { tool: "fan_out", items: '["b"]', do: { tool: "time.now" } },
          },
        ],
      } as unknown as YamlRecipe,
      deps(),
    );
    expect(result.stepResults[0]?.status).toBe("error");
    expect(result.stepResults[0]?.error).toMatch(/nested fan_out/i);
  });

  it("runs the shipped private-document-digest example, and no raw document text reaches the second model", async () => {
    // The example exists to make one claim: raw documents go to the LOCAL
    // model only, and the hosted model sees redacted extracts. A recipe can
    // look right and still leak by referencing the wrong variable in the
    // synthesis prompt, so assert on what each driver actually received.
    const YAML = (await import("yaml")).default;
    const { readFileSync } = await import("node:fs");
    const recipe = YAML.parse(
      readFileSync(
        path.join(
          process.cwd(),
          "examples/recipes/advanced-patterns/private-document-digest.yaml",
        ),
        "utf8",
      ),
    ) as YamlRecipe;

    const SECRET = "Jane Doe, 42 Elm St, acct 99887766";
    const outPath = path.join(tmpDir, "digest.md");
    let written = "";
    // Record every prompt with the step it belongs to. Asserting on the
    // PROPERTY ("raw text only ever appears in a scrub prompt") rather than on
    // which driver ran which step: the digest step leaves `driver` unset so it
    // follows the install default, and pinning it here would test the fixture
    // instead of the recipe.
    const seen: Array<{ scrub: boolean; prompt: string }> = [];
    const record = async (prompt: string) => {
      const scrub = prompt.startsWith("Extract only the facts");
      seen.push({ scrub, prompt });
      return scrub ? "E1 met E2 in 2026-03." : "E1 and E2 recur.";
    };

    const result = await runYamlRecipe(
      recipe,
      deps({
        localFn: record,
        claudeFn: record,
        claudeCodeFn: record,
        writeFile: (_p: string, c: string) => {
          written = c;
        },
      }),
      {
        DOC_LIST: JSON.stringify([`${SECRET} — met partner in March 2026.`]),
        DIGEST_PATH: outPath,
      },
    );

    // Both steps ran.
    expect(seen.filter((s) => s.scrub)).toHaveLength(1);
    const digest = seen.filter((s) => !s.scrub);
    expect(digest).toHaveLength(1);

    // The scrub prompt carried the raw document…
    expect(seen.find((s) => s.scrub)?.prompt).toContain(SECRET);
    // …and NOTHING downstream of it did. This is the recipe's whole claim.
    expect(digest[0]?.prompt).not.toContain(SECRET);
    expect(digest[0]?.prompt).not.toContain("Elm St");
    expect(digest[0]?.prompt).not.toContain("99887766");
    expect(digest[0]?.prompt).toContain("E1");

    expect(result.errorMessage).toBeUndefined();
    expect(written).toContain("E1");
  });

  it("rejects agent options it cannot honour, instead of ignoring them", async () => {
    // A judge verdict / refine loop inside the iteration is NOT implemented.
    // Accepting the key and dropping it would be the silent-skip bug again.
    const result = await runYamlRecipe(
      fanRecipe('["a"]', {
        agent: { prompt: "x", driver: "anthropic", kind: "judge" },
      }),
      deps(),
    );
    expect(result.stepResults[0]?.status).toBe("error");
    expect(result.stepResults[0]?.error).toMatch(/judge/i);
  });
});
