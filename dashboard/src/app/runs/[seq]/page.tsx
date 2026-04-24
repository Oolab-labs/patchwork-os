"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

// ------------------------------------------------------------------ types

interface StepResult {
  id: string;
  tool?: string;
  status: "ok" | "skipped" | "error";
  error?: string;
  durationMs: number;
}

interface AssertionFailure {
  assertion: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

interface RunDetail {
  seq: number;
  taskId: string;
  recipeName: string;
  trigger: string;
  status: "done" | "error" | "cancelled" | "interrupted";
  createdAt: number;
  startedAt?: number;
  doneAt: number;
  durationMs: number;
  model?: string;
  outputTail?: string;
  errorMessage?: string;
  stepResults?: StepResult[];
  assertionFailures?: AssertionFailure[];
}

interface PlanStep {
  id: string;
  type: "tool" | "agent" | "recipe";
  tool?: string;
  namespace?: string;
  into?: string;
  optional?: boolean;
  prompt?: string;
  dependencies?: string[];
  condition?: string;
  risk?: "low" | "medium" | "high";
  isWrite?: boolean;
  isConnector?: boolean;
  resolved?: boolean;
}

interface DryRunPlan {
  schemaVersion: number;
  recipe: string;
  mode: string;
  triggerType: string;
  generatedAt: string;
  steps: PlanStep[];
  parallelGroups?: string[][];
  maxDepth?: number;
  connectorNamespaces?: string[];
  hasWriteSteps?: boolean;
}

type Tab = "steps" | "plan";

// ------------------------------------------------------------------ helpers

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

// ------------------------------------------------------------------ assertion failures panel

function AssertionFailuresPanel({ failures }: { failures: AssertionFailure[] }) {
  return (
    <div className="card" style={{ marginBottom: 20, padding: 0, overflow: "hidden", borderColor: "var(--err)" }}>
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "color-mix(in srgb, var(--err) 8%, var(--bg-1))",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--err)" }}>
          Assertion Failures ({failures.length})
        </span>
        <span className="pill err" style={{ fontSize: 10 }}>expect</span>
      </div>
      {failures.map((f, i) => (
        <div
          key={i}
          style={{
            padding: "10px 16px",
            borderBottom: i < failures.length - 1 ? "1px solid var(--border-subtle)" : undefined,
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "6px 12px",
            alignItems: "start",
          }}
        >
          <span className="pill err" style={{ fontSize: 10, marginTop: 1 }}>{f.assertion}</span>
          <div>
            <div style={{ fontSize: 13, color: "var(--err)" }}>{f.message}</div>
            <div style={{ display: "flex", gap: 16, marginTop: 4 }}>
              <span className="mono muted" style={{ fontSize: 11 }}>
                expected: {JSON.stringify(f.expected)}
              </span>
              <span className="mono muted" style={{ fontSize: 11 }}>
                actual: {JSON.stringify(f.actual)}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ step-result row

function stepStatusClass(status: StepResult["status"]): string {
  if (status === "ok") return "ok";
  if (status === "error") return "err";
  return "muted";
}

function StepRow({
  step,
  index,
  totalDurationMs,
}: {
  step: StepResult;
  index: number;
  totalDurationMs: number;
}) {
  const [open, setOpen] = useState(false);
  const barWidth =
    totalDurationMs > 0
      ? Math.max(2, Math.round((step.durationMs / totalDurationMs) * 100))
      : 0;

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        cursor: step.error ? "pointer" : "default",
      }}
      onClick={() => step.error && setOpen((v) => !v)}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "28px 1fr auto auto",
          gap: 12,
          alignItems: "center",
          padding: "10px 16px",
        }}
      >
        <span className="mono muted" style={{ fontSize: 11, textAlign: "right" }}>
          {index + 1}
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            className="mono"
            style={{
              fontSize: 13,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {step.tool ?? step.id}
          </div>
          {step.tool && step.tool !== step.id && (
            <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
              {step.id}
            </div>
          )}
          <div
            style={{
              marginTop: 4,
              height: 3,
              borderRadius: 2,
              background: "var(--border-subtle)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${barWidth}%`,
                height: "100%",
                borderRadius: 2,
                background:
                  step.status === "error"
                    ? "var(--err)"
                    : step.status === "skipped"
                      ? "var(--fg-2)"
                      : "var(--ok)",
              }}
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {step.tool?.includes(".") && (
            <span className="pill muted" style={{ fontSize: 10 }}>connector</span>
          )}
          <span
            className={`pill ${stepStatusClass(step.status)}`}
            style={{ fontSize: 10 }}
          >
            {step.status === "ok" ? "ok" : step.status === "error" ? "error" : "skipped"}
          </span>
        </div>
        <span className="mono muted" style={{ fontSize: 11, minWidth: 40, textAlign: "right" }}>
          {fmtDur(step.durationMs)}
        </span>
      </div>
      {open && step.error && (
        <div style={{ padding: "8px 16px 12px 56px", background: "var(--bg-0)" }}>
          <pre style={{ margin: 0, fontSize: 11, color: "var(--err)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {step.error}
          </pre>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ plan step row

function riskClass(risk?: string): string {
  if (risk === "high") return "err";
  if (risk === "medium") return "warn";
  return "muted";
}

function PlanStepRow({ step, index, groupIndex }: { step: PlanStep; index: number; groupIndex?: number }) {
  return (
    <div
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        padding: "10px 16px",
        display: "grid",
        gridTemplateColumns: "28px 1fr auto",
        gap: 12,
        alignItems: "center",
      }}
    >
      <span className="mono muted" style={{ fontSize: 11, textAlign: "right" }}>
        {index + 1}
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          className="mono"
          style={{
            fontSize: 13,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {step.tool ?? step.id}
        </div>
        {step.tool && step.tool !== step.id && (
          <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
            id: {step.id}
          </div>
        )}
        {step.dependencies && step.dependencies.length > 0 && (
          <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
            awaits: {step.dependencies.join(", ")}
          </div>
        )}
        {step.condition && (
          <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
            when: {step.condition}
          </div>
        )}
        {groupIndex !== undefined && (
          <div className="muted" style={{ fontSize: 10, marginTop: 3 }}>
            parallel group {groupIndex + 1}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
        {step.isConnector && (
          <span className="pill muted" style={{ fontSize: 10 }}>connector</span>
        )}
        {step.isWrite && (
          <span className="pill warn" style={{ fontSize: 10 }}>write</span>
        )}
        {!step.resolved && step.type === "tool" && (
          <span className="pill err" style={{ fontSize: 10 }}>unresolved</span>
        )}
        {step.optional && (
          <span className="pill muted" style={{ fontSize: 10 }}>optional</span>
        )}
        {step.risk && step.risk !== "low" && (
          <span className={`pill ${riskClass(step.risk)}`} style={{ fontSize: 10 }}>
            {step.risk}
          </span>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ plan view

function PlanView({ plan }: { plan: DryRunPlan }) {
  // Build a map from stepId → group index for parallel group annotation
  const stepGroupMap = new Map<string, number>();
  if (plan.parallelGroups) {
    plan.parallelGroups.forEach((group, gi) => {
      group.forEach((id) => stepGroupMap.set(id, gi));
    });
  }

  return (
    <div>
      {/* summary badges */}
      <div style={{ padding: "12px 16px", display: "flex", gap: 8, flexWrap: "wrap", borderBottom: "1px solid var(--border-subtle)" }}>
        <span className="pill muted" style={{ fontSize: 11 }}>{plan.triggerType}</span>
        {plan.connectorNamespaces && plan.connectorNamespaces.length > 0 && (
          <span className="pill muted" style={{ fontSize: 11 }}>
            connectors: {plan.connectorNamespaces.join(", ")}
          </span>
        )}
        {plan.hasWriteSteps && (
          <span className="pill warn" style={{ fontSize: 11 }}>has writes</span>
        )}
        {plan.parallelGroups && plan.parallelGroups.length > 0 && (
          <span className="pill info" style={{ fontSize: 11 }}>
            {plan.parallelGroups.length} parallel group{plan.parallelGroups.length !== 1 ? "s" : ""}
          </span>
        )}
        {plan.maxDepth !== undefined && plan.maxDepth > 0 && (
          <span className="pill muted" style={{ fontSize: 11 }}>depth {plan.maxDepth}</span>
        )}
        <span className="pill muted" style={{ fontSize: 11, marginLeft: "auto" }}>
          generated {new Date(plan.generatedAt).toISOString().replace("T", " ").slice(0, 19)}
        </span>
      </div>

      {/* step list */}
      {plan.steps.map((step, i) => (
        <PlanStepRow
          key={step.id}
          step={step}
          index={i}
          groupIndex={stepGroupMap.get(step.id)}
        />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ page

export default function RunDetailPage() {
  const params = useParams();
  const seq = params.seq as string;

  const [run, setRun] = useState<RunDetail | null>(null);
  const [runErr, setRunErr] = useState<string>();
  const [tab, setTab] = useState<Tab>("steps");
  const [plan, setPlan] = useState<DryRunPlan | null>(null);
  const [planErr, setPlanErr] = useState<string>();
  const [planLoading, setPlanLoading] = useState(false);

  useEffect(() => {
    if (!seq) return;
    fetch(`/api/bridge/runs/${seq}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        const data = (await res.json()) as { run?: RunDetail };
        if (!data.run) throw new Error("empty response");
        setRun(data.run);
      })
      .catch((e) => setRunErr(e instanceof Error ? e.message : String(e)));
  }, [seq]);

  // Load plan lazily when tab is switched to "plan"
  useEffect(() => {
    if (tab !== "plan" || plan || planErr || !seq) return;
    setPlanLoading(true);
    fetch(`/api/bridge/runs/${seq}/plan`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `${res.status}`);
        }
        const data = (await res.json()) as { plan?: DryRunPlan };
        if (!data.plan) throw new Error("empty response");
        setPlan(data.plan);
      })
      .catch((e) => setPlanErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setPlanLoading(false));
  }, [tab, plan, planErr, seq]);

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: "6px 14px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    color: tab === t ? "var(--fg-1)" : "var(--fg-2)",
    background: "none",
    border: "none",
    borderBottom: tab === t ? "2px solid var(--fg-1)" : "2px solid transparent",
  });

  return (
    <section>
      {/* ── header ── */}
      <div className="page-head" style={{ marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--fg-2)", marginBottom: 4 }}>
            <Link href="/runs" style={{ color: "var(--fg-2)" }}>Runs</Link>
            {" / "}
            <span className="mono">#{seq}</span>
          </div>
          <h1 style={{ margin: 0 }}>
            {run ? run.recipeName : <span style={{ color: "var(--fg-2)" }}>…</span>}
          </h1>
          {run && (
            <div className="page-head-sub" style={{ marginTop: 4 }}>
              {fmtTs(run.createdAt)} &middot; {fmtDur(run.durationMs)} &middot;{" "}
              <span className="pill muted" style={{ fontSize: 11 }}>{run.trigger}</span>{" "}
              <span className={`pill ${run.status === "done" ? "ok" : "err"}`} style={{ fontSize: 11 }}>
                {run.status}
              </span>
              {run.model && (
                <>{" "}<span className="pill muted" style={{ fontSize: 11 }}>{run.model}</span></>
              )}
              {run.assertionFailures && run.assertionFailures.length > 0 && (
                <>{" "}<span className="pill err" style={{ fontSize: 11 }}>{run.assertionFailures.length} assertion{run.assertionFailures.length !== 1 ? "s" : ""} failed</span></>
              )}
            </div>
          )}
        </div>
      </div>

      {runErr && <div className="alert-err">Failed to load run: {runErr}</div>}
      {!run && !runErr && <div className="empty-state"><p>Loading…</p></div>}

      {run && (
        <>
          {/* ── tabs ── */}
          <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border-subtle)", marginBottom: 16 }}>
            <button style={tabStyle("steps")} onClick={() => setTab("steps")}>
              Steps {run.stepResults ? `(${run.stepResults.length})` : ""}
            </button>
            <button style={tabStyle("plan")} onClick={() => setTab("plan")}>
              Execution Plan
            </button>
          </div>

          {/* ── steps tab ── */}
          {tab === "steps" && (
            <>
              {run.assertionFailures && run.assertionFailures.length > 0 && (
                <AssertionFailuresPanel failures={run.assertionFailures} />
              )}
              {run.stepResults && run.stepResults.length > 0 ? (
                <div className="card" style={{ marginBottom: 20, padding: 0, overflow: "hidden" }}>
                  <div
                    style={{
                      padding: "12px 16px",
                      borderBottom: "1px solid var(--border-subtle)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      Steps ({run.stepResults.length})
                    </span>
                    <span className="mono muted" style={{ fontSize: 11 }}>
                      total {fmtDur(run.durationMs)}
                    </span>
                  </div>
                  {run.stepResults.map((step, i) => (
                    <StepRow
                      key={step.id}
                      step={step}
                      index={i}
                      totalDurationMs={run.durationMs}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-state" style={{ marginBottom: 20 }}>
                  <p>
                    No step-level data for this run.
                    <br />
                    Step results are captured for recipes run via{" "}
                    <code>patchwork recipe run</code> — older runs in the log do
                    not carry step detail.
                  </p>
                </div>
              )}
            </>
          )}

          {/* ── plan tab ── */}
          {tab === "plan" && (
            <div className="card" style={{ marginBottom: 20, padding: 0, overflow: "hidden" }}>
              <div
                style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--border-subtle)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600 }}>Execution Plan</span>
                <span className="muted" style={{ fontSize: 11 }}>
                  re-generated from current registry
                </span>
              </div>
              {planLoading && (
                <div style={{ padding: 20, color: "var(--fg-2)", fontSize: 13 }}>Generating…</div>
              )}
              {planErr && (
                <div className="alert-err" style={{ margin: 16 }}>
                  {planErr.includes("not_found") || planErr.includes("ENOENT")
                    ? `Recipe file not found on disk for "${run.recipeName}" — plan generation requires the recipe YAML to be present.`
                    : `Plan error: ${planErr}`}
                </div>
              )}
              {plan && !planLoading && <PlanView plan={plan} />}
            </div>
          )}

          {/* ── meta card ── */}
          <div className="card" style={{ padding: "14px 16px" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontSize: 10, color: "var(--fg-2)", marginBottom: 2 }}>TASK ID</div>
                <span className="mono" style={{ fontSize: 12 }}>{run.taskId}</span>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "var(--fg-2)", marginBottom: 2 }}>STARTED</div>
                <span className="mono" style={{ fontSize: 12 }}>
                  {run.startedAt ? fmtTs(run.startedAt) : "—"}
                </span>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "var(--fg-2)", marginBottom: 2 }}>FINISHED</div>
                <span className="mono" style={{ fontSize: 12 }}>{fmtTs(run.doneAt)}</span>
              </div>
              {run.model && (
                <div>
                  <div style={{ fontSize: 10, color: "var(--fg-2)", marginBottom: 2 }}>MODEL</div>
                  <span className="mono" style={{ fontSize: 12 }}>{run.model}</span>
                </div>
              )}
            </div>
            {run.errorMessage && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 10, color: "var(--err)", marginBottom: 4 }}>ERROR</div>
                <pre style={{ margin: 0, fontSize: 12, color: "var(--err)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {run.errorMessage}
                </pre>
              </div>
            )}
            {run.outputTail && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 10, color: "var(--fg-2)", marginBottom: 4 }}>OUTPUT TAIL</div>
                <pre className="task-output" style={{ borderTop: "none", padding: 0 }}>
                  {run.outputTail}
                </pre>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
