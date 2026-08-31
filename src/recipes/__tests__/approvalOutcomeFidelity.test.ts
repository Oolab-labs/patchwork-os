/**
 * An approval that EXPIRED is not an approval that was REJECTED.
 *
 * The queue has always known the difference — `ApprovalDecision` is
 * `approved | rejected | expired | cancelled` (approvalQueue.ts), and it is
 * distinguished there precisely because "a human said no" and "nobody was
 * there" need different handling. `ApprovalFn` then returned a `boolean`, so
 * three of those four arrived at the runner as one, and both runners reported
 * every one of them with the same sentence:
 *
 *     Step rejected by approval gate — approval_rejected.
 *
 * That sentence makes a claim about a person. It reached the halt ledger, the
 * `patchwork halts` counters, and — worst — the owner-facing phrasing, which
 * renders it as "You turned down its last request, so it stopped." to an
 * operator who was asleep.
 *
 * Measured on the reference machine before this was written: the durable
 * approval log holds 49 approved, 7 rejected, 27 expired and 23 cancelled, so
 * most non-approvals were never rejections. Two of the four `approval_rejected`
 * halts in the last seven days ran for 300 000 ms exactly — the low tier's TTL
 * — on unattended cron runs.
 *
 * A bare `false` still means what it always did. The gate that cannot say which
 * refusal this was must not have one invented for it: absence stays absence,
 * and the pre-existing sentence is what an unknowing gate keeps producing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { normaliseApprovalVerdict } from "../approvalRequest.js";
import type {
  ChainedRecipe,
  ExecutionDeps,
  RunOptions,
} from "../chainedRunner.js";
import { executeChainedStep } from "../chainedRunner.js";
import {
  approvalHaltFor,
  categoriseHaltReason,
  HALT_CATEGORY_HINTS,
  HALT_CATEGORY_LABELS,
} from "../haltCategory.js";
import { createOutputRegistry } from "../outputRegistry.js";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

const TMP = mkdtempSync(path.join(os.tmpdir(), "approval-fidelity-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    now: () => new Date("2026-08-31T09:00:00Z"),
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

function recipe(): YamlRecipe {
  return {
    name: "approval-fidelity",
    trigger: { type: "manual" },
    steps: [{ tool: "file.write", path: `${TMP}/a`, content: "1" }],
  } as YamlRecipe;
}

describe("flat runner — the refusal that halted the run is named", () => {
  it("an EXPIRED approval is not reported as a rejection", async () => {
    const result = await runYamlRecipe(
      recipe(),
      deps({
        requireApprovalFn: vi.fn(async () => ({
          approved: false,
          refusal: "expired" as const,
        })),
      }),
    );
    const halt = result.stepResults.find((s) => s.status === "error");
    expect(halt?.haltCategory).toBe("approval_expired");
    // The sentence must not claim a person acted.
    expect(halt?.haltReason ?? "").not.toMatch(/rejected/i);
    expect(halt?.haltReason ?? "").toMatch(/expired/i);
  });

  it("a CANCELLED approval is not reported as a rejection", async () => {
    const result = await runYamlRecipe(
      recipe(),
      deps({
        requireApprovalFn: vi.fn(async () => ({
          approved: false,
          refusal: "cancelled" as const,
        })),
      }),
    );
    const halt = result.stepResults.find((s) => s.status === "error");
    expect(halt?.haltCategory).toBe("approval_cancelled");
    expect(halt?.haltReason ?? "").not.toMatch(/rejected/i);
  });

  it("an explicit REJECTED verdict keeps the original sentence", async () => {
    const result = await runYamlRecipe(
      recipe(),
      deps({
        requireApprovalFn: vi.fn(async () => ({
          approved: false,
          refusal: "rejected" as const,
        })),
      }),
    );
    const halt = result.stepResults.find((s) => s.status === "error");
    expect(halt?.haltCategory).toBe("approval_rejected");
  });

  it("a bare `false` is UNCHANGED — an unknowing gate gets no invented refusal", async () => {
    const result = await runYamlRecipe(
      recipe(),
      deps({ requireApprovalFn: vi.fn(async () => false) }),
    );
    const halt = result.stepResults.find((s) => s.status === "error");
    expect(halt?.haltCategory).toBe("approval_rejected");
    expect(halt?.haltReason).toBe(
      "Step rejected by approval gate — approval_rejected.",
    );
  });

  it("an approved verdict object runs the step", async () => {
    let writes = 0;
    await runYamlRecipe(
      recipe(),
      deps({
        requireApprovalFn: vi.fn(async () => ({ approved: true })),
        writeFile: () => {
          writes++;
        },
      }),
    );
    expect(writes).toBe(1);
  });
});

const baseOptions: RunOptions = {
  env: {},
  maxConcurrency: 4,
  maxDepth: 3,
  dryRun: false,
};
const recipeNoTrigger = { name: "r", steps: [] } as unknown as ChainedRecipe;

describe("chained runner — same refusal, same words", () => {
  it("an EXPIRED approval categorises as approval_expired, not rejected", async () => {
    const executeTool = vi.fn().mockResolvedValue({ ok: true });
    const result = await executeChainedStep(
      {
        registry: createOutputRegistry(),
        step: { id: "s", tool: "github.list_prs" },
        options: baseOptions,
        recipe: recipeNoTrigger,
        depth: 0,
      } as unknown as Parameters<typeof executeChainedStep>[0],
      {
        executeTool,
        executeAgent: vi.fn(),
        loadNestedRecipe: vi.fn().mockResolvedValue(null),
        requireApprovalFn: vi.fn(async () => ({
          approved: false,
          refusal: "expired" as const,
        })),
      } as unknown as ExecutionDeps,
    );
    expect(result.success).toBe(false);
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.error ?? "").not.toMatch(/rejected/i);
    expect(categoriseHaltReason(result.error)).toBe("approval_expired");
  });
});

describe("the categoriser and the operator hint", () => {
  it("routes each approval sentence to its own category", () => {
    expect(
      categoriseHaltReason(
        "Step rejected by approval gate — approval_rejected.",
      ),
    ).toBe("approval_rejected");
    expect(
      categoriseHaltReason(
        "Step approval expired before anyone answered — approval_expired.",
      ),
    ).toBe("approval_expired");
    expect(
      categoriseHaltReason(
        "Step approval cancelled with the run — approval_cancelled.",
      ),
    ).toBe("approval_cancelled");
  });

  it("does NOT tell an operator to approve a request that no longer exists", () => {
    // The whole cost of the old conflation: the rejection hint sends someone to
    // the dashboard to approve a queue entry the TTL already resolved.
    expect(HALT_CATEGORY_HINTS.approval_expired).not.toMatch(/approve/i);
    expect(HALT_CATEGORY_HINTS.approval_expired).toMatch(
      /answer|timed out|expir/i,
    );
    expect(HALT_CATEGORY_LABELS.approval_expired).toBeTruthy();
    expect(HALT_CATEGORY_LABELS.approval_cancelled).toBeTruthy();
  });
});

/**
 * The WIRING, not the logic.
 *
 * Everything above injects a gate by hand, which proves the runners read a
 * refusal correctly and proves nothing about whether anything in production
 * ever produces one. That gap is how a fix lands complete and inert: the
 * runner learns a new vocabulary and the only two callers keep speaking the
 * old one. So this drives the real tier gate against a real queue and lets the
 * TTL fire.
 */
describe("the tier gate reports the queue's actual decision", () => {
  it("an expired queue entry arrives at the runner AS an expiry", async () => {
    const { getApprovalQueue, resetApprovalQueueForTests } = await import(
      "../../approvalQueue.js"
    );
    const { makeRecipeApprovalFn } = await import(
      "../../recipeOrchestration.js"
    );
    resetApprovalQueueForTests();
    // 10ms on every tier so the wait really resolves "expired" — the same
    // path the live 5-minute low-tier TTL takes, just without the wait.
    getApprovalQueue({ ttlMs: { low: 10, medium: 10, high: 10 } });
    try {
      const gate = await makeRecipeApprovalFn("all");
      const verdict = normaliseApprovalVerdict(
        await gate({
          toolId: "github.list_prs",
          tier: "low",
          runTaskId: "yaml:dependency-bump:1",
        }),
      );
      expect(verdict.approved).toBe(false);
      // The precise claim: NOT "rejected". A boolean-returning producer fails
      // here with `refusal: undefined` even though `approved` is already right.
      expect(verdict.refusal).toBe("expired");
      expect(approvalHaltFor(verdict.refusal).category).toBe(
        "approval_expired",
      );
    } finally {
      resetApprovalQueueForTests();
    }
  });
});
