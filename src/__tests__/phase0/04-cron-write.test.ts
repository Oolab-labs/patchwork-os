/**
 * Phase 0 acceptance — scenario 4: the same write under manual vs cron.
 *
 * Under governed a trigger is not a way around the gate: the approval fn is
 * consulted with the SAME effective verdict for a manual and a cron run of
 * an identical recipe, for both a non-reversible write and a plain read.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runYamlRecipe, type YamlRecipe } from "../../recipes/yamlRunner.js";
import {
  baseDeps,
  governed,
  makeSandbox,
  recordingApproval,
  registerFakeTool,
  resetGovernanceState,
} from "./_harness.js";

const sandbox = makeSandbox("cron");
afterAll(() => sandbox.dispose());

function recipe(trigger: "manual" | "cron"): YamlRecipe {
  return {
    name: "nightly-post",
    trigger:
      trigger === "cron"
        ? { type: "cron", schedule: "0 2 * * *" }
        : { type: "manual" },
    steps: [
      { tool: "notes.read", into: "notes" },
      {
        tool: "http.post",
        url: "https://example.test/hook",
        body: "{{notes}}",
        into: "r",
      },
    ],
  } as unknown as YamlRecipe;
}

async function verdictsFor(trigger: "manual" | "cron") {
  const profile = governed();
  registerFakeTool({
    id: "notes.read",
    isWrite: false,
    execute: async () => "n",
  });
  const post = registerFakeTool({
    id: "http.post",
    isWrite: true,
    riskDefault: "medium",
    execute: async () => "ok",
  });
  const approval = recordingApproval(() => true);
  await runYamlRecipe(
    recipe(trigger),
    baseDeps(sandbox, { governance: profile, requireApprovalFn: approval.fn }),
  );
  return {
    verdicts: approval.calls.map((c) => [c.toolId, c.effective] as const),
    posted: post.mock.calls.length,
  };
}

describe("scenario 4 — cron is gated like manual under governed", () => {
  beforeEach(resetGovernanceState);
  afterEach(resetGovernanceState);

  it("consults the approval fn with identical verdicts for manual and cron", async () => {
    const manual = await verdictsFor("manual");
    resetGovernanceState();
    const cron = await verdictsFor("cron");
    expect(manual.verdicts).toEqual(cron.verdicts);
    expect(cron.verdicts).toContainEqual([
      "http.post",
      "HUMAN_APPROVAL_REQUIRED",
    ]);
    expect(cron.verdicts).toContainEqual(["notes.read", "ALLOW"]);
    expect(manual.posted).toBe(1);
    expect(cron.posted).toBe(1);
  });
});
