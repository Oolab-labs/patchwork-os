/**
 * Tests for SimulatePanel — the recipe-detail "What-If Preview" panel that
 * calls GET /api/bridge/recipes/simulate and renders the static simulation.
 * Mocks fetch; asserts risk, projected actions, the computed approval verdict
 * (gated / not gated / unknown), and the error path.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimulationReport } from "@/lib/simulation";
import { SimulatePanel } from "../_components/SimulatePanel";

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status,
      json: async () => body,
    })) as unknown as typeof fetch,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const REPORT: SimulationReport = {
  schemaVersion: 3,
  kind: "what-if-preview",
  recipe: "demo",
  triggerType: "chained",
  generatedAt: "2026-06-05T00:00:00.000Z",
  fidelity: "static",
  topology: "chained",
  gatedOnRecipeSteps: true,
  steps: [
    {
      id: "open_pr",
      type: "tool",
      tool: "github.create_pr",
      namespace: "github",
      resolved: true,
      baseRisk: "high",
      effectiveRisk: "high",
      sideEffect: "connector-write",
      isWrite: true,
      isConnector: true,
      condition: "{{ fetch.count }}",
    },
  ],
  summary: {
    totalSteps: 1,
    writeSteps: 1,
    connectorSteps: 1,
    agentSteps: 0,
    unresolvedSteps: 0,
    sideEffectCounts: { "connector-write": 1 },
    connectorNamespaces: ["github"],
  },
  risk: {
    score: 48,
    tier: "high",
    components: {
      highSteps: 1,
      mediumSteps: 0,
      writeSteps: 1,
      connectorWriteSteps: 1,
      externalHttpSteps: 0,
      unresolvedSteps: 0,
    },
    highestStepRisk: "high",
  },
  approvals: {
    gatedOnRecipeSteps: true,
    basis: "effective-policy",
    profile: "governed",
    trigger: "manual",
    projected: [
      {
        stepId: "open_pr",
        tool: "github.create_pr",
        tier: "high",
        wouldRequireApproval: true,
        verdict: "HUMAN_APPROVAL_REQUIRED",
        consultsApproval: true,
        reason: "tool tier high",
      },
    ],
    note: "1 step(s) would wait for a human.",
  },
  cost: {
    basis: "unavailable",
    agentSteps: 0,
    estimatedAgentSteps: 0,
    estPromptTokens: null,
    usd: null,
    note: "No AI/agent steps — this recipe incurs no model cost.",
  },
  branches: [
    {
      stepId: "open_pr",
      condition: "{{ fetch.count }}",
      outcome: "undetermined",
      reason: "depends on prior step output",
    },
  ],
  lint: { errors: [], warnings: [] },
  notes: ["Static fidelity: no step is executed."],
};

describe("SimulatePanel", () => {
  it("renders risk, actions and the computed approval verdict", async () => {
    mockFetchOnce({ report: REPORT });
    render(<SimulatePanel recipeName="demo" />);
    fireEvent.click(screen.getByRole("button", { name: /run simulation/i }));

    await waitFor(() => {
      expect(screen.getByText(/HIGH risk · 48\/100 · chained/)).toBeTruthy();
    });
    // projected action with its tool + side-effect class
    expect(screen.getByText("github.create_pr")).toBeTruthy();
    expect(screen.getByText(/\[connector-write\]/)).toBeTruthy();
    // the runtime's verdict, with the profile/trigger it was computed for
    expect(screen.getByText(/1 step\(s\) would wait for approval/)).toBeTruthy();
    expect(screen.getByText(/governed profile/)).toBeTruthy();
    expect(screen.queryByText(/NOT gated/)).toBeNull();
    // static fidelity badge
    expect(screen.getByText(/^static$/)).toBeTruthy();
    // undetermined branch surfaced (per-outcome summary)
    expect(screen.getByText(/1 undetermined/)).toBeTruthy();
  });

  it("says no step would wait when the policy does not gate this recipe", async () => {
    mockFetchOnce({
      report: {
        ...REPORT,
        gatedOnRecipeSteps: false,
        approvals: {
          ...REPORT.approvals,
          gatedOnRecipeSteps: false,
          profile: "compat",
          projected: [
            {
              ...REPORT.approvals.projected[0]!,
              wouldRequireApproval: false,
              verdict: "ALLOW",
              consultsApproval: false,
            },
          ],
        },
      },
    });
    render(<SimulatePanel recipeName="demo" autoRun />);
    await waitFor(() => {
      expect(screen.getByText(/no step would wait for approval/)).toBeTruthy();
    });
  });

  it("says unknown, not 'not gated', when the policy could not be evaluated", async () => {
    mockFetchOnce({
      report: {
        ...REPORT,
        gatedOnRecipeSteps: null,
        approvals: {
          gatedOnRecipeSteps: null,
          basis: "unavailable",
          projected: [],
          note: "unavailable",
        },
      },
    });
    render(<SimulatePanel recipeName="demo" autoRun />);
    await waitFor(() => {
      expect(screen.getByText(/unknown — the effective policy/)).toBeTruthy();
    });
    expect(screen.queryByText(/no step would wait/)).toBeNull();
  });

  it("renders mocked fidelity, history cost band, per-branch outcome and synth steps", async () => {
    const mocked: SimulationReport = {
      ...REPORT,
      fidelity: "mocked",
      sampleRuns: 7,
      steps: [
        { ...REPORT.steps[0]!, mockedFrom: "history" },
        {
          id: "notify",
          type: "tool",
          tool: "slack.postMessage",
          namespace: "slack",
          resolved: true,
          baseRisk: "medium",
          effectiveRisk: "medium",
          sideEffect: "connector-write",
          isWrite: true,
          isConnector: true,
          mockedFrom: "synthesized",
        },
      ],
      cost: {
        basis: "history",
        confidence: "high",
        sampleRuns: 7,
        agentSteps: 1,
        estimatedAgentSteps: 1,
        estPromptTokens: 1200,
        estInputTokens: 1200,
        estOutputTokens: 300,
        usd: 0.0025,
        minUsd: 0.0018,
        maxUsd: 0.004,
        historyAgentSteps: 1,
        note: "history",
      },
      branches: [
        {
          stepId: "open_pr",
          condition: "{{ fetch.count }}",
          outcome: "taken",
          reason: "resolved from history",
        },
        {
          stepId: "notify",
          condition: "{{ x }}",
          outcome: "skipped",
          reason: "resolved from history",
        },
      ],
    };
    mockFetchOnce({ report: mocked });
    render(<SimulatePanel recipeName="demo" autoRun />);

    await waitFor(() => {
      expect(screen.getByText(/mocked · 7 runs/)).toBeTruthy();
    });
    // history cost band with USD range + confidence
    expect(screen.getByText(/\$0\.0025/)).toBeTruthy();
    expect(screen.getByText(/high confidence/)).toBeTruthy();
    // per-branch outcomes
    expect(screen.getByText(/1 taken/)).toBeTruthy();
    expect(screen.getByText(/1 skipped/)).toBeTruthy();
    // synthesized step flagged
    expect(screen.getByText(/synth/)).toBeTruthy();
  });

  it("auto-runs on mount when autoRun is set", async () => {
    mockFetchOnce({ report: REPORT });
    render(<SimulatePanel recipeName="demo" autoRun />);
    await waitFor(() => {
      expect(screen.getByText(/HIGH risk/)).toBeTruthy();
    });
  });

  it("shows an error when the simulation fails", async () => {
    mockFetchOnce({ error: "boom" }, false, 500);
    render(<SimulatePanel recipeName="demo" />);
    fireEvent.click(screen.getByRole("button", { name: /run simulation/i }));
    await waitFor(() => {
      expect(screen.getByText(/Couldn't simulate: boom/)).toBeTruthy();
    });
  });
});
