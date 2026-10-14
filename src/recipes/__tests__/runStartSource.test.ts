/**
 * Run start source — how a run was STARTED, as distinct from the trigger the
 * recipe DECLARES.
 *
 * A recipe whose YAML says `trigger.type: cron` can be started two ways: by
 * the scheduler on a tick, or by an operator pressing "Run now". Before this
 * change both were recorded with run-row trigger `cron` and both were handed
 * to `computeEffectivePolicy` as a cron trigger, so under the compat profile a
 * hand-started run of a cron recipe was not consulted the way a manual run
 * is. The orchestrator now passes the start source; the runners use it for
 * the run row, the `recipe_started` event, inbox frontmatter and the policy
 * input. Absent ⇒ the previous derivation from the YAML, byte-identical.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOVERNED_PROFILE } from "../../governance/profile.js";
import { RecipeRunLog } from "../../runLog.js";
import {
  type ChainedRecipe,
  type ExecutionDeps,
  runChainedRecipe,
} from "../chainedRunner.js";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

let TMP: string;
beforeEach(() => {
  TMP = mkdtempSync(path.join(os.tmpdir(), "run-start-source-"));
});
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    now: () => new Date("2026-09-01T12:00:00Z"),
    logDir: TMP,
    testMode: false,
    readFile: () => {
      throw new Error("nf");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
    ...extra,
  };
}

function recipe(type: string): YamlRecipe {
  return {
    name: "start-source",
    trigger: { type, ...(type === "cron" && { at: "0 9 * * *" }) },
    steps: [{ tool: "file.write", path: `${TMP}/out`, content: "1" }],
  } as unknown as YamlRecipe;
}

function rows(): Array<Record<string, unknown>> {
  const file = path.join(TMP, "runs.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => typeof r.recipeName === "string");
}

describe("flat runner — start source", () => {
  it("a manual start of a cron recipe records trigger 'manual' and is consulted under compat", async () => {
    const requireApprovalFn = vi.fn(async () => true);
    await runYamlRecipe(
      recipe("cron"),
      deps({ requireApprovalFn, startSource: "manual" }),
    );
    expect(requireApprovalFn).toHaveBeenCalledTimes(1);
    expect(rows().map((r) => r.trigger)).toEqual(["manual"]);
  });

  it("the same recipe started by the scheduler stays 'cron' and is not consulted under compat", async () => {
    const requireApprovalFn = vi.fn(async () => true);
    await runYamlRecipe(
      recipe("cron"),
      deps({ requireApprovalFn, startSource: "cron" }),
    );
    expect(requireApprovalFn).not.toHaveBeenCalled();
    expect(rows().map((r) => r.trigger)).toEqual(["cron"]);
  });

  it("a webhook start stays 'webhook' and is not consulted under compat", async () => {
    const requireApprovalFn = vi.fn(async () => true);
    await runYamlRecipe(
      recipe("webhook"),
      deps({ requireApprovalFn, startSource: "webhook" }),
    );
    expect(requireApprovalFn).not.toHaveBeenCalled();
    expect(rows().map((r) => r.trigger)).toEqual(["webhook"]);
  });

  it("no start source ⇒ the previous derivation from the YAML (unchanged)", async () => {
    const requireApprovalFn = vi.fn(async () => true);
    await runYamlRecipe(recipe("cron"), deps({ requireApprovalFn }));
    expect(requireApprovalFn).not.toHaveBeenCalled();
    expect(rows().map((r) => r.trigger)).toEqual(["cron"]);
  });

  it("governed gates the scheduler tick and the manual start alike", async () => {
    for (const startSource of ["manual", "cron"] as const) {
      const requireApprovalFn = vi.fn(async () => true);
      await runYamlRecipe(
        recipe("cron"),
        deps({
          governance: GOVERNED_PROFILE,
          requireApprovalFn,
          startSource,
        }),
      );
      expect(requireApprovalFn).toHaveBeenCalledTimes(1);
    }
  });

  it("the live run row and recipe_started event carry the start source", async () => {
    const runLog = new RecipeRunLog({ dir: path.join(TMP, "live") });
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const activityLog = {
      recordEvent: (type: string, data: Record<string, unknown>) => {
        events.push({ type, data });
      },
    };
    await runYamlRecipe(
      recipe("cron"),
      deps({
        runLog,
        activityLog: activityLog as unknown as RunnerDeps["activityLog"],
        startSource: "manual",
      }),
    );
    expect(runLog.query({}).map((r) => r.trigger)).toEqual(["manual"]);
    expect(runLog.query({ trigger: "manual" })).toHaveLength(1);
    const started = events.find((e) => e.type === "recipe_started");
    expect(started?.data.trigger).toBe("manual");
  });

  it("inbox frontmatter records the start source", async () => {
    const home = path.join(TMP, "home");
    const prev = process.env.PATCHWORK_HOME;
    process.env.PATCHWORK_HOME = home;
    try {
      const written: Array<{ p: string; c: string }> = [];
      await runYamlRecipe(
        {
          name: "start-source",
          trigger: { type: "cron", at: "0 9 * * *" },
          steps: [
            {
              tool: "file.write",
              path: path.join(home, "inbox", "note.md"),
              content: "hi",
            },
          ],
        } as unknown as YamlRecipe,
        deps({
          startSource: "manual",
          writeFile: (p: string, c: string) => {
            written.push({ p, c });
          },
        }),
      );
      const inbox = written.find((w) => w.p.endsWith("note.md"));
      expect(inbox?.c).toMatch(/^---\n[\s\S]*\ntrigger: manual\n/);
    } finally {
      if (prev === undefined) delete process.env.PATCHWORK_HOME;
      else process.env.PATCHWORK_HOME = prev;
    }
  });
});

describe("chained runner — start source", () => {
  const okDeps: ExecutionDeps = {
    executeTool: vi.fn().mockResolvedValue("ok"),
    executeAgent: vi.fn().mockResolvedValue("agent"),
    loadNestedRecipe: vi.fn().mockResolvedValue(null),
  };
  const chained = (): ChainedRecipe =>
    ({
      name: "start-source-chained",
      trigger: { type: "chained" },
      steps: [{ id: "s1", tool: "noop.tool" }],
    }) as unknown as ChainedRecipe;

  it("a manual start records trigger 'manual'", async () => {
    await runChainedRecipe(
      chained(),
      {
        env: {},
        maxConcurrency: 1,
        maxDepth: 3,
        dryRun: false,
        runLogDir: TMP,
        startSource: "manual",
      },
      okDeps,
    );
    expect(rows().map((r) => r.trigger)).toEqual(["manual"]);
  });

  it("no start source ⇒ 'recipe' as before", async () => {
    await runChainedRecipe(
      chained(),
      {
        env: {},
        maxConcurrency: 1,
        maxDepth: 3,
        dryRun: false,
        runLogDir: TMP,
      },
      okDeps,
    );
    expect(rows().map((r) => r.trigger)).toEqual(["recipe"]);
  });
});

describe("RecipeRunLog.parseTrigger", () => {
  it("accepts a manual trigger source", () => {
    expect(RecipeRunLog.parseTrigger("manual:foo")).toEqual({
      trigger: "manual",
      recipeName: "foo",
    });
  });
});
