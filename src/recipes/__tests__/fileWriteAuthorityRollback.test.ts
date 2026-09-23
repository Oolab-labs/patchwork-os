/**
 * INV-1: a file write's reversibility is established BEFORE authority is
 * granted and re-checked immediately before the write.
 *
 * Before this, `fs-write` was `reversible` by domain, so the worker gate let
 * every automated `file.write` flow ungated — and automated runs are never given
 * a rollback log, so there was nothing to undo with.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolFactsFor } from "../../governance/toolFacts.js";
import type { ApprovalRequestInput } from "../approvalRequest.js";
import { type ExecutionDeps, executeChainedStep } from "../chainedRunner.js";
import { FileRollbackLog } from "../fileRollback.js";
import { stepRollbackability } from "../fileWriteRollbackability.js";
import { createOutputRegistry } from "../outputRegistry.js";
import {
  buildChainedDeps,
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

let TMP: string;
let LEDGER: string;
beforeEach(() => {
  TMP = mkdtempSync(path.join(os.tmpdir(), "fw-authority-"));
  LEDGER = mkdtempSync(path.join(os.tmpdir(), "fw-ledger-"));
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(LEDGER, { recursive: true, force: true });
});

function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    now: () => new Date("2026-09-23T12:00:00Z"),
    logDir: TMP,
    testMode: false,
    workdir: TMP,
    readFile: () => {
      throw new Error("nf");
    },
    writeFile: (p: string, c: string) => writeFileSync(p, c),
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
    ...extra,
  } as RunnerDeps;
}

const recipe = (trigger: string, target: string): YamlRecipe =>
  ({
    name: "fw-authority",
    trigger: { type: trigger },
    steps: [{ tool: "file.write", path: target, content: "new" }],
  }) as YamlRecipe;

describe("stepRollbackability", () => {
  it("is undefined for tools that are not rollback-backed file writes", () => {
    expect(
      stepRollbackability("slack.post_message", {}, { workdir: TMP }),
    ).toBeUndefined();
  });

  it("no rollback log → unavailable", () => {
    expect(
      stepRollbackability(
        "file.write",
        { path: path.join(TMP, "a.md") },
        { workdir: TMP },
      ),
    ).toBe("unavailable");
  });

  it("log + absent target → confirmed; log + symlink → uncertain", () => {
    const log = new FileRollbackLog({ dir: LEDGER, scopeKey: "s" });
    expect(
      stepRollbackability(
        "file.append",
        { path: path.join(TMP, "a.md") },
        { workdir: TMP, fileRollbackLog: log },
      ),
    ).toBe("confirmed");
    writeFileSync(path.join(TMP, "real.md"), "x");
    symlinkSync(path.join(TMP, "real.md"), path.join(TMP, "link.md"));
    expect(
      stepRollbackability(
        "file.write",
        { path: path.join(TMP, "link.md") },
        { workdir: TMP, fileRollbackLog: log },
      ),
    ).toBe("uncertain");
  });
});

describe("toolFactsFor carries the instance ceiling to the governed profile", () => {
  it("unconfirmed file.write is NOT reversible to the policy layer", () => {
    expect(toolFactsFor("file.write").reversibility).toBe("reversible");
    expect(
      toolFactsFor("file.write", undefined, {
        reversibilityCeiling: "irreversible",
      }).reversibility,
    ).toBe("irreversible");
  });
});

describe("flat runner: the gate sees the instance's real reversibility", () => {
  it("automated worker run with no rollback log → approval input says irreversible", async () => {
    const requireApprovalFn = vi.fn(
      async (_input: ApprovalRequestInput) => true,
    );
    await runYamlRecipe(
      recipe("cron", path.join(TMP, "out.md")),
      deps({ requireApprovalFn, gateAutomatedRuns: true }),
    );
    expect(requireApprovalFn).toHaveBeenCalledTimes(1);
    expect(requireApprovalFn.mock.calls[0]?.[0]).toMatchObject({
      toolId: "file.write",
      reversibilityCeiling: "irreversible",
    });
  });

  it("manual run with a confirmed rollback log → no ceiling (reversible as before)", async () => {
    const requireApprovalFn = vi.fn(
      async (_input: ApprovalRequestInput) => true,
    );
    await runYamlRecipe(
      recipe("manual", path.join(TMP, "out.md")),
      deps({
        requireApprovalFn,
        ledgerDir: LEDGER,
        manualRunId: "attempt-1",
      }),
    );
    expect(requireApprovalFn).toHaveBeenCalledTimes(1);
    const input = requireApprovalFn.mock.calls[0]?.[0];
    expect(input?.reversibilityCeiling).toBeUndefined();
  });

  it("refuses the write when rollbackability WORSENS between decision and execution", async () => {
    const target = path.join(TMP, "out.md");
    const other = path.join(TMP, "elsewhere.md");
    writeFileSync(other, "do not touch");
    // Decided while `target` was absent (confirmed: undo = delete). During the
    // approval wait, the path becomes a symlink — the write would now go
    // through it with no capturable pre-image.
    const requireApprovalFn = vi.fn(async () => {
      symlinkSync(other, target);
      return true;
    });
    const result = await runYamlRecipe(
      recipe("manual", target),
      deps({
        requireApprovalFn,
        ledgerDir: LEDGER,
        manualRunId: "attempt-2",
      }),
    );
    expect(result.errorMessage ?? "").toMatch(/rollback_capability_worsened/);
    expect(existsSync(other)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(other, "utf-8")).toBe("do not touch");
  });
});

describe("chained runner: same pre-decision assessment and dispatch hand-off", () => {
  it("passes the ceiling to the gate and the decision-time value to dispatch", async () => {
    const executeTool = vi.fn().mockResolvedValue("ok");
    const requireApprovalFn = vi.fn(
      async (_input: ApprovalRequestInput) => true,
    );
    const deps: ExecutionDeps = {
      executeTool,
      executeAgent: vi.fn(),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
      requireApprovalFn,
      assessRollback: () => "unavailable",
    };
    await executeChainedStep(
      {
        registry: createOutputRegistry(),
        step: { id: "w", tool: "file.write", path: "a.md", content: "x" },
        options: { env: {}, maxConcurrency: 1, maxDepth: 3, dryRun: false },
        recipe: { name: "chained-fw", steps: [] },
        depth: 0,
      },
      deps,
    );
    expect(requireApprovalFn.mock.calls[0]?.[0]).toMatchObject({
      reversibilityCeiling: "irreversible",
    });
    expect(executeTool.mock.calls[0]?.[3]).toBe("unavailable");
  });

  it("buildChainedDeps assesses from the run's own rollback log (none ⇒ unavailable)", () => {
    const chained = buildChainedDeps(deps());
    expect(
      chained.assessRollback?.("file.write", { path: path.join(TMP, "a.md") }),
    ).toBe("unavailable");
    expect(chained.assessRollback?.("slack.post_message", {})).toBeUndefined();
  });
});

describe("the write is refused when its pre-image could not be saved", () => {
  it("rollback log present but unwritable → no write, named error", async () => {
    const target = path.join(TMP, "out.md");
    writeFileSync(target, "original");
    // The log file path is a directory, so the pre-image row cannot be appended.
    mkdirSync(path.join(LEDGER, "file_rollback.jsonl"));
    const result = await runYamlRecipe(
      recipe("manual", target),
      deps({ ledgerDir: LEDGER, manualRunId: "attempt-3" }),
    );
    expect(result.errorMessage ?? "").toMatch(
      /rollback_preimage_not_persisted/,
    );
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(target, "utf-8")).toBe("original");
  });
});
