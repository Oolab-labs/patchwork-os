"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { apiPath } from "@/lib/api";
import { BackLink } from "@/components/patchwork";
import { Dialog } from "@/components/Dialog";

interface PlanStep {
  id: string;
  type: "tool" | "agent" | "recipe";
  tool?: string;
  into?: string;
  optional?: boolean;
  risk?: "low" | "medium" | "high";
  isWrite?: boolean;
  resolved?: boolean;
}

interface DryRunPlan {
  recipe: string;
  triggerType: string;
  steps: PlanStep[];
  connectorNamespaces?: string[];
  hasWriteSteps?: boolean;
  lint: { errors: string[]; warnings: string[] };
}

const RISK_PILL: Record<string, string> = {
  low: "ok",
  medium: "warn",
  high: "err",
};

function StepRow({ step, highlight, isRemoved }: { step: PlanStep; highlight?: boolean; isRemoved?: boolean }) {
  return (
    <tr
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        background: isRemoved
          ? "color-mix(in srgb, var(--err) 6%, transparent)"
          : highlight
            ? "color-mix(in srgb, var(--ok) 8%, transparent)"
            : undefined,
        transition: "background 120ms",
        opacity: isRemoved ? 0.6 : 1,
      }}
    >
      <td style={{ padding: "8px 0", fontSize: "var(--fs-s)", fontFamily: "var(--font-mono)" }}>
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}>
          {highlight && !isRemoved && (
            <span style={{
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--ok)",
              flexShrink: 0,
            }} aria-label="new step" />
          )}
          {isRemoved && (
            <span style={{
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--err)",
              flexShrink: 0,
            }} aria-label="removed step" />
          )}
          {step.tool ?? step.type}
        </span>
      </td>
      <td style={{ padding: "8px 6px", textAlign: "center" }}>
        {step.risk && (
          <span className={`pill ${RISK_PILL[step.risk]}`} style={{ fontSize: "var(--fs-2xs)" }}>
            {step.risk}
          </span>
        )}
      </td>
      <td style={{ padding: "8px 6px", textAlign: "center", fontSize: "var(--fs-xs)", color: step.isWrite ? "var(--warn)" : "var(--ink-2)", fontWeight: step.isWrite ? 600 : 400 }}>
        {step.isWrite ? "write" : "read"}
      </td>
      <td style={{ padding: "8px 0", textAlign: "center" }}>
        {step.resolved === false && (
          <span className="pill err" style={{ fontSize: "var(--fs-2xs)" }}>unresolved</span>
        )}
      </td>
    </tr>
  );
}

function PlanColumn({
  name,
  plan,
  error,
  loading,
  otherStepIds,
  onPromote,
  promoting,
  targetName,
}: {
  name: string;
  plan: DryRunPlan | null;
  error: string | null;
  loading: boolean;
  otherStepIds: Set<string>;
  onPromote: () => void;
  promoting: boolean;
  targetName: string;
}) {
  const stepIds = new Set(plan?.steps.map((s) => s.id) ?? []);
  const addedSteps = plan?.steps.filter((s) => !otherStepIds.has(s.id)) ?? [];
  const removedCount = [...otherStepIds].filter((id) => !stepIds.has(id)).length;

  return (
    <div
      className="compare-panel"
      style={{
        flex: 1,
        minWidth: 0,
        border: "1px solid var(--border-default)",
        borderRadius: "var(--r-3)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        transition: "box-shadow 150ms",
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          background: "var(--bg-2)",
          borderBottom: "1px solid var(--border-default)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <code style={{ flex: 1, fontSize: "var(--fs-m)" }}>{name}</code>
        {plan && (
          <>
            <span className="pill muted" style={{ fontSize: "var(--fs-2xs)" }}>
              {plan.steps.length} steps
            </span>
            {addedSteps.length > 0 && (
              <span className="pill ok" style={{ fontSize: "var(--fs-2xs)" }}>
                +{addedSteps.length} new
              </span>
            )}
            {removedCount > 0 && (
              <span className="pill err" style={{ fontSize: "var(--fs-2xs)" }}>
                -{removedCount} removed
              </span>
            )}
          </>
        )}
        <button
          type="button"
          className="btn sm"
          disabled={promoting || !plan || loading}
          onClick={onPromote}
          title={`Promote ${name} → ${targetName}`}
        >
          {promoting ? "Promoting…" : `Promote → ${targetName}`}
        </button>
      </div>

      <div style={{ padding: "12px 16px", flex: 1 }}>
        {loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[1, 2, 3].map((n) => (
              <div key={n} style={{
                height: 32,
                borderRadius: 6,
                background: "var(--line-2)",
                opacity: 0.5 + n * 0.1,
                animation: "compareSkelPulse 1.4s ease-in-out infinite",
                animationDelay: `${n * 120}ms`,
              }} />
            ))}
          </div>
        )}
        {error && <div className="alert-err" style={{ fontSize: "var(--fs-s)" }}>{error}</div>}

        {plan && (
          <>
            {plan.lint.errors.length > 0 && (
              <div className="alert-err" style={{ marginBottom: 8, fontSize: "var(--fs-s)" }}>
                {plan.lint.errors.join(" · ")}
              </div>
            )}
            {plan.lint.warnings.length > 0 && (
              <div
                style={{
                  background: "color-mix(in srgb, var(--warn) 10%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--warn) 30%, transparent)",
                  borderRadius: "var(--r-2)",
                  padding: "6px 10px",
                  fontSize: "var(--fs-xs)",
                  color: "var(--ink-1)",
                  marginBottom: 8,
                }}
              >
                {plan.lint.warnings.join(" · ")}
              </div>
            )}
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                  <th style={{ textAlign: "left", fontSize: "var(--fs-2xs)", color: "var(--ink-2)", fontWeight: 500, padding: "4px 0" }}>Step</th>
                  <th style={{ textAlign: "center", fontSize: "var(--fs-2xs)", color: "var(--ink-2)", fontWeight: 500, padding: "4px 6px" }}>Risk</th>
                  <th style={{ textAlign: "center", fontSize: "var(--fs-2xs)", color: "var(--ink-2)", fontWeight: 500, padding: "4px 6px" }}>Mode</th>
                  <th style={{ textAlign: "center", fontSize: "var(--fs-2xs)", color: "var(--ink-2)", fontWeight: 500, padding: "4px 0" }} />
                </tr>
              </thead>
              <tbody>
                {plan.steps.map((step) => (
                  <StepRow
                    key={step.id}
                    step={step}
                    highlight={!otherStepIds.has(step.id)}
                  />
                ))}
                {[...otherStepIds].filter((id) => !stepIds.has(id)).map((id) => (
                  <StepRow
                    key={`removed-${id}`}
                    step={{ id, type: "agent" }}
                    isRemoved
                  />
                ))}
              </tbody>
            </table>
            {plan.connectorNamespaces && plan.connectorNamespaces.length > 0 && (
              <p style={{ fontSize: "var(--fs-xs)", color: "var(--ink-2)", marginTop: 8 }}>
                Connectors: {plan.connectorNamespaces.join(", ")}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CompareInner() {
  const params = useSearchParams();
  // ?name= seeds slot a (emitted by "Compare versions" on the recipe hub).
  // ?a= / ?b= are the canonical keys used once both slots are filled.
  const nameA = params.get("a") ?? params.get("name") ?? "";
  const nameB = params.get("b") ?? "";

  const [planA, setPlanA] = useState<DryRunPlan | null>(null);
  const [planB, setPlanB] = useState<DryRunPlan | null>(null);
  const [errA, setErrA] = useState<string | null>(null);
  const [errB, setErrB] = useState<string | null>(null);
  const [loadingA, setLoadingA] = useState(true);
  const [loadingB, setLoadingB] = useState(true);
  const [promoteResult, setPromoteResult] = useState<string | null>(null);
  const [promoteResultKind, setPromoteResultKind] = useState<"ok" | "err" | null>(null);
  const [promotingA, setPromotingA] = useState(false);
  const [promotingB, setPromotingB] = useState(false);
  const [confirm, setConfirm] = useState<{
    variantName: string;
    setPromoting: (v: boolean) => void;
  } | null>(null);

  // The bridge wraps the response: { plan: DryRunPlan, error?: string }.
  // The /recipes/[name]/plan page already extracts data.plan; this one was
  // stuffing the whole envelope into setPlanA, then crashing on
  // `plan.steps.map(...)` — TypeError: Cannot read properties of undefined
  // (reading 'map'). Match the /plan page's load() shape: pull data.plan
  // out and treat missing plan as an error.
  useEffect(() => {
    if (!nameA) return;
    setLoadingA(true);
    fetch(apiPath(`/api/bridge/recipes/${encodeURIComponent(nameA)}/plan`))
      .then((r) => r.json())
      .then((d: { plan?: DryRunPlan; error?: string }) => {
        if (d.error || !d.plan) setErrA(d.error ?? "Failed to load plan.");
        else setPlanA(d.plan);
      })
      .catch((e: unknown) => setErrA(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingA(false));
  }, [nameA]);

  useEffect(() => {
    if (!nameB) return;
    setLoadingB(true);
    fetch(apiPath(`/api/bridge/recipes/${encodeURIComponent(nameB)}/plan`))
      .then((r) => r.json())
      .then((d: { plan?: DryRunPlan; error?: string }) => {
        if (d.error || !d.plan) setErrB(d.error ?? "Failed to load plan.");
        else setPlanB(d.plan);
      })
      .catch((e: unknown) => setErrB(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingB(false));
  }, [nameB]);

  // Determine which is the "base" name (no -vN suffix) for the promote target.
  const baseName = nameA.replace(/-v\d+$/, "");

  async function promote(
    variantName: string,
    setPromoting: (v: boolean) => void,
    force = false,
  ) {
    setPromoting(true);
    setPromoteResult(null);
    setPromoteResultKind(null);
    try {
      const res = await fetch(
        apiPath(`/api/bridge/recipes/${encodeURIComponent(variantName)}/promote`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetName: baseName, force }),
        },
      );
      const body = (await res.json()) as {
        ok?: boolean;
        error?: string;
        targetExists?: boolean;
      };
      if (body.ok) {
        setPromoteResult(`${variantName} promoted to ${baseName}`);
        setPromoteResultKind("ok");
      } else if (body.targetExists && !force) {
        setPromoting(false);
        setConfirm({ variantName, setPromoting });
        return;
      } else {
        setPromoteResult(body.error ?? "promote failed");
        setPromoteResultKind("err");
      }
    } catch (e) {
      setPromoteResult(e instanceof Error ? e.message : String(e));
      setPromoteResultKind("err");
    } finally {
      setPromoting(false);
    }
  }

  if (!nameA || !nameB) {
    return (
      <div className="empty-state">
        <h3>{nameA ? "Select a second recipe to compare" : "Missing recipe names"}</h3>
        <p>
          {nameA
            ? <>Comparing <code>{nameA}</code> — add <code>?b=recipe-name-v2</code> to pick the second variant.</>
            : <>Use <code>/recipes/compare?a=recipe-name&amp;b=recipe-name-v2</code>. The Fork button on the Recipes page links here automatically.</>}
        </p>
        <p style={{ marginTop: "var(--s-3)" }}>
          <Link href="/recipes" className="btn sm primary" style={{ textDecoration: "none" }}>
            ← Back to recipes
          </Link>
        </p>
      </div>
    );
  }

  const stepIdsA = new Set(planA?.steps.map((s) => s.id) ?? []);
  const stepIdsB = new Set(planB?.steps.map((s) => s.id) ?? []);

  return (
    <section>
      <div className="page-head" style={{ animation: "compareIn 180ms ease both" }}>
        <div>
          <BackLink href="/recipes" label="Recipes" />
          <h1 style={{ marginTop: 4 }}>Compare variants</h1>
          <div className="page-head-sub">
            Dry-run plan diff — green rows are steps unique to this variant, red rows are removed. Promote to replace the base recipe.
          </div>
        </div>
      </div>

      {promoteResult && promoteResultKind && (
        <div
          role={promoteResultKind === "err" ? "alert" : "status"}
          style={{
            marginBottom: "var(--s-4)",
            padding: "10px 14px",
            borderRadius: "var(--r-2)",
            background:
              promoteResultKind === "ok" ? "var(--ok-soft)" : "var(--err-soft)",
            border: `1px solid ${promoteResultKind === "ok" ? "var(--ok)" : "var(--err)"}`,
            fontSize: "var(--fs-m)",
            animation: "promoteResultIn 200ms ease both",
          }}
        >
          <span aria-hidden="true">
            {promoteResultKind === "ok" ? "✓ " : ""}
          </span>
          {promoteResult}
          {promoteResultKind === "ok" && (
            <>
              {" "}
              <Link href="/recipes" style={{ color: "var(--ok)", fontSize: "var(--fs-s)" }}>
                Back to recipes →
              </Link>
            </>
          )}
        </div>
      )}

      <div className="compare-legend">
        <div className="compare-legend-item">
          <div className="compare-legend-dot" style={{ background: "var(--ok)" }} />
          <span>new step (unique to this variant)</span>
        </div>
        <div className="compare-legend-item">
          <div className="compare-legend-dot" style={{ background: "var(--err)" }} />
          <span>removed step (in other variant only)</span>
        </div>
      </div>

      <div className="compare-columns">
        <PlanColumn
          name={nameA}
          plan={planA}
          error={errA}
          loading={loadingA}
          otherStepIds={stepIdsB}
          onPromote={() => void promote(nameA, setPromotingA)}
          promoting={promotingA}
          targetName={baseName}
        />
        <PlanColumn
          name={nameB}
          plan={planB}
          error={errB}
          loading={loadingB}
          otherStepIds={stepIdsA}
          onPromote={() => void promote(nameB, setPromotingB)}
          promoting={promotingB}
          targetName={baseName}
        />
      </div>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        ariaLabelledBy="promote-confirm-heading"
        maxWidth={460}
      >
        {confirm && (
          <>
            <h3 id="promote-confirm-heading" style={{ marginTop: 0, marginBottom: 8 }}>
              Overwrite <code>{baseName}</code>?
            </h3>
            <p style={{ fontSize: "var(--fs-m)", color: "var(--ink-2)", margin: "0 0 16px", lineHeight: 1.5 }}>
              <code>{baseName}</code> already exists. Promoting{" "}
              <code>{confirm.variantName}</code> will replace it. The existing
              recipe file will be overwritten.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => setConfirm(null)}
                style={{
                  padding: "6px 12px",
                  borderRadius: "var(--r-1)",
                  border: "1px solid var(--line-2)",
                  background: "transparent",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  void promote(c.variantName, c.setPromoting, true);
                }}
                style={{
                  padding: "6px 12px",
                  borderRadius: "var(--r-1)",
                  border: "1px solid var(--err)",
                  background: "var(--err)",
                  color: "var(--surface)",
                  cursor: "pointer",
                }}
              >
                Overwrite
              </button>
            </div>
          </>
        )}
      </Dialog>
    </section>
  );
}

export default function ComparePage() {
  return (
    <Suspense fallback={<p style={{ color: "var(--ink-2)" }}>Loading…</p>}>
      <CompareInner />
    </Suspense>
  );
}
