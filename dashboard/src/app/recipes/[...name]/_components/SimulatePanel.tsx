"use client";

/**
 * What-If Preview panel — the dashboard home for `recipe simulate`. Calls the
 * bridge `GET /recipes/:name/simulate` (via the `/api/bridge/recipes/simulate`
 * proxy) and renders the static counterfactual: projected actions, side-effect
 * taxonomy, blast-radius risk, a tier-only approval projection, a cost
 * projection (history band or heuristic), the simulation fidelity
 * (static/mocked), and per-branch outcomes. Executes nothing.
 *
 * The bridge owns the simulation (single source of truth); this only renders
 * it — and surfaces the `gatedOnRecipeSteps=false` honesty caveat loudly so the
 * approval projection is never read as live gate behaviour.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  branchOutcomeCounts,
  fetchSimulation,
  fidelityLabel,
  formatCost,
  riskColor,
  riskGlyph,
  type SimulationReport,
} from "@/lib/simulation";

export function SimulatePanel({
  recipeName,
  autoRun = false,
}: {
  recipeName: string;
  /** Run immediately on mount — used by `?simulate=1` deep-links. */
  autoRun?: boolean;
}) {
  const [report, setReport] = useState<SimulationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await fetchSimulation(recipeName));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReport(null);
    } finally {
      setBusy(false);
    }
  }, [recipeName]);

  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRun && !autoRanRef.current) {
      autoRanRef.current = true;
      void run();
    }
  }, [autoRun, run]);

  const gating = report?.approvals.projected.filter(
    (a) => a.wouldRequireApproval,
  ).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
        <button
          type="button"
          className="btn ghost"
          onClick={() => void run()}
          disabled={busy}
          title="See what this recipe would do before you run it — executes nothing"
        >
          {busy ? "Simulating…" : "Run simulation"}
        </button>
        {report && (
          <span
            className="mono"
            style={{ fontSize: "var(--fs-xs)", color: riskColor(report.risk.tier) }}
          >
            {report.risk.tier.toUpperCase()} risk · {report.risk.score}/100 ·{" "}
            {report.topology}
          </span>
        )}
        {report && (
          <span
            className="mono muted"
            style={{ fontSize: "var(--fs-2xs)" }}
            title={
              report.fidelity === "mocked"
                ? "Driven by run history — branches + downstream values resolved against real prior outputs."
                : "Static projection — no run history used; data-dependent branches are undetermined."
            }
          >
            {fidelityLabel(report)}
          </span>
        )}
      </div>

      {error && (
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--err)" }}>
          Couldn&apos;t simulate: {error}
        </div>
      )}

      {report && (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}
        >
          {/* Risk components — transparent, never a black-box number */}
          <div className="mono muted" style={{ fontSize: "var(--fs-2xs)" }}>
            high:{report.risk.components.highSteps} · medium:
            {report.risk.components.mediumSteps} · writes:
            {report.risk.components.writeSteps} · connector-writes:
            {report.risk.components.connectorWriteSteps} · http:
            {report.risk.components.externalHttpSteps} · unresolved:
            {report.risk.components.unresolvedSteps}
          </div>

          {/* Actions */}
          <div>
            <div
              className="mono muted"
              style={{ fontSize: "var(--fs-2xs)", marginBottom: 2 }}
            >
              projected actions ({report.summary.totalSteps})
            </div>
            <ul
              style={{
                margin: 0,
                paddingLeft: 16,
                fontSize: "var(--fs-xs)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              {report.steps.map((s) => (
                <li key={s.id} style={{ wordBreak: "break-word" }}>
                  <span
                    style={{ color: riskColor(s.effectiveRisk), marginRight: 4 }}
                  >
                    {riskGlyph(s.effectiveRisk)}
                  </span>
                  <span className="mono">{s.id}</span> {s.tool ?? s.type}{" "}
                  <span className="muted">[{s.sideEffect}]</span>
                  {report.fidelity === "mocked" &&
                    s.mockedFrom === "synthesized" && (
                      <span
                        className="muted"
                        title="No run history for this step — value was synthesized, not from a real prior run."
                      >
                        {" "}
                        · synth
                      </span>
                    )}
                  {s.condition && (
                    <span className="muted"> · when: {s.condition}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {/* Side effects + connectors */}
          <div style={{ fontSize: "var(--fs-xs)" }}>
            <span className="mono muted" style={{ fontSize: "var(--fs-2xs)" }}>
              side effects:{" "}
            </span>
            {report.summary.writeSteps} write(s) · {report.summary.connectorSteps}{" "}
            connector call(s)
            {report.summary.connectorNamespaces.length > 0 &&
              ` (${report.summary.connectorNamespaces.join(", ")})`}{" "}
            · {report.summary.agentSteps} agent step(s)
          </div>

          {/* Approvals — loud honesty caveat */}
          <div style={{ fontSize: "var(--fs-xs)" }}>
            <span className="mono muted" style={{ fontSize: "var(--fs-2xs)" }}>
              approvals:{" "}
            </span>
            {gating} step(s) would gate
            {!report.gatedOnRecipeSteps && (
              <span style={{ color: "var(--warn)" }}>
                {" "}
                — but recipe steps are NOT gated today (projection only)
              </span>
            )}
          </div>

          {/* Cost — history band / heuristic tokens / unavailable note */}
          <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>
            <span className="mono" style={{ fontSize: "var(--fs-2xs)" }}>
              cost:{" "}
            </span>
            {formatCost(report.cost)}
          </div>

          {/* Branches — per-outcome (P2 resolves taken/skipped from history) */}
          {report.branches.length > 0 &&
            (() => {
              const c = branchOutcomeCounts(report.branches);
              return (
                <div style={{ fontSize: "var(--fs-xs)" }}>
                  <span
                    className="mono muted"
                    style={{ fontSize: "var(--fs-2xs)" }}
                  >
                    branches:{" "}
                  </span>
                  {c.taken > 0 && (
                    <span style={{ color: "var(--ok)" }}>{c.taken} taken</span>
                  )}
                  {c.taken > 0 && (c.skipped > 0 || c.undetermined > 0) && " · "}
                  {c.skipped > 0 && (
                    <span className="muted">{c.skipped} skipped</span>
                  )}
                  {c.skipped > 0 && c.undetermined > 0 && " · "}
                  {c.undetermined > 0 && (
                    <span style={{ color: "var(--warn)" }}>
                      {c.undetermined} undetermined
                    </span>
                  )}
                </div>
              );
            })()}

          {/* Lint */}
          {(report.lint.errors.length > 0 || report.lint.warnings.length > 0) && (
            <div style={{ fontSize: "var(--fs-xs)" }}>
              <span className="mono muted" style={{ fontSize: "var(--fs-2xs)" }}>
                lint:{" "}
              </span>
              <span style={{ color: "var(--err)" }}>
                {report.lint.errors.length} error(s)
              </span>
              ,{" "}
              <span style={{ color: "var(--warn)" }}>
                {report.lint.warnings.length} warning(s)
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
