/**
 * Tests for SimulatePanel — the recipe-detail "What-If Preview" panel that
 * calls GET /api/bridge/recipes/simulate and renders the static simulation.
 * Mocks fetch; asserts risk, projected actions, the gatedOnRecipeSteps honesty
 * caveat, and the error path.
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
  schemaVersion: 1,
  kind: "what-if-preview",
  recipe: "demo",
  triggerType: "chained",
  generatedAt: "2026-06-05T00:00:00.000Z",
  fidelity: "static",
  topology: "chained",
  gatedOnRecipeSteps: false,
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
    gatedOnRecipeSteps: false,
    projected: [
      {
        stepId: "open_pr",
        tool: "github.create_pr",
        tier: "high",
        wouldRequireApproval: true,
        reason: "high-risk connector-write",
      },
    ],
    note: "not gated today",
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
  it("renders risk, actions and the not-gated honesty caveat", async () => {
    mockFetchOnce({ report: REPORT });
    render(<SimulatePanel recipeName="demo" />);
    fireEvent.click(screen.getByRole("button", { name: /run simulation/i }));

    await waitFor(() => {
      expect(screen.getByText(/HIGH risk · 48\/100 · chained/)).toBeTruthy();
    });
    // projected action with its tool + side-effect class
    expect(screen.getByText("github.create_pr")).toBeTruthy();
    expect(screen.getByText(/\[connector-write\]/)).toBeTruthy();
    // the honesty caveat — approval projection is NOT a live gate
    expect(screen.getByText(/NOT gated today/)).toBeTruthy();
    // undetermined branch surfaced
    expect(screen.getByText(/conditional branch\(es\) undetermined/)).toBeTruthy();
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
