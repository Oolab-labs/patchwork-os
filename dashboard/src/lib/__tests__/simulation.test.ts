import { describe, expect, it } from "vitest";
import {
  branchOutcomeCounts,
  fidelityLabel,
  formatCost,
  type SimulationReport,
} from "@/lib/simulation";

type Cost = SimulationReport["cost"];
const cost = (over: Partial<Cost>): Cost => ({
  basis: "unavailable",
  agentSteps: 0,
  estimatedAgentSteps: 0,
  estPromptTokens: null,
  usd: null,
  note: "n/a",
  ...over,
});

describe("formatCost", () => {
  it("history basis with billable USD shows expected + range + confidence", () => {
    const s = formatCost(
      cost({
        basis: "history",
        confidence: "high",
        sampleRuns: 7,
        usd: 0.0025,
        minUsd: 0.0018,
        maxUsd: 0.004,
      }),
    );
    expect(s).toContain("$0.0025");
    expect(s).toContain("$0.0018");
    expect(s).toContain("high confidence");
    expect(s).toContain("7 run(s)");
  });

  it("history basis without billable USD falls back to tokens, never $0", () => {
    const s = formatCost(
      cost({
        basis: "history",
        confidence: "low",
        sampleRuns: 3,
        usd: null,
        estInputTokens: 900,
      }),
    );
    expect(s).toContain("900 input token(s)");
    expect(s).toContain("USD not billed");
    expect(s).not.toContain("$0");
  });

  it("sub-cent USD renders as <$0.01, not $0.00", () => {
    const s = formatCost(cost({ basis: "history", usd: 0.004 }));
    // 0.004 -> toFixed(4) -> $0.0040 (>0, shown precisely)
    expect(s).toContain("$0.0040");
    const tiny = formatCost(cost({ basis: "history", usd: 0.000001 }));
    expect(tiny).toContain("<$0.0001");
  });

  it("heuristic basis shows token estimate", () => {
    const s = formatCost(
      cost({ basis: "heuristic", estPromptTokens: 40, estimatedAgentSteps: 2 }),
    );
    expect(s).toContain("40 input token(s)");
    expect(s).toContain("heuristic");
  });

  it("unavailable basis returns the bridge note", () => {
    expect(formatCost(cost({ basis: "unavailable", note: "no agent steps" }))).toBe(
      "no agent steps",
    );
  });
});

describe("branchOutcomeCounts", () => {
  it("tallies taken/skipped/undetermined", () => {
    const c = branchOutcomeCounts([
      { stepId: "a", condition: "x", outcome: "taken", reason: "" },
      { stepId: "b", condition: "y", outcome: "skipped", reason: "" },
      { stepId: "c", condition: "z", outcome: "undetermined", reason: "" },
      { stepId: "d", condition: "w", outcome: "taken", reason: "" },
    ]);
    expect(c).toEqual({ taken: 2, skipped: 1, undetermined: 1 });
  });
});

describe("fidelityLabel", () => {
  const base = { fidelity: "static" } as SimulationReport;
  it("static", () => {
    expect(fidelityLabel(base)).toBe("static");
  });
  it("mocked with run count (singular/plural)", () => {
    expect(
      fidelityLabel({ ...base, fidelity: "mocked", sampleRuns: 1 }),
    ).toBe("mocked · 1 run");
    expect(
      fidelityLabel({ ...base, fidelity: "mocked", sampleRuns: 5 }),
    ).toBe("mocked · 5 runs");
  });
});
