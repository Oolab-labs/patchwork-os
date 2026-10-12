/**
 * The What-If Preview must say whether recipe steps are gated, and it must say
 * it TRUTHFULLY.
 *
 * It used to report a constant `gatedOnRecipeSteps: false` and print "would
 * gate IF recipe steps were gated — they are NOT gated today". That stopped
 * being true when both runners started consulting the approval gate per step
 * through `computeEffectivePolicy` — real runs record approval-gate
 * rejections of recipe steps. A preview that contradicts the runtime is worse
 * than no preview, because it is believed.
 *
 * The report now carries the verdict of the SAME calculation the runners and
 * `patchwork policy explain` use. These tests pin that agreement: every
 * projected verdict is compared with `computeEffectivePolicy` over the inputs
 * `explainRecipePolicy` builds, and both directions (gated / not gated) are
 * exercised, so hardcoding either value fails.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { explainRecipePolicy } from "../../../commands/policyExplain.js";
import { runRecipeSimulate } from "../../../commands/recipe.js";
import { computeEffectivePolicy } from "../../../governance/effectivePolicy.js";
import { _resetActiveProfileForTesting } from "../../../governance/profile.js";
import { clearConfigCache, loadConfig } from "../../../patchworkConfig.js";
import "../../tools/index.js";

let home: string;
const savedHome = process.env.PATCHWORK_HOME;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sim-gating-"));
  mkdirSync(path.join(home, "recipes"), { recursive: true });
  process.env.PATCHWORK_HOME = home;
  clearConfigCache();
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = savedHome;
  clearConfigCache();
  _resetActiveProfileForTesting();
  rmSync(home, { recursive: true, force: true });
});

function writeConfig(cfg: Record<string, unknown>) {
  const p = path.join(home, "config.json");
  writeFileSync(p, JSON.stringify(cfg));
  clearConfigCache();
  return loadConfig(p);
}

function writeRecipe(name: string, body: string): string {
  const file = path.join(home, "recipes", `${name}.yaml`);
  writeFileSync(file, body);
  return file;
}

const flat = (trigger: string) => `name: sim-gate-probe
trigger:
  type: ${trigger}${trigger === "cron" ? '\n  at: "0 9 * * *"' : ""}
steps:
  - tool: file.read
    path: notes.txt
    into: notes
  - tool: github.create_issue
    repo: example-org/example-repo
    title: "probe"
    into: issue
`;

const chained = `name: sim-gate-chained
trigger:
  type: chained
steps:
  - id: read
    tool: file.read
    path: notes.txt
  - id: file
    tool: github.create_issue
    repo: example-org/example-repo
    title: "probe"
    awaits: [read]
`;

async function simulate(file: string, config: ReturnType<typeof loadConfig>) {
  return runRecipeSimulate(file, {
    policy: { config, workersDir: path.join(home, "workers") },
  });
}

/** What the runtime calculation says for each step, keyed by tool id. */
async function runtimeVerdicts(
  file: string,
  config: ReturnType<typeof loadConfig>,
) {
  const explained = await explainRecipePolicy(file, {
    config,
    workersDir: path.join(home, "workers"),
  });
  return Object.fromEntries(
    explained.steps.map((s) => [s.toolId, computeEffectivePolicy(s.input)]),
  );
}

function byTool(
  report: Awaited<ReturnType<typeof runRecipeSimulate>>,
): Record<string, (typeof report.approvals.projected)[number]> {
  return Object.fromEntries(
    report.approvals.projected.map((p) => [p.tool ?? p.stepId, p]),
  );
}

describe("simulation reports gating from the effective policy", () => {
  it("governed profile: the high-tier write is gated, and the report says so", async () => {
    const file = writeRecipe("sim-gate-probe", flat("cron"));
    const config = writeConfig({ profile: "governed" });
    const report = await simulate(file, config);

    expect(report.schemaVersion).toBe(3);
    expect(report.gatedOnRecipeSteps).toBe(true);
    expect(report.approvals.gatedOnRecipeSteps).toBe(true);
    expect(report.approvals.basis).toBe("effective-policy");
    expect(report.approvals.profile).toBe("governed");
    expect(report.approvals.trigger).toBe("cron");

    const proj = byTool(report);
    expect(proj["github.create_issue"]?.wouldRequireApproval).toBe(true);
    expect(proj["github.create_issue"]?.verdict).toBe(
      "HUMAN_APPROVAL_REQUIRED",
    );
    expect(report.notes.join("\n")).not.toMatch(/NOT gated/);
  });

  it("compat profile with the approval gate off: nothing is gated, and the report says so", async () => {
    const file = writeRecipe("sim-gate-probe", flat("manual"));
    const config = writeConfig({ approvalGate: "off" });
    const report = await simulate(file, config);

    expect(report.gatedOnRecipeSteps).toBe(false);
    expect(report.approvals.gatedOnRecipeSteps).toBe(false);
    // The high-tier step is still LISTED (it is risky) but would not wait.
    const proj = byTool(report);
    expect(proj["github.create_issue"]?.tier).toBe("high");
    expect(proj["github.create_issue"]?.wouldRequireApproval).toBe(false);
  });

  it("compat profile, gate high, CRON trigger: automated runs are not gated", async () => {
    const file = writeRecipe("sim-gate-probe", flat("cron"));
    const config = writeConfig({ approvalGate: "high" });
    const report = await simulate(file, config);
    expect(report.gatedOnRecipeSteps).toBe(false);
    expect(byTool(report)["github.create_issue"]?.wouldRequireApproval).toBe(
      false,
    );
  });

  it("compat profile, gate high, MANUAL trigger: the high-tier step is gated", async () => {
    const file = writeRecipe("sim-gate-probe", flat("manual"));
    const config = writeConfig({ approvalGate: "high" });
    const report = await simulate(file, config);
    expect(report.gatedOnRecipeSteps).toBe(true);
    const proj = byTool(report);
    expect(proj["github.create_issue"]?.wouldRequireApproval).toBe(true);
    // A low-tier read is not projected as needing anyone.
    expect(proj["file.read"]?.wouldRequireApproval ?? false).toBe(false);
  });

  it("a top-level chained run is gated as the runner gates it (as a manual run)", async () => {
    const file = writeRecipe("sim-gate-chained", chained);
    const config = writeConfig({ approvalGate: "high" });
    const report = await simulate(file, config);
    expect(report.gatedOnRecipeSteps).toBe(true);
    expect(byTool(report)["github.create_issue"]?.wouldRequireApproval).toBe(
      true,
    );
  });

  for (const [label, cfg, recipe] of [
    ["governed / cron", { profile: "governed" }, flat("cron")],
    ["compat off / manual", { approvalGate: "off" }, flat("manual")],
    ["compat high / cron", { approvalGate: "high" }, flat("cron")],
    ["compat high / manual", { approvalGate: "high" }, flat("manual")],
    ["compat all / manual", { approvalGate: "all" }, flat("manual")],
  ] as const) {
    it(`every projected verdict equals computeEffectivePolicy (${label})`, async () => {
      const file = writeRecipe("sim-gate-probe", recipe);
      const config = writeConfig(cfg);
      const report = await simulate(file, config);
      const runtime = await runtimeVerdicts(file, config);
      const proj = byTool(report);
      for (const [toolId, eff] of Object.entries(runtime)) {
        const p = proj[toolId];
        const expected = eff.final === "HUMAN_APPROVAL_REQUIRED";
        // A step absent from the projection is one the report says needs
        // nobody — which must then be what the runtime says too.
        expect(p?.wouldRequireApproval ?? false).toBe(expected);
        if (p) expect(p.verdict).toBe(eff.final);
      }
      expect(report.gatedOnRecipeSteps).toBe(
        Object.values(runtime).some((e) => e.consultsApproval),
      );
    });
  }
});
