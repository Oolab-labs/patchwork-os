/**
 * outcomes.classify_issues — deterministic replacement for the LLM-judged
 * classify step in outcome-ingester.yaml.
 *
 * Bug this guards against: the prior recipe design asked an LLM agent to
 * read raw issue JSON and freehand a disposition + checkedAt epoch. Real
 * dogfood runs showed this was non-deterministic — the SAME closed/COMPLETED
 * issues (#1041, #1046) flipped between "confirmed" and "unknown" on
 * alternating cron fires, and checkedAt was a hallucinated epoch spanning
 * 2023–2027 instead of the actual run time. This tool removes the LLM from
 * the classification path entirely — it's pure data (classifyIssueDisposition)
 * plus the real clock.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../outcomes.js";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

function ctx(params: Record<string, unknown>) {
  return {
    params,
    step: {} as Record<string, unknown>,
    ctx: {} as RunContext,
    deps: { workdir: process.cwd() } as StepDeps,
  };
}

let tmpHome: string;
let origPatchworkHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "outcomes-tool-test-"));
  origPatchworkHome = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = tmpHome;
});

afterEach(() => {
  if (origPatchworkHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = origPatchworkHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("outcomes.classify_issues", () => {
  it("classifies deterministically from state/stateReason/labels — no LLM judgment", async () => {
    const tool = getTool("outcomes.classify_issues");
    const issues = [
      {
        url: "https://github.com/o/r/issues/1041",
        state: "closed",
        stateReason: "completed",
        labels: [],
      },
      {
        url: "https://github.com/o/r/issues/1046",
        state: "closed",
        stateReason: "completed",
        labels: [],
      },
      {
        url: "https://github.com/o/r/issues/1050",
        state: "open",
        stateReason: null,
        labels: [],
      },
      {
        url: "https://github.com/o/r/issues/1099",
        state: "closed",
        stateReason: "not_planned",
        labels: ["invalid"],
      },
    ];

    // Run classification twice — a real cron would fire this repeatedly
    // against unchanged issue state, and the result MUST be identical both
    // times (this is exactly what the LLM-judge step got wrong).
    const out1 = await tool?.execute(ctx({ issues: JSON.stringify(issues) }));
    const out2 = await tool?.execute(ctx({ issues: JSON.stringify(issues) }));

    const parsed1 = JSON.parse(out1 ?? "{}");
    const parsed2 = JSON.parse(out2 ?? "{}");
    expect(parsed1).toEqual(parsed2);
    expect(parsed1.confirmed).toBe(2);
    expect(parsed1.junk).toBe(1);
    expect(parsed1.unknown).toBe(1);
  });

  it("persists real checkedAt (current time), not a hallucinated epoch", async () => {
    const tool = getTool("outcomes.classify_issues");
    const before = Date.now();
    await tool?.execute(
      ctx({
        issues: JSON.stringify([
          {
            url: "https://github.com/o/r/issues/2001",
            state: "closed",
            stateReason: "completed",
            labels: [],
          },
        ]),
      }),
    );
    const after = Date.now();

    const logPath = join(tmpHome, "outcome-log.jsonl");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const record = JSON.parse(lines[lines.length - 1] as string);
    expect(record.checkedAt).toBeGreaterThanOrEqual(before);
    expect(record.checkedAt).toBeLessThanOrEqual(after);
  });

  it("persists via OutcomeStore so trust-replay reads see the disposition", async () => {
    const tool = getTool("outcomes.classify_issues");
    await tool?.execute(
      ctx({
        issues: JSON.stringify([
          {
            url: "https://github.com/o/r/issues/3001",
            state: "closed",
            stateReason: "completed",
            labels: [],
          },
        ]),
      }),
    );

    const logPath = join(tmpHome, "outcome-log.jsonl");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const record = JSON.parse(lines[lines.length - 1] as string);
    expect(record.issueUrl).toBe("https://github.com/o/r/issues/3001");
    expect(record.disposition).toBe("confirmed");
  });

  it("handles an empty issues array without writing anything", async () => {
    const tool = getTool("outcomes.classify_issues");
    const out = await tool?.execute(ctx({ issues: "[]" }));
    const parsed = JSON.parse(out ?? "{}");
    expect(parsed).toEqual({ count: 0, confirmed: 0, junk: 0, unknown: 0 });
  });

  it("is risk-tier 'high' — it mutates the worker trust ledger from unverified caller-supplied data (security delta sweep 2026-07-06)", () => {
    // The `issues` param is a caller-supplied JSON string with no re-fetch or
    // verification against real GitHub state — a recipe step (or an earlier
    // LLM agent step in the same recipe) can fabricate a "closed/completed"
    // issue payload and this tool will persist a "confirmed" disposition that
    // directly feeds WorkerShadowObserver.ingestRun's trust-replay. The HTTP
    // route POST /outcomes has an explicit self-confirm prohibition for this
    // exact reason; this tool must be gated at least as strictly under
    // approvalGate:"high" so it isn't fully autonomous by default.
    const tool = getTool("outcomes.classify_issues");
    expect(tool?.riskDefault).toBe("high");
  });
});
