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
  /** P2 mocked sandbox — whether this step's value came from run history. */
  mockedFrom?: "history" | "synthesized";
}

export interface SimulationReport {
  schemaVersion: number;
  kind: "what-if-preview";
  recipe: string;
  triggerType: string;
  generatedAt: string;
  /** "mocked" when driven by run history (P2); "static" otherwise. */
  fidelity: "static" | "mocked";
  /** Prior runs sampled for a mocked simulation (P2). */
  sampleRuns?: number;
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
    /** "history" = P1 median corpus; "heuristic" = chars/4; "unavailable". */
    basis: "history" | "heuristic" | "unavailable";
    /** Loud confidence signal (P3). */
    confidence?: "high" | "low" | "none";
    /** Prior runs that contributed a sample (history basis). */
    sampleRuns?: number;
    agentSteps: number;
    estimatedAgentSteps: number;
    estPromptTokens: number | null;
    estInputTokens?: number | null;
    estOutputTokens?: number | null;
    /** Expected USD (median-summed). null when no billable history; never $0. */
    usd: number | null;
    /** USD range across history (P3). */
    minUsd?: number | null;
    maxUsd?: number | null;
    /** Agent steps whose projection used real history vs chars/4. */
    historyAgentSteps?: number;
    note: string;
  };
  branches: Array<{
    stepId: string;
    condition: string;
    outcome: "taken" | "skipped" | "undetermined";
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

/** Short human label for the simulation fidelity (P2). */
export function fidelityLabel(report: SimulationReport): string {
  if (report.fidelity === "mocked") {
    const n = report.sampleRuns ?? 0;
    return `mocked · ${n} run${n === 1 ? "" : "s"}`;
  }
  return "static";
}

/** Format a USD amount with adaptive precision; never shows a bare "$0.00". */
function formatUsd(n: number): string {
  if (n <= 0) return "$0.00";
  const s = n < 1 ? n.toFixed(4) : n.toFixed(2);
  // A positive value that still rounds to zero (e.g. 1e-6) — don't lie with $0.
  return Number.parseFloat(s) === 0 ? "<$0.0001" : `$${s}`;
}

/**
 * Human cost string honoring the P3 contract: a history projection shows an
 * expected USD (+ range + confidence), heuristic shows tokens, unavailable
 * shows the bridge note. USD is NEVER a "$0" placeholder.
 */
export function formatCost(cost: SimulationReport["cost"]): string {
  if (cost.basis === "history") {
    const conf = cost.confidence ? ` · ${cost.confidence} confidence` : "";
    const runs = cost.sampleRuns ? ` · ${cost.sampleRuns} run(s)` : "";
    if (typeof cost.usd === "number") {
      const range =
        typeof cost.minUsd === "number" && typeof cost.maxUsd === "number"
          ? ` (${formatUsd(cost.minUsd)}–${formatUsd(cost.maxUsd)})`
          : "";
      return `~${formatUsd(cost.usd)}${range}${conf}${runs}`;
    }
    // History tokens but no billable USD (subscription/subprocess driver).
    const tok = cost.estInputTokens ?? cost.estPromptTokens;
    return `~${tok ?? "?"} input token(s)${conf}${runs} · USD not billed (subscription driver)`;
  }
  if (cost.basis === "heuristic") {
    return `~${cost.estPromptTokens} input token(s) over ${cost.estimatedAgentSteps} agent step(s) (heuristic; USD not projected)`;
  }
  return cost.note;
}

/** Tally branch outcomes (P2) for a compact summary line. */
export function branchOutcomeCounts(
  branches: SimulationReport["branches"],
): { taken: number; skipped: number; undetermined: number } {
  const out = { taken: 0, skipped: 0, undetermined: 0 };
  for (const b of branches) out[b.outcome] += 1;
  return out;
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
