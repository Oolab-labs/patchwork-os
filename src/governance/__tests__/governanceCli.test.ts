/**
 * `patchwork profile`, `patchwork policy explain` and the doctor governance
 * section — every line comes from runtime-effective state, and the explain
 * output is the same calculation the runner enforces with.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runProfileCommand } from "../../commands/profile.js";
import { explainRecipePolicy, formatExplainReport } from "../../commands/policyExplain.js";
import { clearConfigCache, loadConfig } from "../../patchworkConfig.js";
import { formatGovernanceReport, governanceReport } from "../doctorReport.js";
import { _resetActiveProfileForTesting } from "../profile.js";
import "../../recipes/tools/index.js";

let home: string;
let configPath: string;
const savedHome = process.env.PATCHWORK_HOME;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "gov-cli-"));
  mkdirSync(path.join(home, "recipes"), { recursive: true });
  configPath = path.join(home, "config.json");
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

function writeConfig(extra: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify({ model: "claude", ...extra }));
  clearConfigCache();
}

describe("governanceReport", () => {
  it("compat install is NOT GOVERNED with the six default-off reasons", () => {
    writeConfig({});
    const r = governanceReport({ config: loadConfig(configPath), recipesDir: path.join(home, "recipes"), workersDir: path.join(home, "workers") });
    expect(r.governed).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/approval gate is off/);
    expect(r.reasons.join("\n")).toMatch(/bypass approval/);
    expect(r.reasons.join("\n")).toMatch(/dangerously-skip-permissions/);
    expect(r.reasons.join("\n")).toMatch(/servers: entries/);
    expect(formatGovernanceReport(r)).toMatch(/STATUS: NOT GOVERNED/);
  });
  it("governed + a registered destination is GOVERNED; missing destination is the one remaining reason", () => {
    writeConfig({ profile: "governed" });
    const noDest = governanceReport({ config: loadConfig(configPath), recipesDir: path.join(home, "recipes"), workersDir: path.join(home, "workers") });
    expect(noDest.governed).toBe(false);
    expect(noDest.reasons).toHaveLength(1);
    expect(noDest.reasons[0]).toMatch(/no model destination/);
    writeConfig({
      profile: "governed",
      privacy: { destinations: { local: { type: "local", drivers: ["local"], classifications: ["public", "internal", "confidential", "restricted"] } } },
    });
    const r = governanceReport({ config: loadConfig(configPath), recipesDir: path.join(home, "recipes"), workersDir: path.join(home, "workers") });
    expect(r.governed).toBe(true);
    expect(formatGovernanceReport(r)).toMatch(/STATUS: GOVERNED/);
    expect(r.lines.find((l) => l.key === "killSwitch")?.value).toMatch(/fails closed/);
    expect(r.lines.find((l) => l.key === "automatedRuns")?.value).toBe("GATED");
  });
  it("a refused installed plugin spec makes the posture NOT GOVERNED", () => {
    writeConfig({ profile: "governed", privacy: { destinations: { local: { type: "local", drivers: ["local"], classifications: ["restricted"] } } } });
    writeFileSync(path.join(home, "recipes", "evil.yaml"), "name: evil\ntrigger: { type: manual }\nservers: ['./nope']\nsteps: []\n");
    const r = governanceReport({ config: loadConfig(configPath), recipesDir: path.join(home, "recipes"), workersDir: path.join(home, "workers") });
    expect(r.governed).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/not allowlisted/);
  });
});

describe("patchwork profile", () => {
  it("sets and reads the profile; show exits 1 while not governed", () => {
    writeConfig({});
    const set = runProfileCommand(["governed"], { configPath });
    expect(set.ok).toBe(true);
    expect(set.text).toMatch(/\(unset\) → governed/);
    clearConfigCache();
    expect(loadConfig(configPath).profile).toBe("governed");
    const back = runProfileCommand(["compat"], { configPath });
    expect(back.text).toMatch(/governed → compat/);
    const bad = runProfileCommand(["yolo"], { configPath });
    expect(bad.exitCode).toBe(2);
    const show = runProfileCommand(["show"], { configPath });
    expect(show.exitCode).toBe(1);
    expect(show.text).toMatch(/NOT GOVERNED/);
  });
});

describe("patchwork policy explain", () => {
  const recipe = `name: invoice-review
trigger: { type: cron, schedule: "0 9 * * *" }
steps:
  - tool: file.read
    path: ./in.txt
    into: doc
  - agent:
      prompt: "summarise {{doc}}"
      into: summary
  - tool: file.write
    path: ./out.txt
    content: "{{summary}}"
  - tool: http.post
    url: https://example.test/hook
    body: "{{summary}}"
`;
  it("compat: cron never consults approval; governed: writes need a human, contained agent flows", async () => {
    writeFileSync(path.join(home, "recipes", "invoice-review.yaml"), recipe);
    writeConfig({ approvalGate: "high" });
    const compat = await explainRecipePolicy("invoice-review", { recipesDir: path.join(home, "recipes"), workersDir: path.join(home, "workers"), config: loadConfig(configPath) });
    expect(compat.steps.map((s) => s.result.final)).toEqual(["ALLOW", "ALLOW", "ALLOW", "ALLOW"]);
    expect(compat.steps[2]?.result.stages.find((s) => s.stage === "trigger")?.verdict).toBe("SKIP");

    writeConfig({ profile: "governed" });
    const gov = await explainRecipePolicy("invoice-review", { recipesDir: path.join(home, "recipes"), workersDir: path.join(home, "workers"), config: loadConfig(configPath) });
    const finals = Object.fromEntries(gov.steps.map((s) => [s.toolId, s.result.final]));
    expect(finals["file.read"]).toBe("ALLOW");
    expect(finals.agent).toBe("ALLOW"); // contained
    expect(finals["file.write"]).toBe("ALLOW"); // reversible write flows
    expect(finals["http.post"]).toBe("HUMAN_APPROVAL_REQUIRED"); // irreversible write asks
    const text = formatExplainReport(gov);
    expect(text).toMatch(/TRIGGER: CRON/);
    expect(text).toMatch(/gated like a manual run/);
    expect(text).toMatch(/FINAL RESULT: HUMAN APPROVAL REQUIRED/);
  });
  it("tool filter restricts steps; unknown recipe throws", async () => {
    writeFileSync(path.join(home, "recipes", "invoice-review.yaml"), recipe);
    writeConfig({ profile: "governed" });
    const only = await explainRecipePolicy("invoice-review", { recipesDir: path.join(home, "recipes"), workersDir: path.join(home, "workers"), config: loadConfig(configPath), tool: "http.post" });
    expect(only.steps).toHaveLength(1);
    await expect(explainRecipePolicy("nope", { recipesDir: path.join(home, "recipes"), config: loadConfig(configPath) })).rejects.toThrow(/not found/);
  });
});

describe("recipe run --local under the governed profile", () => {
  it("compat injects nothing; governed injects the profile and a fail-closed terminal gate", async () => {
    const { resolveLocalGovernance } = await import("../../commands/recipe.js");
    writeConfig({});
    expect(await resolveLocalGovernance(undefined)).toEqual({});
    writeConfig({ profile: "governed" });
    const noTty = await resolveLocalGovernance(undefined, { isTTY: false });
    expect(noTty.governance?.mode).toBe("governed");
    const fn = noTty.requireApprovalFn as NonNullable<typeof noTty.requireApprovalFn>;
    expect(await fn({ toolId: "http.post", tier: "medium", runTaskId: "t", effective: "ALLOW" })).toBe(true);
    expect(
      await fn({ toolId: "http.post", tier: "medium", runTaskId: "t", effective: "HUMAN_APPROVAL_REQUIRED" }),
    ).toMatchObject({ approved: false });
    const yes = await resolveLocalGovernance(undefined, { isTTY: true, ask: async () => "y" });
    const fnYes = yes.requireApprovalFn as NonNullable<typeof yes.requireApprovalFn>;
    expect(await fnYes({ toolId: "http.post", tier: "medium", runTaskId: "t", effective: "HUMAN_APPROVAL_REQUIRED" })).toBe(true);
    const no = await resolveLocalGovernance(undefined, { isTTY: true, ask: async () => "" });
    const fnNo = no.requireApprovalFn as NonNullable<typeof no.requireApprovalFn>;
    expect(await fnNo({ toolId: "http.post", tier: "medium", runTaskId: "t", effective: "HUMAN_APPROVAL_REQUIRED" })).toMatchObject({ approved: false });
    // caller-supplied deps win
    expect(await resolveLocalGovernance({ governance: (await import("../profile.js")).COMPAT_PROFILE })).toEqual({});
  });
});
