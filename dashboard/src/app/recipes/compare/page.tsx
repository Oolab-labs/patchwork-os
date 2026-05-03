"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { apiPath } from "@/lib/api";

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

function StepRow({ step, highlight }: { step: PlanStep; highlight?: boolean }) {
  return (
    <tr
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        background: highlight ? "color-mix(in srgb, var(--warn) 8%, transparent)" : undefined,
      }}
    >
      <td style={{ padding: "8px 0", fontSize: 12, fontFamily: "monospace" }}>
        {step.tool ?? step.type}
      </td>
      <td style={{ padding: "8px 6px", textAlign: "center" }}>
        {step.risk && (
          <span className={`pill ${RISK_PILL[step.risk]}`} style={{ fontSize: 10 }}>
            {step.risk}
          </span>
        )}
      </td>
      <td style={{ padding: "8px 6px", textAlign: "center", fontSize: 11, color: "var(--fg-2)" }}>
        {step.isWrite ? "write" : "read"}
      </td>
      <td style={{ padding: "8px 0", textAlign: "center" }}>
        {step.resolved === false && (
          <span className="pill err" style={{ fontSize: 10 }}>unresolved</span>
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
      style={{
        flex: 1,
        minWidth: 0,
        border: "1px solid var(--border-default)",
        borderRadius: "var(--r-3)",
        overflow: "hidden",
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
        <code style={{ flex: 1, fontSize: 13 }}>{name}</code>
        {plan && (
          <>
            <span className="pill muted" style={{ fontSize: 10 }}>
              {plan.steps.length} steps
            </span>
            {addedSteps.length > 0 && (
              <span className="pill ok" style={{ fontSize: 10 }}>
                +{addedSteps.length} new
              </span>
            )}
            {removedCount > 0 && (
              <span className="pill err" style={{ fontSize: 10 }}>
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

      <div style={{ padding: "12px 16px" }}>
        {loading && <p style={{ color: "var(--fg-2)", fontSize: 13 }}>Loading plan…</p>}
        {error && <div className="alert-err" style={{ fontSize: 12 }}>{error}</div>}

        {plan && (
          <>
            {plan.lint.errors.length > 0 && (
              <div className="alert-err" style={{ marginBottom: 8, fontSize: 12 }}>
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
                  fontSize: 11,
                  color: "var(--fg-1)",
                  marginBottom: 8,
                }}
              >
                {plan.lint.warnings.join(" · ")}
              </div>
            )}
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                  <th style={{ textAlign: "left", fontSize: 10, color: "var(--fg-2)", fontWeight: 500, padding: "4px 0" }}>Step</th>
                  <th style={{ textAlign: "center", fontSize: 10, color: "var(--fg-2)", fontWeight: 500, padding: "4px 6px" }}>Risk</th>
                  <th style={{ textAlign: "center", fontSize: 10, color: "var(--fg-2)", fontWeight: 500, padding: "4px 6px" }}>Mode</th>
                  <th style={{ textAlign: "center", fontSize: 10, color: "var(--fg-2)", fontWeight: 500, padding: "4px 0" }} />
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
              </tbody>
            </table>
            {plan.connectorNamespaces && plan.connectorNamespaces.length > 0 && (
              <p style={{ fontSize: 11, color: "var(--fg-2)", marginTop: 8 }}>
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
  const nameA = params.get("a") ?? "";
  const nameB = params.get("b") ?? "";

  const [planA, setPlanA] = useState<DryRunPlan | null>(null);
  const [planB, setPlanB] = useState<DryRunPlan | null>(null);
  const [errA, setErrA] = useState<string | null>(null);
  const [errB, setErrB] = useState<string | null>(null);
  const [loadingA, setLoadingA] = useState(true);
  const [loadingB, setLoadingB] = useState(true);
  const [promoteResult, setPromoteResult] = useState<string | null>(null);
  const [promotingA, setPromotingA] = useState(false);
  const [promotingB, setPromotingB] = useState(false);

  useEffect(() => {
    if (!nameA) return;
    setLoadingA(true);
    fetch(apiPath(`/api/bridge/recipes/${encodeURIComponent(nameA)}/plan`))
      .then((r) => r.json())
      .then((d: DryRunPlan & { error?: string }) => {
        if (d.error) setErrA(d.error);
        else setPlanA(d);
      })
      .catch((e: unknown) => setErrA(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingA(false));
  }, [nameA]);

  useEffect(() => {
    if (!nameB) return;
    setLoadingB(true);
    fetch(apiPath(`/api/bridge/recipes/${encodeURIComponent(nameB)}/plan`))
      .then((r) => r.json())
      .then((d: DryRunPlan & { error?: string }) => {
        if (d.error) setErrB(d.error);
        else setPlanB(d);
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
        setPromoteResult(`✓ ${variantName} promoted to ${baseName}`);
      } else if (body.targetExists) {
        // Ask the user to confirm before overwriting the canonical recipe.
        const confirmed = window.confirm(
          `"${baseName}" already exists. Overwrite it with "${variantName}"?\n\nThe existing recipe will be replaced.`,
        );
        if (confirmed) {
          setPromoting(false);
          await promote(variantName, setPromoting, true);
          return;
        }
        setPromoteResult(null);
      } else {
        setPromoteResult(`Error: ${body.error ?? "promote failed"}`);
      }
    } catch (e) {
      setPromoteResult(e instanceof Error ? e.message : String(e));
    } finally {
      setPromoting(false);
    }
  }

  if (!nameA || !nameB) {
    return (
      <div className="empty-state">
        <h3>Missing recipe names</h3>
        <p>
          Use <code>/recipes/compare?a=recipe-name&b=recipe-name-v2</code>. The
          Fork button on the Recipes page links here automatically.
        </p>
      </div>
    );
  }

  const stepIdsA = new Set(planA?.steps.map((s) => s.id) ?? []);
  const stepIdsB = new Set(planB?.steps.map((s) => s.id) ?? []);

  return (
    <section>
      <div className="page-head">
        <div>
          <Link href="/recipes" style={{ fontSize: 12, color: "var(--fg-2)", textDecoration: "none" }}>
            ← Recipes
          </Link>
          <h1 style={{ marginTop: 4 }}>Compare variants</h1>
          <div className="page-head-sub">
            Dry-run plan diff — highlighted rows are steps unique to each
            variant. Promote to replace the base recipe with this variant.
          </div>
        </div>
      </div>

      {promoteResult && (
        <div
          style={{
            marginBottom: "var(--s-4)",
            padding: "10px 14px",
            borderRadius: "var(--r-2)",
            background: promoteResult.startsWith("✓")
              ? "color-mix(in srgb, var(--ok) 12%, transparent)"
              : "color-mix(in srgb, var(--err) 12%, transparent)",
            border: `1px solid ${promoteResult.startsWith("✓") ? "color-mix(in srgb, var(--ok) 30%, transparent)" : "color-mix(in srgb, var(--err) 30%, transparent)"}`,
            fontSize: 13,
          }}
        >
          {promoteResult}
          {promoteResult.startsWith("✓") && (
            <>
              {" "}
              <Link href="/recipes" style={{ color: "var(--ok)", fontSize: 12 }}>
                Back to recipes →
              </Link>
            </>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
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
    </section>
  );
}

export default function ComparePage() {
  return (
    <Suspense fallback={<p style={{ color: "var(--fg-2)" }}>Loading…</p>}>
      <CompareInner />
    </Suspense>
  );
}
