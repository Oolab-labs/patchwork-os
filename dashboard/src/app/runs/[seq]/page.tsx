"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { EntityTimeline, RelationStrip, RelatedPanel } from "@/components/patchwork";
import type { TimelineEvent, RelatedGroup } from "@/components/patchwork";
import { RecipeChip, RunChip, ToolChip, InboxChip } from "@/components/patchwork/entity";
import { StepDiffHover } from "@/components/StepDiffHover";
import { Dialog } from "@/components/Dialog";
import { useBridgeStream } from "@/hooks/useBridgeStream";
import {
  HALT_CATEGORY_HINT,
  type HaltCategory,
} from "@/lib/haltCategory";
import { diffForStep, previewMockedReplay } from "@/lib/registryDiff";
import {
  type JudgeVerdict,
  JudgeVerdictPill,
} from "./_components/JudgeVerdictPill";

// ------------------------------------------------------------------ types

interface StepResult {
  id: string;
  tool?: string;
  status: "running" | "ok" | "skipped" | "error";
  error?: string;
  /** One-sentence human-actionable halt reason for error rows. */
  haltReason?: string;
  /** Bounded halt category — drives the inline fix hint on error rows. */
  haltCategory?: HaltCategory;
  /** PR3a — cold-eyes judge verdict. Augment-only: never affects status. */
  judgeVerdict?: JudgeVerdict;
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
  status: "pending" | "running" | "done" | "error" | "cancelled" | "interrupted";
  createdAt: number;
  startedAt?: number;
  doneAt: number;
  durationMs: number;
  model?: string;
  outputTail?: string;
  errorMessage?: string;
  stepResults?: StepResult[];
  assertionFailures?: AssertionFailure[];
  /** seq of the run that triggered this one (trigger === "recipe"). */
  parentSeq?: number;
  /** seqs of runs triggered by this run. */
  childSeqs?: number[];
  /** PR5c — stable id shared across resumed retries of the same attempt. */
  manualRunId?: string;
  /** Run finished `done` but ≥1 step ended in error — "completed with
   *  errors". Set by the bridge run log (see runLog.hadStepErrors). */
  hadStepErrors?: boolean;
  /** Bridge-provided list of inbox files this run produced (see
   *  RecipeRun.inboxOutputs in src/runLog.ts). Forwarded straight
   *  through the dashboard's bridge pass-through proxy. */
  inboxOutputs?: Array<{ filename: string; deliveredAt: number }>;
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

// ------------------------------------------------------------------ shared bits

/** Inline mono value with a Copy button. 28pt min-height tap target. */
function CopyableMono({ value, ariaLabel }: { value: string; ariaLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(copyTimerRef.current); }, []);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%" }}>
      <span
        className="mono"
        style={{ fontSize: "var(--fs-s)", overflow: "hidden", textOverflow: "ellipsis" }}
        title={value}
      >
        {value}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={ariaLabel ?? `Copy ${value}`}
        title={copied ? "Copied!" : "Copy to clipboard"}
        style={{
          background: "transparent",
          border: "1px solid var(--line-2)",
          borderRadius: 4,
          cursor: "pointer",
          fontSize: "var(--fs-2xs)",
          padding: "2px 6px",
          minHeight: 24,
          color: copied ? "var(--ok)" : "var(--ink-3)",
          flexShrink: 0,
        }}
      >
        {copied ? "✓" : "Copy"}
      </button>
    </span>
  );
}

/**
 * <pre> with truncation + show-more toggle. Long error/output blocks
 * (thousands of lines) used to blow out the run-detail card and force a
 * full-page scroll. Truncates at MAX_LINES by default; user can expand
 * inline or copy the full text in one click.
 */
function TruncatablePre({
  text,
  maxLines = 12,
  color,
  className,
}: {
  text: string;
  maxLines?: number;
  color?: string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const truncCopyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(truncCopyTimerRef.current); }, []);
  const lines = text.split("\n");
  const truncated = lines.length > maxLines && !expanded;
  const shown = truncated ? lines.slice(0, maxLines).join("\n") : text;
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(truncCopyTimerRef.current);
      truncCopyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div>
      <pre
        className={className}
        style={{
          margin: 0,
          fontSize: "var(--fs-s)",
          color: color ?? "inherit",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {shown}
        {truncated && <span style={{ color: "var(--ink-3)" }}>{`\n… (${lines.length - maxLines} more lines)`}</span>}
      </pre>
      <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
        {lines.length > maxLines && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: "transparent",
              border: "1px solid var(--line-2)",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: "var(--fs-2xs)",
              padding: "3px 8px",
              minHeight: 24,
              color: "var(--ink-3)",
            }}
          >
            {expanded ? "Show less" : `Show all ${lines.length} lines`}
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          aria-label="Copy text"
          title={copied ? "Copied!" : "Copy full text"}
          style={{
            background: "transparent",
            border: "1px solid var(--line-2)",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: "var(--fs-2xs)",
            padding: "3px 8px",
            minHeight: 24,
            color: copied ? "var(--ok)" : "var(--ink-3)",
          }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
    </div>
  );
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
        <span style={{ fontSize: "var(--fs-m)", fontWeight: 600, color: "var(--err)" }}>
          Assertion Failures ({failures.length})
        </span>
        <span className="pill err" style={{ fontSize: "var(--fs-2xs)" }}>expect</span>
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
          <span className="pill err" style={{ fontSize: "var(--fs-2xs)", marginTop: 1 }}>{f.assertion}</span>
          <div>
            <div style={{ fontSize: "var(--fs-m)", color: "var(--err)" }}>{f.message}</div>
            <div style={{ display: "flex", gap: 16, marginTop: 4 }}>
              <span className="mono muted" style={{ fontSize: "var(--fs-xs)" }}>
                expected: {JSON.stringify(f.expected)}
              </span>
              <span className="mono muted" style={{ fontSize: "var(--fs-xs)" }}>
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
  recipeName,
  openOverride,
  onLocalToggle,
}: {
  step: StepResult;
  index: number;
  totalDurationMs: number;
  allSteps: StepResult[];
  recipeName: string;
  /** When non-null, overrides the row's local open state (parent
   *  "Expand all" / "Collapse all" support). User-initiated row toggles
   *  call onLocalToggle to clear the override + manage local state. */
  openOverride?: boolean | null;
  onLocalToggle?: (next: boolean) => void;
}) {
  const [openLocal, setOpen] = useState(false);
  const open = openOverride !== null && openOverride !== undefined ? openOverride : openLocal;
  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    onLocalToggle?.(next);
  };
  const [hover, setHover] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Hover-on with 200ms grace so quick mouse passes don't flicker the
  // panel. Hover-off clears the panel and any pending timer immediately.
  // Captures the wrapper's bounding rect at hover-fire time so the
  // portal-mounted panel can position relative to it.
  const onEnter = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      if (wrapperRef.current) {
        setAnchorRect(wrapperRef.current.getBoundingClientRect());
      }
      setHover(true);
    }, 200);
  };
  const onLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHover(false);
    setAnchorRect(null);
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
  const hoverEligible = step.status === "ok" || step.status === "error";
  const diffResult = hoverEligible
    ? diffForStep(allSteps, index)
    : { kind: "unavailable" as const };
  const showPanel = hover && hoverEligible;

  const barWidth =
    totalDurationMs > 0
      ? Math.max(2, Math.round((step.durationMs / totalDurationMs) * 100))
      : 0;

  return (
    <div
      ref={wrapperRef}
      // Anchor for halt breadcrumb deep-links. When a run ends with
      // a haltReason that names a stepId, links can land on
      // /runs/:seq#step-<id> and scroll the failing row into view.
      id={`step-${step.id}`}
      className="rd-step-row rd-step-stagger"
      style={{
        position: "relative",
        borderBottom: "1px solid var(--border-subtle)",
        borderLeft: step.status === "running"
          ? "3px solid var(--accent)"
          : step.status === "error"
            ? "3px solid var(--err)"
            : "3px solid transparent",
        scrollMarginTop: 80,
        cursor: step.error ? "pointer" : "default",
        animationDelay: `${Math.min(index * 40, 600)}ms`,
      }}
      onClick={() => step.error && toggleOpen()}
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
        <span className="mono muted" style={{ fontSize: "var(--fs-xs)", textAlign: "right" }}>
          {index + 1}
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            className="mono"
            style={{
              fontSize: "var(--fs-m)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {step.tool ? (
              <span
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                style={{ display: "inline-flex" }}
              >
                <ToolChip name={step.tool} variant="link" />
              </span>
            ) : (
              step.id
            )}
          </div>
          {step.tool && step.tool !== step.id && (
            <div className="mono muted" style={{ fontSize: "var(--fs-xs)", marginTop: 2 }}>
              {step.id}
            </div>
          )}
          {step.haltReason && step.status === "error" && (
            <div
              style={{
                fontSize: "var(--fs-xs)",
                marginTop: 4,
                color: "var(--err)",
                whiteSpace: "normal",
                wordBreak: "break-word",
              }}
              title="halt reason"
            >
              {step.haltReason}
            </div>
          )}
          {step.status === "error" && step.haltCategory && (
            // The haltReason says what broke; this says what to do about
            // it. Same HALT_CATEGORY_HINT map the /runs list uses.
            <div
              style={{
                fontSize: "var(--fs-xs)",
                marginTop: 2,
                color: "var(--accent)",
                whiteSpace: "normal",
                wordBreak: "break-word",
              }}
              title="suggested fix"
            >
              → {HALT_CATEGORY_HINT[step.haltCategory]}
            </div>
          )}
          {step.judgeVerdict && (
            <JudgeVerdictPill verdict={step.judgeVerdict} />
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
                      ? "var(--ink-2)"
                      : "var(--ok)",
              }}
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {step.tool?.includes(".") && (
            <span className="pill muted" style={{ fontSize: "var(--fs-2xs)" }}>connector</span>
          )}
          <span
            className={`pill ${stepStatusClass(step.status)}`}
            style={{ fontSize: "var(--fs-2xs)", display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            {step.status === "running" && (
              <span className="rd-step-running-indicator" style={{ width: 8, height: 8, borderWidth: 1.5 }} />
            )}
            {stepStatusLabel(step.status)}
          </span>
        </div>
        <span className="mono muted" style={{ fontSize: "var(--fs-xs)", minWidth: 40, textAlign: "right" }}>
          {fmtDur(step.durationMs)}
        </span>
      </div>
      {open && step.error && (
        <div style={{ padding: "8px 16px 12px 56px", background: "var(--bg-0)" }}>
          <TruncatablePre text={step.error} color="var(--err)" maxLines={8} />
          {recipeName && (
            <div
              style={{
                marginTop: 8,
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                alignItems: "center",
                fontSize: "var(--fs-xs)",
              }}
            >
              <Link
                href={`/recipes/${encodeURIComponent(recipeName)}/edit#step-${encodeURIComponent(step.id)}`}
                style={{
                  color: "var(--accent)",
                  textDecoration: "none",
                  fontWeight: 600,
                  // ≥44pt touch target on mobile — explicit padding lets
                  // touch devices hit it without sub-pixel aiming.
                  padding: "8px 4px",
                  minHeight: 32,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Open step ${step.id} in recipe YAML`}
              >
                → open in recipe YAML
              </Link>
              <span className="mono muted" style={{ fontSize: "var(--fs-2xs)" }}>
                step id: {step.id}
              </span>
            </div>
          )}
        </div>
      )}
      {showPanel && (
        <StepDiffHover
          result={diffResult}
          resolvedParams={step.resolvedParams}
          output={step.output}
          anchorRect={anchorRect}
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
      <span className="mono muted" style={{ fontSize: "var(--fs-xs)", textAlign: "right" }}>
        {index + 1}
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          className="mono"
          style={{
            fontSize: "var(--fs-m)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {step.tool ?? step.id}
        </div>
        {step.tool && step.tool !== step.id && (
          <div className="mono muted" style={{ fontSize: "var(--fs-xs)", marginTop: 2 }}>
            id: {step.id}
          </div>
        )}
        {step.dependencies && step.dependencies.length > 0 && (
          <div className="mono muted" style={{ fontSize: "var(--fs-xs)", marginTop: 2 }}>
            awaits: {step.dependencies.join(", ")}
          </div>
        )}
        {step.condition && (
          <div className="mono muted" style={{ fontSize: "var(--fs-xs)", marginTop: 2 }}>
            when: {step.condition}
          </div>
        )}
        {groupIndex !== undefined && (
          <div className="muted" style={{ fontSize: "var(--fs-2xs)", marginTop: 3 }}>
            parallel group {groupIndex + 1}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
        {step.isConnector && (
          <span className="pill muted" style={{ fontSize: "var(--fs-2xs)" }}>connector</span>
        )}
        {step.isWrite && (
          <span className="pill warn" style={{ fontSize: "var(--fs-2xs)" }}>write</span>
        )}
        {!step.resolved && step.type === "tool" && (
          <span className="pill err" style={{ fontSize: "var(--fs-2xs)" }}>unresolved</span>
        )}
        {step.optional && (
          <span className="pill muted" style={{ fontSize: "var(--fs-2xs)" }}>optional</span>
        )}
        {step.risk && step.risk !== "low" && (
          <span className={`pill ${riskClass(step.risk)}`} style={{ fontSize: "var(--fs-2xs)" }}>
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
        <span className="pill muted" style={{ fontSize: "var(--fs-xs)" }}>{plan.triggerType}</span>
        {plan.connectorNamespaces && plan.connectorNamespaces.length > 0 && (
          <span className="pill muted" style={{ fontSize: "var(--fs-xs)" }}>
            connectors: {plan.connectorNamespaces.join(", ")}
          </span>
        )}
        {plan.hasWriteSteps && (
          <span className="pill warn" style={{ fontSize: "var(--fs-xs)" }}>has writes</span>
        )}
        {plan.parallelGroups && plan.parallelGroups.length > 0 && (
          <span className="pill info" style={{ fontSize: "var(--fs-xs)" }}>
            {plan.parallelGroups.length} parallel group{plan.parallelGroups.length !== 1 ? "s" : ""}
          </span>
        )}
        {plan.maxDepth !== undefined && plan.maxDepth > 0 && (
          <span className="pill muted" style={{ fontSize: "var(--fs-xs)" }}>depth {plan.maxDepth}</span>
        )}
        <span className="pill muted" style={{ fontSize: "var(--fs-xs)", marginLeft: "auto" }}>
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

// ------------------------------------------------------------------ causal chain card

interface RunSummary {
  seq: number;
  recipeName: string;
  status: RunDetail["status"];
  durationMs: number;
}

function statusPillClass(status: RunDetail["status"]): string {
  if (status === "done") return "ok";
  if (status === "running") return "running";
  if (status === "error") return "err";
  return "warn";
}

function CausalChainCard({ run }: { run: RunDetail }) {
  const [parent, setParent] = useState<RunSummary | null>(null);
  const [children, setChildren] = useState<RunSummary[]>([]);
  // Serialize childSeqs for the dep array. Using the array reference
  // directly re-fires this effect on every 5s polling tick (the parent
  // returns a fresh RunDetail object → fresh childSeqs reference,
  // even when contents are identical), which means full N+1 re-fetch
  // every 5s while the page is open. Audit 2026-05-17 (#600). Serialize
  // to a string so identity equality holds across stable contents.
  const childSeqsKey = run.childSeqs?.join(",") ?? "";

  useEffect(() => {
    const controller = new AbortController();
    if (run.parentSeq) {
      fetch(apiPath(`/api/bridge/runs/${run.parentSeq}`), { signal: controller.signal })
        .then((r) => r.ok ? r.json() : null)
        .then((d: { run?: RunSummary } | null) => {
          if (d?.run) setParent(d.run);
        })
        .catch(() => {});
    }
    if (run.childSeqs && run.childSeqs.length > 0) {
      Promise.all(
        run.childSeqs.map((seq) =>
          fetch(apiPath(`/api/bridge/runs/${seq}`), { signal: controller.signal })
            .then((r) => r.ok ? r.json() : null)
            .then((d: { run?: RunSummary } | null) => d?.run ?? null)
            .catch(() => null),
        ),
      ).then((results) => {
        setChildren(results.filter((r): r is RunSummary => r !== null));
      });
    }
    return () => controller.abort();
    // childSeqsKey is the serialized form of run.childSeqs — using the
    // array directly would re-run every poll tick. eslint can't see
    // the equivalence; this is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.parentSeq, childSeqsKey]);

  const hasParent = !!run.parentSeq;
  const hasChildren = (run.childSeqs ?? []).length > 0;
  if (!hasParent && !hasChildren) return null;

  return (
    <div className="card" style={{ marginBottom: 20, padding: 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          fontSize: "var(--fs-s)",
          fontWeight: 600,
          color: "var(--ink-2)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        Causal chain
      </div>
      <div style={{ padding: "8px 0" }}>
        {hasParent && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 16px",
            }}
          >
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", minWidth: 56 }}>triggered by</span>
            <RunChip
              seq={run.parentSeq as number}
              status={parent?.status}
              recipeName={parent?.recipeName}
              variant="row"
            />
            {parent && (
              <RecipeChip name={parent.recipeName} variant="link" />
            )}
            {parent && (
              <span className="mono muted" style={{ fontSize: "var(--fs-xs)", marginLeft: "auto" }}>
                {fmtDur(parent.durationMs)}
              </span>
            )}
          </div>
        )}
        {hasParent && hasChildren && (
          <div style={{ margin: "2px 16px", borderTop: "1px solid var(--border-subtle)" }} />
        )}
        {(run.childSeqs ?? []).map((childSeq, i) => {
          const child = children.find((c) => c.seq === childSeq);
          return (
            <div
              key={childSeq}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 16px",
                borderTop: i > 0 ? "1px solid var(--border-subtle)" : undefined,
              }}
            >
              <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", minWidth: 56 }}>triggered</span>
              <RunChip
                seq={childSeq}
                status={child?.status}
                recipeName={child?.recipeName}
                variant="row"
              />
              {child && (
                <RecipeChip name={child.recipeName} variant="link" />
              )}
              {child && (
                <span className="mono muted" style={{ fontSize: "var(--fs-xs)", marginLeft: "auto" }}>
                  {fmtDur(child.durationMs)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReplayPreflight({ stepResults }: { stepResults: StepResult[] }) {
  const preflight = previewMockedReplay(stepResults);
  if (preflight.unmocked.length === 0) {
    return (
      <p style={{ fontSize: "var(--fs-s)", color: "var(--ink-3)", margin: "0 0 16px" }}>
        All {preflight.mocked.length} step
        {preflight.mocked.length === 1 ? "" : "s"} will be mocked from captures.
        No external API calls.
      </p>
    );
  }
  return (
    <div
      style={{
        fontSize: "var(--fs-s)",
        margin: "0 0 16px",
        padding: "8px 10px",
        borderRadius: "var(--r-1)",
        border: "1px solid var(--amber)",
        background: "var(--amber-soft)",
        color: "var(--amber)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {preflight.unmocked.length} step
        {preflight.unmocked.length === 1 ? "" : "s"} will run for real (no
        usable capture)
      </div>
      <ul style={{ margin: "4px 0 0", paddingLeft: 20, color: "var(--ink-2)" }}>
        {preflight.unmocked.slice(0, 8).map((u) => (
          <li key={u.id} className="mono" style={{ fontSize: "var(--fs-xs)" }}>
            {u.tool ? `${u.tool} ` : ""}
            <span style={{ color: "var(--ink-3)" }}>({u.id})</span>
            {" — "}
            {u.reason === "truncated"
              ? "output >8 KB, will fire real tool"
              : "no capture"}
          </li>
        ))}
        {preflight.unmocked.length > 8 && (
          <li style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)" }}>
            …and {preflight.unmocked.length - 8} more
          </li>
        )}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ page

// CSS for this page has been moved to globals.css (rd/* namespace).

export default function RunDetailPage() {
  const params = useParams();
  const seq = params.seq as string;
  const seqIsValid = !!seq && /^\d+$/.test(seq);

  const [run, setRun] = useState<RunDetail | null>(null);
  const [runErr, setRunErr] = useState<string>();
  const [tab, setTab] = useState<Tab>("steps");
  // Bulk expand/collapse all step rows. null = each row uses its local
  // state; true/false overrides until the user clicks any individual
  // row toggle (which clears the override).
  const [stepsAllOpen, setStepsAllOpen] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<DryRunPlan | null>(null);
  const [planErr, setPlanErr] = useState<string>();
  const [planLoading, setPlanLoading] = useState(false);
  const [replayState, setReplayState] = useState<
    "idle" | "confirming" | "running" | "done" | "error"
  >("idle");
  const [replayMessage, setReplayMessage] = useState<string>();
  const replayTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Phase 1A item 8 — surface prior fix decisions for this recipe.
  // `ctxQueryTraces({traceType:"decision", key:recipeName})` is what powers
  // the /decisions and /traces pages; we read the same /api/bridge/traces
  // endpoint here so a failed run can show "you (or a teammate) recorded
  // a fix for this recipe before". Only fetched when the run actually
  // failed — successful runs don't need to nag.
  const [priorFixes, setPriorFixes] = useState<
    Array<{ ts: number; summary: string; tags?: string[] }>
  >([]);

  const handleReplay = async () => {
    if (!seq) return;
    setReplayState("running");
    setReplayMessage(undefined);
    try {
      const res = await fetch(apiPath(`/api/bridge/runs/${seq}/replay`), {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        newSeq?: number;
        unmockedSteps?: string[];
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setReplayState("error");
        setReplayMessage(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setReplayState("done");
      const warnSuffix = data.unmockedSteps?.length
        ? ` (${data.unmockedSteps.length} step${data.unmockedSteps.length === 1 ? "" : "s"} ran without mocked output: ${data.unmockedSteps.join(", ")})`
        : "";
      setReplayMessage(
        data.newSeq
          ? `Replayed as run #${data.newSeq}${warnSuffix}`
          : `Replay queued${warnSuffix}`,
      );
    } catch (e) {
      setReplayState("error");
      setReplayMessage(e instanceof Error ? e.message : String(e));
    } finally {
      // Return to idle after a beat so the user can re-trigger if they want
      // to replay a second time without staring at a stale "done" banner.
      clearTimeout(replayTimeoutRef.current);
      replayTimeoutRef.current = setTimeout(() => {
        setReplayState((cur) => (cur === "done" || cur === "error" ? "idle" : cur));
      }, 4000);
    }
  };

  useEffect(() => () => { clearTimeout(replayTimeoutRef.current); }, []);

  useEffect(() => {
    if (!seqIsValid) return;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const controller = new AbortController();
    const { signal } = controller;

    const doFetch = () =>
      fetch(apiPath(`/api/bridge/runs/${seq}`), { signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`${res.status}`);
          const data = (await res.json()) as { run?: RunDetail };
          if (!data.run) throw new Error("empty response");
          setRun(data.run);
          return data.run;
        })
        .catch((e: unknown) => {
          if (signal.aborted) return null;
          setRunErr(e instanceof Error ? e.message : String(e));
          return null;
        });

    const isInFlight = (r: RunDetail | null) =>
      r?.status === "running" || r?.status === "pending";

    doFetch().then((initialRun) => {
      if (!isInFlight(initialRun)) return;
      // Slower polling now that SSE delivers the live step deltas — polling
      // is just a backstop to canonicalize when the run transitions to
      // terminal (no `recipe_run_done` event yet; keep this until VD-1C).
      // Also covers the pending → running transition so the page stays live
      // when a queued run is picked up by the worker.
      intervalId = setInterval(() => {
        doFetch().then((r) => {
          if (!isInFlight(r)) {
            clearInterval(intervalId);
            intervalId = undefined;
          }
        });
      }, 5000);
    });

    return () => {
      if (intervalId !== undefined) clearInterval(intervalId);
      controller.abort();
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

  // Phase 1A item 8 — fetch prior fix decisions for this recipe when the
  // current run failed. Decision traces are the persisted output of
  // ctxSaveTrace; users record "I fixed recipe X by Y" entries that ought
  // to be visible exactly when someone is staring at a new failure for
  // the same recipe.
  const recipeNameForTraces = run?.recipeName ?? null;
  const runFailed = run?.status === "error";
  useEffect(() => {
    if (!runFailed || !recipeNameForTraces) {
      setPriorFixes([]);
      return;
    }
    const controller = new AbortController();
    const qs = new URLSearchParams({
      key: recipeNameForTraces,
      limit: "5",
    }).toString();
    fetch(apiPath(`/api/bridge/traces?${qs}`), {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !Array.isArray((data as { traces?: unknown }).traces)) {
          setPriorFixes([]);
          return;
        }
        type RawTrace = {
          ts?: number;
          summary?: string;
          tags?: unknown;
          traceType?: string;
        };
        const traces = (data as { traces: RawTrace[] }).traces;
        const fixes = traces
          .filter(
            (t) =>
              typeof t.ts === "number" &&
              typeof t.summary === "string" &&
              // Only the trace types a human or recipe runner would write
              // as a remembered fix. Approval / enrichment traces are
              // structural plumbing, not fix decisions.
              (t.traceType === "decision" || t.traceType === "recipe_run"),
          )
          .slice(0, 3)
          .map((t) => ({
            ts: t.ts as number,
            summary: t.summary as string,
            tags: Array.isArray(t.tags)
              ? (t.tags as unknown[]).filter(
                  (x): x is string => typeof x === "string",
                )
              : undefined,
          }));
        setPriorFixes(fixes);
      })
      .catch(() => {
        setPriorFixes([]);
      });
    return () => controller.abort();
  }, [runFailed, recipeNameForTraces]);

  // Load plan lazily when tab is switched to "plan"
  useEffect(() => {
    if (tab !== "plan" || plan || planErr || !seq) return;
    const controller = new AbortController();
    const { signal } = controller;
    setPlanLoading(true);
    fetch(apiPath(`/api/bridge/runs/${seq}/plan`), { signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          // Capture status alongside the message so the UI can branch on
          // it without grepping the message text. Bridge returns 404 for
          // missing recipe/run (#605 typed code) — UI just needs the
          // status, not a brittle substring match.
          const err = new Error(body.error ?? `${res.status}`) as Error & {
            status?: number;
          };
          err.status = res.status;
          throw err;
        }
        const data = (await res.json()) as { plan?: DryRunPlan };
        if (!data.plan) throw new Error("empty response");
        setPlan(data.plan);
      })
      .catch((e: unknown) => {
        if (signal.aborted) return;
        const status = (e as { status?: number } | null)?.status;
        const msg = e instanceof Error ? e.message : String(e);
        setPlanErr(status === 404 ? "__not_found__" : msg);
      })
      .finally(() => setPlanLoading(false));
    return () => controller.abort();
  }, [tab, plan, planErr, seq]);

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: "6px 14px",
    fontSize: "var(--fs-s)",
    fontWeight: 500,
    cursor: "pointer",
    color: tab === t ? "var(--ink-1)" : "var(--ink-2)",
    background: "none",
    border: "none",
    borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
    transition: "color 0.12s, border-bottom-color 0.12s",
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
        <div style={{ flex: 1, minWidth: "min(200px, 100%)" }}>
          <div style={{ fontSize: "var(--fs-s)", marginBottom: 2 }}>
            <Link href="/runs" className="rd-breadcrumb-back">
              ← Runs
            </Link>
            {" / "}
            <span className="mono" style={{ color: "var(--ink-2)" }}>#{seq}</span>
          </div>
          <h1 style={{ margin: 0, fontSize: 22 }}>
            {run ? (
              <RecipeChip name={run.recipeName} variant="link" />
            ) : (
              <span style={{ color: "var(--ink-3)" }}>…</span>
            )}
          </h1>
          {/*
            "Feels connected" strip for the run detail. Runs are the
            canonical hub — they touch the recipe that defined them,
            the session that emitted events into them, and the activity
            firehose where their tool calls show up. Chips link out so
            a debugging user doesn't need to bounce through list pages.
            Recipe-name chip is conditional because run.recipeName can
            be undefined while loading.
          */}
          {run && (
            <RelationStrip
              items={[
                {
                  label: `Recipe: ${run.recipeName}`,
                  href: `/recipes/${encodeURIComponent(run.recipeName)}/edit`,
                  title: `Open the recipe that produced this run`,
                  tone: "accent",
                },
                {
                  label: "All runs",
                  href: `/runs?recipe=${encodeURIComponent(run.recipeName)}`,
                  title: `Other runs of ${run.recipeName}`,
                },
                // Surface the recipe Doctor from a failed run — deep-link
                // auto-runs the diagnosis (lint + policy + recent halts).
                ...(run.status === "error" ||
                (run.stepResults ?? []).some((s) => s.status === "error")
                  ? [
                      {
                        label: "Diagnose",
                        href: `/recipes/${encodeURIComponent(run.recipeName)}?diagnose=1#doctor`,
                        tone: "accent" as const,
                        title: `Run the Doctor on ${run.recipeName} — why it's failing + how to fix`,
                      },
                    ]
                  : []),
                {
                  label: "Activity",
                  href: "/activity",
                  title: "Events emitted across all recipes + sessions",
                },
                {
                  label: "Traces",
                  href: `/traces?recipe=${encodeURIComponent(run.recipeName)}`,
                  title: "Saved reasoning + enrichment for this recipe",
                },
                ...((run.stepResults ?? []).some((s) => s.haltReason)
                  ? [
                      {
                        label: "Halts",
                        href: `/runs?recipe=${encodeURIComponent(run.recipeName)}&halt=1`,
                        tone: "warn" as const,
                        title: "Other halted runs of this recipe",
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </div>
        {run && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="pill muted" style={{ fontSize: "var(--fs-xs)" }}>{run.trigger}</span>
            {(() => {
              // Honest partial-failure: a run can finish `done` while a step
              // errored. The bridge run log carries `hadStepErrors`; older
              // runs without the field fall back to scanning stepResults.
              const hadStepErrors =
                run.hadStepErrors ??
                (run.stepResults ?? []).some((s) => s.status === "error");
              const partialFail =
                run.status === "done" &&
                hadStepErrors &&
                !run.assertionFailures?.length;
              const cls = run.assertionFailures?.length
                ? "err"
                : partialFail
                  ? "warn"
                  : statusPillClass(run.status);
              return (
                <span
                  className={`pill ${cls}`}
                  style={{ fontSize: "var(--fs-xs)", display: "inline-flex", alignItems: "center", gap: 5 }}
                  title={
                    partialFail
                      ? "Run finished but one or more steps errored"
                      : undefined
                  }
                >
                  {run.status === "running" ? (
                    <span className="rd-step-running-indicator" style={{ width: 9, height: 9, borderWidth: 1.5 }} />
                  ) : (
                    <span className="pill-dot" />
                  )}
                  {partialFail ? "completed with errors" : run.status}
                </span>
              );
            })()}
            <span className="pill muted" style={{ fontSize: "var(--fs-xs)" }}>
              {fmtDur(run.durationMs)}
            </span>
            {run.model && (
              <span className="pill muted" style={{ fontSize: "var(--fs-xs)" }}>{run.model}</span>
            )}
            {run.assertionFailures && run.assertionFailures.length > 0 && (
              <span className="pill err" style={{ fontSize: "var(--fs-xs)" }}>
                {run.assertionFailures.length} assertion{run.assertionFailures.length !== 1 ? "s" : ""} failed
              </span>
            )}
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginLeft: 4 }}>
              {fmtTs(run.createdAt)}
            </span>
            {/* VD-4: replay button (mocked-only). Real replay TBD. */}
            {run.status !== "running" && (
              <button
                type="button"
                onClick={() => setReplayState("confirming")}
                disabled={replayState === "running"}
                title="Re-run the recipe with all tool/agent calls mocked from this run's captured outputs. No external IO, no side effects."
                style={{
                  fontSize: "var(--fs-xs)",
                  padding: "4px 10px",
                  borderRadius: "var(--r-1, 4px)",
                  border: "1px solid var(--line-2)",
                  background: "transparent",
                  color: "var(--ink-1)",
                  cursor: replayState === "running" ? "wait" : "pointer",
                }}
              >
                {replayState === "running" ? "Replaying…" : "Replay (mocked)"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Replay status banner */}
      {replayMessage && (
        <div
          role="status"
          className={`alert-${replayState === "error" ? "err" : "ok"}`}
          style={{ marginBottom: 12 }}
        >
          {replayMessage}
        </div>
      )}

      <Dialog
        open={replayState === "confirming"}
        onClose={() => setReplayState("idle")}
        ariaLabelledBy="replay-confirm-heading"
      >
        <h3 id="replay-confirm-heading" style={{ marginTop: 0, marginBottom: 8 }}>
          Replay this run?
        </h3>
        <p style={{ fontSize: "var(--fs-m)", color: "var(--ink-2)", margin: "0 0 12px" }}>
          Re-runs the recipe with each step&apos;s tool / agent call replaced by its
          captured output from this run. Templates, transforms, and
          <code className="mono"> when:</code> conditions re-evaluate against the
          new state — useful for verifying recipe edits without re-hitting
          connected services.
        </p>
        <ReplayPreflight stepResults={run?.stepResults ?? []} />
        <p style={{ fontSize: "var(--fs-s)", color: "var(--ink-3)", margin: "0 0 16px" }}>
          A new run will be created with{" "}
          <code className="mono">replay:{seq}</code> in its taskId.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={() => setReplayState("idle")}
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
            onClick={() => void handleReplay()}
            style={{
              padding: "6px 12px",
              borderRadius: "var(--r-1)",
              border: "1px solid var(--blue)",
              background: "var(--blue)",
              color: "var(--surface)",
              cursor: "pointer",
            }}
          >
            Replay (mocked)
          </button>
        </div>
      </Dialog>

      {runErr && <div className="alert-err">Failed to load run: {runErr}</div>}
      {!seqIsValid ? (
        <div className="empty-state">
          <h3>Invalid run id</h3>
          <p>
            <code>{seq}</code> isn&apos;t a numeric run sequence. Open a run
            from the <Link href="/runs">Runs</Link> list.
          </p>
        </div>
      ) : (
        !run && !runErr && <div className="empty-state" role="status"><p>Loading run…</p></div>
      )}

      {run && (
        <>
          {/* ── two-column layout: main content + related panel ── */}
          {/* On narrow viewports the grid stacks to a single column
              automatically via the minmax() column definition. */}
          {/* The RelatedPanel side rail is placed here at the top-level
              so it stays visible as the user scrolls the main content. */}
          {/* NOTE: The outer <> fragment is kept; the grid only wraps the
              two columns — the sticky header + replay banner live outside. */}
          {(() => {
            const relatedGroups: RelatedGroup[] = [
              {
                label: "Recipe",
                items: [
                  {
                    kind: "recipe",
                    id: run.recipeName,
                    label: run.recipeName,
                    href: `/recipes/${encodeURIComponent(run.recipeName)}`,
                    meta: run.trigger,
                  },
                ],
              },
              {
                label: "Inbox outputs",
                items: (run.inboxOutputs ?? []).map((out) => ({
                  kind: "inbox" as const,
                  id: out.filename,
                  label: out.filename,
                  meta: new Date(out.deliveredAt).toISOString().slice(0, 19).replace("T", " "),
                })),
              },
              {
                label: "Approvals",
                items: (run.stepResults ?? [])
                  .filter((s) => s.tool === "requestApproval" || s.id.startsWith("approval"))
                  .slice(0, 5)
                  .map((s) => ({
                    kind: "approval" as const,
                    id: s.id,
                    label: s.id,
                    meta: s.status,
                  })),
              },
              {
                label: "Traces",
                items: [
                  {
                    kind: "trace" as const,
                    id: run.recipeName,
                    label: run.recipeName,
                    href: `/traces?recipe=${encodeURIComponent(run.recipeName)}`,
                    meta: "decision traces",
                  },
                ],
              },
            ];
            return (
              <div className="rd-detail-layout">
                {/* ── main column ── */}
                <div style={{ minWidth: 0 }}>
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
              <CausalChainCard run={run} />

              {/* ── Timeline card ── */}
              {(() => {
                const events: TimelineEvent[] = [];
                // trigger event
                events.push({
                  id: `trigger-${run.seq}`,
                  kind: "trigger",
                  timestamp: run.createdAt,
                  label: `Triggered by: ${run.trigger}`,
                });
                // the run itself
                events.push({
                  id: `run-${run.seq}`,
                  kind: "run",
                  timestamp: run.startedAt ?? run.createdAt,
                  label: `Run #${run.seq} — ${run.status}`,
                  status: run.status,
                  meta: {
                    seq: run.seq,
                    recipeName: run.recipeName,
                    hadStepErrors: run.hadStepErrors,
                  },
                });
                // step events
                for (const step of run.stepResults ?? []) {
                  events.push({
                    id: `step-${run.seq}-${step.id}`,
                    kind: "step",
                    timestamp: step.startedAt ?? run.startedAt ?? run.createdAt,
                    label: step.tool ? `${step.tool} (${step.id})` : step.id,
                    status: step.status,
                    href: `#step-${step.id}`,
                  });
                }
                // inbox outputs
                for (const out of run.inboxOutputs ?? []) {
                  events.push({
                    id: `inbox-${run.seq}-${out.filename}`,
                    kind: "inbox",
                    timestamp: out.deliveredAt,
                    label: out.filename,
                    meta: { name: out.filename, recipeName: run.recipeName },
                  });
                }
                return (
                  <div className="card" style={{ marginBottom: 20, padding: 0, overflow: "hidden" }}>
                    <div
                      style={{
                        padding: "10px 16px",
                        borderBottom: "1px solid var(--border-subtle)",
                        fontSize: "var(--fs-s)",
                        fontWeight: 600,
                        color: "var(--ink-2)",
                      }}
                    >
                      Timeline
                    </div>
                    <div style={{ padding: "12px 16px" }}>
                      <EntityTimeline events={events} ariaLabel={`Timeline for run #${run.seq}`} />
                    </div>
                  </div>
                );
              })()}
              {run.inboxOutputs && run.inboxOutputs.length > 0 && (
                <div
                  className="card"
                  style={{
                    marginBottom: 20,
                    padding: "10px 16px",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: "var(--fs-xs)",
                      color: "var(--ink-3)",
                      fontWeight: 500,
                    }}
                  >
                    Delivered to inbox
                  </span>
                  {run.inboxOutputs.map((out) => (
                    <InboxChip
                      key={out.filename}
                      name={out.filename}
                      recipeName={run.recipeName}
                    />
                  ))}
                </div>
              )}
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
                    <span style={{ fontSize: "var(--fs-m)", fontWeight: 600 }}>
                      Steps ({run.stepResults.length})
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <button
                        type="button"
                        onClick={() =>
                          setStepsAllOpen((s) => (s === true ? null : true))
                        }
                        aria-pressed={stepsAllOpen === true}
                        title="Expand every step row"
                        style={{
                          background: "transparent",
                          border: "1px solid var(--line-2)",
                          borderRadius: 4,
                          fontSize: "var(--fs-2xs)",
                          padding: "3px 8px",
                          minHeight: 24,
                          cursor: "pointer",
                          color: stepsAllOpen === true ? "var(--accent)" : "var(--ink-3)",
                        }}
                      >
                        {stepsAllOpen === true ? "✓ Expanded" : "Expand all"}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setStepsAllOpen((s) => (s === false ? null : false))
                        }
                        aria-pressed={stepsAllOpen === false}
                        title="Collapse every step row"
                        style={{
                          background: "transparent",
                          border: "1px solid var(--line-2)",
                          borderRadius: 4,
                          fontSize: "var(--fs-2xs)",
                          padding: "3px 8px",
                          minHeight: 24,
                          cursor: "pointer",
                          color: stepsAllOpen === false ? "var(--accent)" : "var(--ink-3)",
                        }}
                      >
                        Collapse all
                      </button>
                      <span className="mono muted" style={{ fontSize: "var(--fs-xs)" }}>
                        total {fmtDur(run.durationMs)}
                      </span>
                    </div>
                  </div>
                  {run.stepResults.map((step, i) => (
                    <StepRow
                      key={step.id}
                      step={step}
                      index={i}
                      totalDurationMs={run.durationMs}
                      allSteps={run.stepResults ?? []}
                      recipeName={run.recipeName}
                      openOverride={stepsAllOpen}
                      onLocalToggle={() => setStepsAllOpen(null)}
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
                <span style={{ fontSize: "var(--fs-m)", fontWeight: 600 }}>Execution Plan</span>
                <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>
                  re-generated from current registry
                </span>
              </div>
              {planLoading && (
                <div style={{ padding: 20, color: "var(--ink-2)", fontSize: "var(--fs-m)" }}>Generating…</div>
              )}
              {planErr && (
                <div className="alert-err" style={{ margin: 16 }}>
                  {planErr === "__not_found__"
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
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: "var(--fs-2xs)", color: "var(--ink-2)", marginBottom: 2 }}>TASK ID</div>
                <CopyableMono value={run.taskId} ariaLabel="Copy task id" />
              </div>
              <div>
                <div style={{ fontSize: "var(--fs-2xs)", color: "var(--ink-2)", marginBottom: 2 }}>STARTED</div>
                <span className="mono" style={{ fontSize: "var(--fs-s)" }}>
                  {run.startedAt ? fmtTs(run.startedAt) : "—"}
                </span>
              </div>
              <div>
                <div style={{ fontSize: "var(--fs-2xs)", color: "var(--ink-2)", marginBottom: 2 }}>FINISHED</div>
                <span className="mono" style={{ fontSize: "var(--fs-s)" }}>{fmtTs(run.doneAt)}</span>
              </div>
              {run.model && (
                <div>
                  <div style={{ fontSize: "var(--fs-2xs)", color: "var(--ink-2)", marginBottom: 2 }}>MODEL</div>
                  <span className="mono" style={{ fontSize: "var(--fs-s)" }}>{run.model}</span>
                </div>
              )}
              {run.manualRunId && (
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "var(--fs-2xs)", color: "var(--ink-2)", marginBottom: 2 }}>ATTEMPT</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <CopyableMono value={run.manualRunId} ariaLabel="Copy attempt id" />
                    <Link
                      href={`/runs?attempt=${encodeURIComponent(run.manualRunId)}`}
                      title="Show all runs sharing this attempt id"
                      style={{
                        fontSize: "var(--fs-2xs)",
                        color: "var(--ink-3)",
                        textDecoration: "none",
                        border: "1px solid var(--line-2)",
                        borderRadius: 4,
                        padding: "2px 6px",
                        minHeight: 24,
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      see all →
                    </Link>
                  </div>
                </div>
              )}
            </div>
            {run.errorMessage && (
              <div
                className="rd-error-card"
                style={{
                  marginTop: 12,
                  padding: "12px 14px",
                  borderRadius: "var(--radius)",
                  borderLeft: "4px solid var(--err) !important",
                }}
              >
                <div style={{
                  fontSize: "var(--fs-xs)",
                  color: "var(--err)",
                  fontWeight: 600,
                  marginBottom: 6,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}>
                  <span style={{ fontSize: "1em" }}>⚠</span> ERROR
                </div>
                <TruncatablePre text={run.errorMessage} color="var(--err)" />
              </div>
            )}
            {/* Phase 1A item 8 — prior fix decisions for this recipe. */}
            {priorFixes.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div
                  style={{
                    fontSize: "var(--fs-2xs)",
                    color: "var(--ink-2)",
                    marginBottom: 4,
                  }}
                >
                  PRIOR FIXES FOR {run.recipeName.toUpperCase()}{" "}
                  <Link
                    href={`/traces?recipe=${encodeURIComponent(run.recipeName)}`}
                    style={{
                      color: "var(--info)",
                      textDecoration: "none",
                      marginLeft: 6,
                    }}
                  >
                    see all →
                  </Link>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    fontSize: "var(--fs-s)",
                  }}
                >
                  {priorFixes.map((fix, i) => (
                    <div
                      key={`fix-${fix.ts}-${i}`}
                      style={{
                        padding: "var(--s-2) var(--s-3)",
                        background: "var(--recess)",
                        border: "1px solid var(--line-2)",
                        borderRadius: "var(--r-2)",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "var(--fs-2xs)",
                          color: "var(--ink-2)",
                          marginBottom: 2,
                        }}
                      >
                        {new Date(fix.ts).toLocaleString()}
                        {fix.tags && fix.tags.length > 0 && (
                          <span style={{ marginLeft: 8 }}>
                            {fix.tags.map((t) => `#${t}`).join(" ")}
                          </span>
                        )}
                      </div>
                      <div>{fix.summary}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {run.outputTail && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: "var(--fs-2xs)", color: "var(--ink-2)", marginBottom: 4 }}>OUTPUT TAIL</div>
                <TruncatablePre text={run.outputTail} className="task-output" maxLines={20} />
              </div>
            )}
          </div>
                </div>{/* end main column */}

                {/* ── related panel column ── */}
                <aside className="rd-related-aside">
                  <RelatedPanel groups={relatedGroups} />
                </aside>
              </div>
            );
          })()}
        </>
      )}
    </section>
  );
}
