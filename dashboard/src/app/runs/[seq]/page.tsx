"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { StepDiffHover } from "@/components/StepDiffHover";
import { useBridgeStream } from "@/hooks/useBridgeStream";
import { diffForStep } from "@/lib/registryDiff";

// ------------------------------------------------------------------ types

interface StepResult {
  id: string;
  tool?: string;
  status: "running" | "ok" | "skipped" | "error";
  error?: string;
  durationMs: number;
  // VD-2 capture (all optional — pre-VD-2 runs don't have these).
  resolvedParams?: unknown;
  output?: unknown;
  registrySnapshot?: Record<string, unknown>;
  startedAt?: number;
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
  status: "running" | "done" | "error" | "cancelled" | "interrupted";
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
  if (status === "running") return "running";
  if (status === "ok") return "ok";
  if (status === "error") return "err";
  return "muted";
}

function stepStatusLabel(status: StepResult["status"]): string {
  if (status === "running") return "running";
  if (status === "ok") return "ok";
  if (status === "error") return "error";
  return "skipped";
}

function StepRow({
  step,
  index,
  totalDurationMs,
  allSteps,
}: {
  step: StepResult;
  index: number;
  totalDurationMs: number;
  allSteps: StepResult[];
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hover-on with 200ms grace so quick mouse passes don't flicker the
  // panel. Hover-off clears the panel and any pending timer immediately.
  const onEnter = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHover(true), 200);
  };
  const onLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHover(false);
  };
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  // Hover panel only renders if VD-2 capture is present OR we want to
  // show the unavailable empty state for older runs. For now: skip the
  // panel entirely on `running` steps (capture isn't there yet) and on
  // skipped steps (no semantically meaningful diff).
  const hoverEligible =
    step.status === "ok" || step.status === "error";
  const diff = hoverEligible ? diffForStep(allSteps, index) : null;
  const showPanel = hover && hoverEligible;

  const barWidth =
    totalDurationMs > 0
      ? Math.max(2, Math.round((step.durationMs / totalDurationMs) * 100))
      : 0;

  return (
    <div
      style={{
        position: "relative",
        borderBottom: "1px solid var(--border-subtle)",
        cursor: step.error ? "pointer" : "default",
      }}
      onClick={() => step.error && setOpen((v) => !v)}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
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
            {stepStatusLabel(step.status)}
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
      {showPanel && (
        <StepDiffHover
          diff={diff}
          resolvedParams={step.resolvedParams}
          output={step.output}
          onClose={() => setHover(false)}
        />
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
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const doFetch = () =>
      fetch(apiPath(`/api/bridge/runs/${seq}`))
        .then(async (res) => {
          if (!res.ok) throw new Error(`${res.status}`);
          const data = (await res.json()) as { run?: RunDetail };
          if (!data.run) throw new Error("empty response");
          setRun(data.run);
          return data.run;
        })
        .catch((e: unknown) => {
          setRunErr(e instanceof Error ? e.message : String(e));
          return null;
        });

    doFetch().then((initialRun) => {
      if (!initialRun || initialRun.status !== "running") return;
      // Slower polling now that SSE delivers the live step deltas — polling
      // is just a backstop to canonicalize when the run transitions to
      // terminal (no `recipe_run_done` event yet; keep this until VD-1C).
      intervalId = setInterval(() => {
        doFetch().then((r) => {
          if (!r || r.status !== "running") {
            clearInterval(intervalId);
            intervalId = undefined;
          }
        });
      }, 5000);
    });

    return () => {
      if (intervalId !== undefined) clearInterval(intervalId);
    };
  }, [seq]);

  // VD-1B live-tail: subscribe to ActivityLog SSE while the run is in flight
  // and merge `recipe_step_start` / `recipe_step_done` events into the local
  // step state. The bridge tags every event with `runSeq` so we filter to
  // events for this page's run only.
  const onStreamEvent = useCallback(
    (type: string, raw: unknown) => {
      if (type !== "lifecycle") return;
      const data = raw as
        | {
            event?: string;
            metadata?: {
              runSeq?: number;
              stepId?: string;
              tool?: string;
              status?: "ok" | "error";
              error?: string;
              durationMs?: number;
            };
          }
        | undefined;
      const md = data?.metadata;
      if (!md || md.runSeq !== Number(seq)) return;
      const stepId = md.stepId;
      if (!stepId) return;

      if (data.event === "recipe_step_start") {
        setRun((prev) => {
          if (!prev) return prev;
          const existing = prev.stepResults ?? [];
          if (existing.some((s) => s.id === stepId)) return prev;
          return {
            ...prev,
            stepResults: [
              ...existing,
              {
                id: stepId,
                tool: md.tool,
                status: "running",
                durationMs: 0,
              },
            ],
          };
        });
      } else if (data.event === "recipe_step_done") {
        setRun((prev) => {
          if (!prev) return prev;
          const existing = prev.stepResults ?? [];
          const idx = existing.findIndex((s) => s.id === stepId);
          const updated: StepResult = {
            id: stepId,
            tool: md.tool,
            status: md.status === "error" ? "error" : "ok",
            ...(md.error !== undefined && { error: md.error }),
            durationMs: md.durationMs ?? 0,
          };
          if (idx === -1) {
            return { ...prev, stepResults: [...existing, updated] };
          }
          const next = existing.slice();
          next[idx] = updated;
          return { ...prev, stepResults: next };
        });
      }
    },
    [seq],
  );

  useBridgeStream("/api/bridge/stream", onStreamEvent, {
    enabled: run?.status === "running",
  });

  // Load plan lazily when tab is switched to "plan"
  useEffect(() => {
    if (tab !== "plan" || plan || planErr || !seq) return;
    setPlanLoading(true);
    fetch(apiPath(`/api/bridge/runs/${seq}/plan`))
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
      {/* ── sticky header ── */}
      <div
        className="card"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          padding: "16px 20px",
          marginBottom: "var(--s-4)",
          display: "flex",
          alignItems: "center",
          gap: "var(--s-4)",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 2 }}>
            <Link href="/runs" style={{ color: "var(--ink-2)" }}>Runs</Link>
            {" / "}
            <span className="mono">#{seq}</span>
          </div>
          <h1 style={{ margin: 0, fontSize: 22 }}>
            {run ? run.recipeName : <span style={{ color: "var(--ink-3)" }}>…</span>}
          </h1>
        </div>
        {run && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="pill muted" style={{ fontSize: 11 }}>{run.trigger}</span>
            <span
              className={`pill ${run.status === "done" && !(run.assertionFailures?.length) ? "ok" : (run.status === "cancelled" || run.status === "interrupted") ? "warn" : "err"}`}
              style={{ fontSize: 11 }}
            >
              <span className="pill-dot" />
              {run.status}
            </span>
            <span className="pill muted" style={{ fontSize: 11 }}>
              {fmtDur(run.durationMs)}
            </span>
            {run.model && (
              <span className="pill muted" style={{ fontSize: 11 }}>{run.model}</span>
            )}
            {run.assertionFailures && run.assertionFailures.length > 0 && (
              <span className="pill err" style={{ fontSize: 11 }}>
                {run.assertionFailures.length} assertion{run.assertionFailures.length !== 1 ? "s" : ""} failed
              </span>
            )}
            <span style={{ fontSize: 11, color: "var(--ink-3)", marginLeft: 4 }}>
              {fmtTs(run.createdAt)}
            </span>
          </div>
        )}
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
                      allSteps={run.stepResults ?? []}
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
