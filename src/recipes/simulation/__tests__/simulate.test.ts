import { describe, expect, it } from "vitest";
import type { RecipeDryRunPlan } from "../../../commands/recipe.js";
import {
  computeEffectiveRisks,
  maxRisk,
  summarizeRunRisk,
} from "../aggregateRunRisk.js";
import { classifyStepSideEffect } from "../sideEffects.js";
import { simulateFromPlan } from "../simulate.js";

function makePlan(over: Partial<RecipeDryRunPlan>): RecipeDryRunPlan {
  return {
    schemaVersion: 1,
    recipe: "test-recipe",
    mode: "dry-run",
    triggerType: "manual",
    generatedAt: "2026-06-05T00:00:00.000Z",
    steps: [],
    lint: { errors: [], warnings: [] },
    ...over,
  };
}

describe("classifyStepSideEffect", () => {
  it("maps agent and recipe step types", () => {
    expect(classifyStepSideEffect({ type: "agent" })).toBe("agent-llm");
    expect(classifyStepSideEffect({ type: "recipe" })).toBe("nested-recipe");
  });

  it("returns unknown for unresolved tools", () => {
    expect(
      classifyStepSideEffect({
        type: "tool",
        tool: "mystery.thing",
        resolved: false,
      }),
    ).toBe("unknown");
  });

  it("treats http/webhook namespaces as external-http regardless of write", () => {
    expect(
      classifyStepSideEffect({
        type: "tool",
        tool: "http.request",
        resolved: true,
      }),
    ).toBe("external-http");
    expect(
      classifyStepSideEffect({
        type: "tool",
        tool: "webhook.post",
        namespace: "webhook",
        resolved: true,
        isWrite: true,
      }),
    ).toBe("external-http");
  });

  it("splits connector vs local on isConnector + isWrite", () => {
    expect(
      classifyStepSideEffect({
        type: "tool",
        tool: "github.create_pr",
        resolved: true,
        isConnector: true,
        isWrite: true,
      }),
    ).toBe("connector-write");
    expect(
      classifyStepSideEffect({
        type: "tool",
        tool: "github.list_prs",
        resolved: true,
        isConnector: true,
        isWrite: false,
      }),
    ).toBe("connector-read");
    expect(
      classifyStepSideEffect({
        type: "tool",
        tool: "file.write",
        resolved: true,
        isWrite: true,
      }),
    ).toBe("local-write");
    expect(
      classifyStepSideEffect({
        type: "tool",
        tool: "git.log",
        resolved: true,
        isWrite: false,
      }),
    ).toBe("local-read");
  });
});

describe("computeEffectiveRisks", () => {
  it("propagates a high upstream dependency down to a low dependent (chained)", () => {
    const eff = computeEffectiveRisks(
      [
        { id: "a", baseRisk: "high" },
        { id: "b", baseRisk: "low", dependencies: ["a"] },
        { id: "c", baseRisk: "low", dependencies: ["b"] },
        { id: "d", baseRisk: "medium" },
      ],
      "chained",
    );
    expect(eff.get("a")).toBe("high");
    expect(eff.get("b")).toBe("high");
    expect(eff.get("c")).toBe("high");
    expect(eff.get("d")).toBe("medium"); // independent branch unaffected
  });

  it("uses a linear running max for flat recipes", () => {
    const eff = computeEffectiveRisks(
      [
        { id: "a", baseRisk: "low" },
        { id: "b", baseRisk: "medium" },
        { id: "c", baseRisk: "low" },
        { id: "d", baseRisk: "high" },
      ],
      "flat",
    );
    expect(eff.get("a")).toBe("low");
    expect(eff.get("b")).toBe("medium");
    expect(eff.get("c")).toBe("medium");
    expect(eff.get("d")).toBe("high");
  });

  it("does not infinite-loop on a dependency cycle", () => {
    const eff = computeEffectiveRisks(
      [
        { id: "a", baseRisk: "low", dependencies: ["b"] },
        { id: "b", baseRisk: "medium", dependencies: ["a"] },
      ],
      "chained",
    );
    expect(eff.get("a")).toBe("medium");
    expect(eff.get("b")).toBe("medium");
  });

  it("maxRisk orders tiers correctly", () => {
    expect(maxRisk("low", "high")).toBe("high");
    expect(maxRisk("medium", "low")).toBe("medium");
  });
});

describe("summarizeRunRisk", () => {
  it("derives score + components and escalates tier on a high step", () => {
    const s = summarizeRunRisk([
      { effectiveRisk: "high", sideEffect: "connector-write", resolved: true },
      { effectiveRisk: "low", sideEffect: "local-read", resolved: true },
    ]);
    expect(s.components.highSteps).toBe(1);
    expect(s.components.connectorWriteSteps).toBe(1);
    expect(s.components.writeSteps).toBe(1);
    expect(s.highestStepRisk).toBe("high");
    expect(s.tier).toBe("high");
    expect(s.score).toBeGreaterThan(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });

  it("stays low for a read-only plan", () => {
    const s = summarizeRunRisk([
      { effectiveRisk: "low", sideEffect: "local-read", resolved: true },
      { effectiveRisk: "low", sideEffect: "connector-read", resolved: true },
    ]);
    expect(s.tier).toBe("low");
    expect(s.score).toBe(0);
  });
});

describe("simulateFromPlan", () => {
  it("is honest about the approval gate on every report", () => {
    const report = simulateFromPlan(makePlan({}));
    expect(report.gatedOnRecipeSteps).toBe(false);
    expect(report.approvals.gatedOnRecipeSteps).toBe(false);
    expect(report.kind).toBe("what-if-preview");
    expect(report.fidelity).toBe("static");
    expect(report.notes.some((n) => n.includes("NOT gated"))).toBe(true);
  });

  it("reuses the plan timestamp (pure, no clock dependency)", () => {
    const report = simulateFromPlan(
      makePlan({ generatedAt: "2020-01-02T03:04:05.000Z" }),
    );
    expect(report.generatedAt).toBe("2020-01-02T03:04:05.000Z");
  });

  it("estimates cost heuristically for a flat recipe with an agent prompt", () => {
    const report = simulateFromPlan(
      makePlan({
        triggerType: "manual",
        steps: [
          { id: "draft", type: "agent", prompt: "x".repeat(40), into: "draft" },
        ],
      }),
    );
    expect(report.topology).toBe("flat");
    expect(report.cost.basis).toBe("heuristic");
    expect(report.cost.estPromptTokens).toBe(10); // 40 chars / 4
    expect(report.cost.estimatedAgentSteps).toBe(1);
    expect(report.cost.usd).toBeNull();
  });

  it("reports cost unavailable when there are no agent steps", () => {
    const report = simulateFromPlan(
      makePlan({
        steps: [
          {
            id: "read",
            type: "tool",
            tool: "git.log",
            risk: "low",
            resolved: true,
          },
        ],
      }),
    );
    expect(report.cost.basis).toBe("unavailable");
    expect(report.cost.estPromptTokens).toBeNull();
    expect(report.cost.note).toContain("no model cost");
  });

  it("reports cost unavailable for chained agent steps that carry no prompt", () => {
    const report = simulateFromPlan(
      makePlan({
        triggerType: "chained",
        steps: [{ id: "judge", type: "agent" }],
      }),
    );
    expect(report.topology).toBe("chained");
    expect(report.cost.basis).toBe("unavailable");
    expect(report.cost.note).toContain("not present in the static plan");
  });

  it("projects approvals, side effects, risk and undetermined branches (chained)", () => {
    const report = simulateFromPlan(
      makePlan({
        triggerType: "chained",
        connectorNamespaces: ["github"],
        steps: [
          {
            id: "fetch",
            type: "tool",
            tool: "github.list_prs",
            namespace: "github",
            risk: "low",
            isConnector: true,
            isWrite: false,
            resolved: true,
          },
          {
            id: "open_pr",
            type: "tool",
            tool: "github.create_pr",
            namespace: "github",
            risk: "high",
            isConnector: true,
            isWrite: true,
            resolved: true,
            dependencies: ["fetch"],
            condition: "{{ fetch.count }}",
          },
        ],
      }),
    );

    // side-effect taxonomy
    expect(report.summary.sideEffectCounts["connector-read"]).toBe(1);
    expect(report.summary.sideEffectCounts["connector-write"]).toBe(1);
    expect(report.summary.connectorNamespaces).toEqual(["github"]);
    expect(report.summary.writeSteps).toBe(1);

    // blast radius: the read feeds nothing higher, the write is high
    const openPr = report.steps.find((s) => s.id === "open_pr");
    expect(openPr?.effectiveRisk).toBe("high");
    expect(report.risk.tier).toBe("high");

    // approval projection: the high write would gate; flagged not-gated-today
    const proj = report.approvals.projected.find((a) => a.stepId === "open_pr");
    expect(proj?.wouldRequireApproval).toBe(true);
    expect(proj?.tier).toBe("high");

    // honest branches: the condition is left undetermined, never faked
    expect(report.branches).toHaveLength(1);
    expect(report.branches[0]?.stepId).toBe("open_pr");
    expect(report.branches[0]?.outcome).toBe("undetermined");
  });

  it("flags unresolved tools and adds a note", () => {
    const report = simulateFromPlan(
      makePlan({
        steps: [
          { id: "x", type: "tool", tool: "mystery.thing", resolved: false },
        ],
      }),
    );
    expect(report.summary.unresolvedSteps).toBe(1);
    expect(report.summary.sideEffectCounts.unknown).toBe(1);
    expect(
      report.notes.some((n) => n.includes("unknown to the registry")),
    ).toBe(true);
  });
});
