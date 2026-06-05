/**
 * What-If Preview — client types + helpers for the recipe simulation report
 * (bridge `GET /recipes/:name/simulate`, proxied via
 * `/api/bridge/recipes/simulate?recipe=`). A local mirror of the bridge's
 * `RecipeSimulationReport` (src/recipes/simulation/types.ts) — only the fields
 * the dashboard renders. Keep in sync with `schemaVersion`.
 */

import { apiPath } from "@/lib/api";

export type RiskTier = "low" | "medium" | "high";

export type SideEffectKind =
  | "local-read"
  | "local-write"
  | "connector-read"
  | "connector-write"
  | "external-http"
  | "agent-llm"
  | "nested-recipe"
  | "unknown";

export interface SimulationStep {
  id: string;
  type: "tool" | "agent" | "recipe";
  tool?: string;
  namespace?: string;
  resolved: boolean;
  optional?: boolean;
  condition?: string;
  baseRisk: RiskTier;
  effectiveRisk: RiskTier;
  sideEffect: SideEffectKind;
  isWrite: boolean;
  isConnector: boolean;
}

export interface SimulationReport {
  schemaVersion: number;
  kind: "what-if-preview";
  recipe: string;
  triggerType: string;
  generatedAt: string;
  fidelity: "static";
  topology: "chained" | "flat";
  gatedOnRecipeSteps: boolean;
  steps: SimulationStep[];
  summary: {
    totalSteps: number;
    writeSteps: number;
    connectorSteps: number;
    agentSteps: number;
    unresolvedSteps: number;
    sideEffectCounts: Record<string, number>;
    connectorNamespaces: string[];
  };
  risk: {
    score: number;
    tier: RiskTier;
    components: {
      highSteps: number;
      mediumSteps: number;
      writeSteps: number;
      connectorWriteSteps: number;
      externalHttpSteps: number;
      unresolvedSteps: number;
    };
    highestStepRisk: RiskTier;
  };
  approvals: {
    gatedOnRecipeSteps: boolean;
    projected: Array<{
      stepId: string;
      tool?: string;
      tier: RiskTier;
      wouldRequireApproval: boolean;
      reason: string;
    }>;
    note: string;
  };
  cost: {
    basis: "heuristic" | "unavailable";
    agentSteps: number;
    estimatedAgentSteps: number;
    estPromptTokens: number | null;
    usd: null;
    note: string;
  };
  branches: Array<{
    stepId: string;
    condition: string;
    outcome: "undetermined";
    reason: string;
  }>;
  lint: { errors: string[]; warnings: string[] };
  notes: string[];
}

/** CSS var for a risk tier — matches the dashboard ok/warn/err palette. */
export function riskColor(tier: RiskTier): string {
  return tier === "high"
    ? "var(--err)"
    : tier === "medium"
      ? "var(--warn)"
      : "var(--ok)";
}

/** Per-step effective-risk glyph used in the actions list. */
export function riskGlyph(tier: RiskTier): string {
  return tier === "high" ? "●" : tier === "medium" ? "◐" : "○";
}

/**
 * Fetch a recipe's simulation report. Returns the parsed report or throws with
 * a human message. Shared by the SimulatePanel and the Run-Now risk gate.
 */
export async function fetchSimulation(
  recipeName: string,
): Promise<SimulationReport> {
  // no-store: the simulation reflects live bridge/recipe state; a cached 404
  // (e.g. before the bridge had the route) must never stick in the browser.
  const res = await fetch(
    apiPath(
      `/api/bridge/recipes/simulate?recipe=${encodeURIComponent(recipeName)}`,
    ),
    { cache: "no-store" },
  );
  const data = (await res.json().catch(() => ({}))) as
    | { report: SimulationReport }
    | { error?: string; message?: string };
  if (!res.ok || !("report" in data) || !data.report) {
    const msg =
      ("message" in data && data.message) ||
      ("error" in data && data.error) ||
      `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  return data.report;
}
