"use client";

/**
 * Recipe detail hub — Overview tab.
 *
 * Lands when the user clicks a row on `/recipes`. Surfaces:
 *  - Summary card (trigger, schedule, last-run outcome, success rate, avg duration)
 *  - Recent runs (last 5-10, RunChip rows; "View all runs" link)
 *  - Halt summary (categorised; "View halts" link) — only when halts exist
 *  - Connectors required (ConnectorChip + health dot)
 *  - Latest inbox output (when bridge surfaces `inboxOutputs`; PR #742+)
 *  - Controls: Run now, Enable/Disable, Edit, Plan, Compare, Uninstall
 *
 * The shared `layout.tsx` owns the breadcrumb, H1, status pill, RelationStrip,
 * and tab bar — this file is just the body.
 */

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DoctorPanel } from "./_components/DoctorPanel";
import RecipeEditPage from "./_edit/page";
import RecipePlanPage from "./_plan/page";
import { useRouter } from "next/navigation";
import { apiPath } from "@/lib/api";
import { canonicalRecipeKey, inboxItemKey } from "@/lib/entityKey";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { useToast } from "@/components/Toast";
import { Dialog } from "@/components/Dialog";
import {
  ConnectorChip,
  EmptyState,
  EntityTimeline,
  InboxChip,
  PatchCard,
  RelatedPanel,
  RunChip,
  StatusPill,
} from "@/components/patchwork";
import type { TimelineEvent, RelatedGroup } from "@/components/patchwork";
import { detectConnectorsForRecipe } from "@/lib/recipeConnectors";
import { fmtDuration } from "@/components/time";

interface RecipeVar {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

interface Recipe {
  name: string;
  description?: string;
  version?: string;
  trigger?: string;
  schedule?: string;
  webhookPath?: string;
  stepCount?: number;
  enabled?: boolean;
  vars?: RecipeVar[];
  path?: string;
}

interface RunRecord {
  seq?: number;
  recipe: string;
  recipeName?: string;
  startedAt: number;
  status: string;
  durationMs?: number;
  hadStepErrors?: boolean;
  inboxOutputs?: Array<{ filename: string; deliveredAt: number }>;
}

type HaltCategory =
  | "agent_silent_fail"
  | "agent_narration_only"
  | "agent_threw"
  | "tool_threw"
  | "tool_error"
  | "kill_switch"
  | "budget_exceeded"
  | "expect_failed"
  | "step_timeout"
  | "auth_failure"
  | "rate_limited"
  | "network_error"
  | "missing_connector"
  | "run_level"
  | "unknown";

interface HaltSummary {
  total: number;
  byCategory: Partial<Record<HaltCategory, number>>;
  recent: Array<{ reason: string; category: HaltCategory; runSeq: number }>;
}

interface ConnectorStatus {
  id: string;
  /** `healthy` is currently null for every connector (bridge doesn't
   *  populate it). Use `status` for the positive signal — see Phase 1A.1
   *  dogfood note in the edit page. */
  healthy?: boolean;
  status?: "connected" | "disconnected" | "needs_reauth";
}

const HALT_CATEGORY_LABEL: Record<HaltCategory, string> = {
  agent_silent_fail: "agent silent-fail",
  agent_narration_only: "agent narration-only",
  agent_threw: "agent threw",
  tool_threw: "tool threw",
  tool_error: "tool error",
  kill_switch: "kill switch",
  budget_exceeded: "budget exceeded",
  expect_failed: "expect failed",
  step_timeout: "step timeout",
  auth_failure: "auth failure",
  rate_limited: "rate limited",
  network_error: "network error",
  missing_connector: "missing connector",
  run_level: "run-level",
  unknown: "unknown",
};

// Mirrors /runs page — one-line actionable hint per category.
const HALT_CATEGORY_HINT: Record<HaltCategory, string> = {
  agent_silent_fail: "Agent finished without producing usable output. Inspect prompt + check the trace.",
  agent_narration_only: "Agent narrated but didn't produce structured output — tighten the prompt or add an into: target.",
  agent_threw: "Agent step threw before completing. Open the run trace.",
  tool_threw: "Tool threw an unhandled exception. Check the inner error in the trace.",
  tool_error: "Tool returned an error response. Check the inner error in the trace.",
  kill_switch: "Write blocked by the kill-switch. Run `patchwork kill-switch release` to re-enable.",
  budget_exceeded: "Run exceeded its tokensMax budget. Raise tokensMax in the recipe or shrink prompts.",
  expect_failed: "A step's expect: assertion didn't match. Inspect the assertion + actual output.",
  step_timeout: "Step exceeded its timeout_ms. Bump the timeout or speed up the step.",
  auth_failure: "Connector token expired or scopes insufficient. Reconnect from /connections.",
  rate_limited: "External service rate-limited the request. Back off the cron cadence or wait and retry.",
  network_error: "Transport-level failure (DNS, refused, timeout). Check connectivity to the upstream service.",
  missing_connector: "Recipe references a connector that isn't configured. Install/connect from /connections.",
  run_level: "Whole-recipe failure (no step ran). Check the recipe for circular deps / parse errors.",
  unknown: "Uncategorised halt. Open the run trace for the raw error.",
};

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || ms <= 0) return "—";
  return fmtDuration(ms);
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontSize: "var(--fs-s)",
        fontWeight: 600,
        color: "var(--ink-2)",
        margin: "0 0 14px",
        letterSpacing: "0.01em",
      }}
    >
      {children}
    </h2>
  );
}

function RunModal({
  open,
  recipe,
  onClose,
  onConfirm,
  running,
}: {
  open: boolean;
  recipe: Recipe | null;
  onClose: () => void;
  onConfirm: (vars: Record<string, string>) => void;
  running: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open || !recipe) return;
    const init: Record<string, string> = {};
    for (const v of recipe.vars ?? []) init[v.name] = v.default ?? "";
    setValues(init);
  }, [open, recipe]);
  const vars = recipe?.vars ?? [];
  return (
    <Dialog open={open} onClose={onClose} ariaLabelledBy="hub-run-modal-title" maxWidth={480}>
      {recipe && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--s-4)" }}>
            <h2 id="hub-run-modal-title" style={{ margin: 0, fontSize: "var(--fs-xl)", fontWeight: 600 }}>
              Run <code>{recipe.name}</code>
            </h2>
            <button type="button" className="btn sm ghost" onClick={onClose} aria-label="Close">×</button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onConfirm(values);
            }}
          >
            {vars.length === 0 && (
              <div
                style={{
                  marginBottom: "var(--s-4)",
                  padding: "var(--s-3) var(--s-4)",
                  border: "1px solid var(--line-2)",
                  borderRadius: "var(--r-1)",
                  background: "var(--bg-2)",
                  fontSize: "var(--fs-m)",
                  color: "var(--ink-2)",
                }}
              >
                Running this recipe will execute its steps immediately and may use API credits or
                call external services.
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
              {vars.map((v) => (
                <div key={v.name}>
                  <label
                    htmlFor={`hub-run-${v.name}`}
                    style={{
                      display: "block",
                      marginBottom: 4,
                      fontSize: "var(--fs-m)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {v.name}
                    {v.required && <span style={{ color: "var(--err)", marginLeft: 4 }}>*</span>}
                  </label>
                  {v.description && (
                    <div style={{ fontSize: "var(--fs-s)", color: "var(--ink-3)", marginBottom: 4 }}>
                      {v.description}
                    </div>
                  )}
                  <input
                    id={`hub-run-${v.name}`}
                    type="text"
                    required={v.required}
                    value={values[v.name] ?? ""}
                    onChange={(e) => setValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
                    className="input"
                    style={{ width: "100%" }}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: "var(--s-3)", marginTop: "var(--s-5)", justifyContent: "flex-end" }}>
              <button type="button" className="btn ghost" onClick={onClose} disabled={running}>
                Cancel
              </button>
              <button type="submit" className="btn warn" disabled={running}>
                {running ? "Starting…" : "Run recipe"}
              </button>
            </div>
          </form>
        </>
      )}
    </Dialog>
  );
}

function RecipeHubOverviewPage({ name }: { name: string }) {
  const toast = useToast();
  const router = useRouter();

  // Reusable list fetch for the recipe row (matches layout's data source).
  const { data: recipes, refetch: refetchRecipes } = useBridgeFetch<Recipe[]>(
    "/api/bridge/recipes",
    {
      intervalMs: 30_000,
      transform: (raw) => {
        if (Array.isArray(raw)) return raw as Recipe[];
        const obj = raw as { recipes?: Recipe[] };
        return obj?.recipes ?? [];
      },
    },
  );
  const recipe = useMemo(
    () => recipes?.find((r) => canonicalRecipeKey(r.name) === name) ?? null,
    [recipes, name],
  );

  // Runs filtered by recipe — bridge supports ?recipe= filter.
  // intervalMs is adaptive: poll at 3s when any run is in-flight, 10s otherwise.
  const [runsIntervalMs, setRunsIntervalMs] = useState(10_000);
  const { data: runsResp, refetch: refetchRuns } = useBridgeFetch<{ runs: RunRecord[] }>(
    `/api/bridge/runs?recipe=${encodeURIComponent(name)}&limit=50`,
    { intervalMs: runsIntervalMs },
  );
  const runs: RunRecord[] = useMemo(() => {
    const raw = runsResp?.runs ?? [];
    // Client-side guard in case the bridge ignores the param.
    return raw
      .filter((r) => canonicalRecipeKey(r.recipeName ?? r.recipe ?? "") === name)
      .sort((a, b) => b.startedAt - a.startedAt);
  }, [runsResp, name]);

  // Adaptive polling interval: 3s while any run is in-flight, 10s when idle.
  // We update via setState only when the value needs to change to avoid loops.
  const prevInFlightRef = useRef<boolean | null>(null);
  useEffect(() => {
    const IN_FLIGHT_STATUSES = new Set(["running", "queued", "pending"]);
    const hasInFlight = runs.some((r) => IN_FLIGHT_STATUSES.has(r.status));
    if (prevInFlightRef.current === hasInFlight) return; // stable, no-op
    prevInFlightRef.current = hasInFlight;
    setRunsIntervalMs(hasInFlight ? 3_000 : 10_000);
  }, [runs]);

  // Toast once when a newly-completed run with inbox output is detected.
  // -1 = "not yet initialised" (skip toasting until we've seen the initial data).
  const lastSeenCompletedSeqRef = useRef<number>(-1);
  useEffect(() => {
    if (runs.length === 0) return;
    const highestSeq = runs.reduce<number>((m, r) => (typeof r.seq === "number" && r.seq > m ? r.seq : m), -1);
    // First render: mark existing runs as already-seen so we don't spam toasts on load.
    if (lastSeenCompletedSeqRef.current === -1) {
      lastSeenCompletedSeqRef.current = highestSeq;
      return;
    }
    const DONE_STATUSES = new Set(["done", "success"]);
    // Find completed runs newer than last-seen that produced inbox output.
    for (const r of runs) {
      if (typeof r.seq !== "number") continue;
      if (r.seq <= lastSeenCompletedSeqRef.current) break; // already seen (runs sorted desc)
      if (DONE_STATUSES.has(r.status) && Array.isArray(r.inboxOutputs) && r.inboxOutputs.length > 0) {
        const output = [...r.inboxOutputs].sort((a, b) => b.deliveredAt - a.deliveredAt)[0];
        const key = inboxItemKey(output.filename);
        toast.success("Output delivered to inbox", {
          action: {
            label: "View in inbox",
            onClick: () => router.push(`/inbox?item=${encodeURIComponent(key)}`),
          },
        });
        break; // toast at most once per poll cycle
      }
    }
    lastSeenCompletedSeqRef.current = highestSeq;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  // Halt summary filtered by recipe.
  const { data: haltSummary } = useBridgeFetch<HaltSummary>(
    `/api/bridge/runs/halt-summary?recipe=${encodeURIComponent(name)}`,
    { intervalMs: 30_000 },
  );

  // Connector health — best-effort.
  const { data: connectorStatuses } = useBridgeFetch<ConnectorStatus[]>(
    "/api/bridge/connectors/status",
    {
      intervalMs: 60_000,
      transform: (raw) => {
        if (Array.isArray(raw)) return raw as ConnectorStatus[];
        const obj = raw as { connectors?: ConnectorStatus[] };
        return obj?.connectors ?? [];
      },
    },
  );

  const requiredConnectors = useMemo(
    () => (recipe ? detectConnectorsForRecipe(recipe) : []),
    [recipe],
  );

  const connectorHealthMap = useMemo(() => {
    // Phase 1A.1: derive health from `status` (which is populated)
    // rather than `healthy` (which is always null on the bridge today).
    // `needs_reauth` and `disconnected` both register as not-healthy.
    const m = new Map<string, boolean | undefined>();
    for (const c of connectorStatuses ?? []) {
      m.set(c.id, c.status === "connected");
    }
    return m;
  }, [connectorStatuses]);

  // Derived run metrics.
  const lastRun = runs[0];
  const recentRuns = runs.slice(0, 10);
  const successPct = useMemo(() => {
    const settled = runs.filter(
      (r) => r.status !== "running" && r.status !== "queued" && r.status !== "pending",
    );
    if (settled.length === 0) return null;
    const ok = settled.filter((r) => r.status === "done" || r.status === "success").length;
    return (ok / settled.length) * 100;
  }, [runs]);
  const avgDurationMs = useMemo(() => {
    const ds = runs.map((r) => r.durationMs).filter((d): d is number => typeof d === "number" && d > 0);
    if (ds.length === 0) return undefined;
    return ds.reduce((s, d) => s + d, 0) / ds.length;
  }, [runs]);

  // Latest inbox output — PR #742 attaches inboxOutputs to RecipeRun.
  const latestInboxOutput = useMemo(() => {
    for (const r of runs) {
      if (Array.isArray(r.inboxOutputs) && r.inboxOutputs.length > 0) {
        const sorted = [...r.inboxOutputs].sort((a, b) => b.deliveredAt - a.deliveredAt);
        return sorted[0];
      }
    }
    return null;
  }, [runs]);

  // Controls state.
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [runStarting, setRunStarting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const handleRunConfirm = useCallback(
    async (vars: Record<string, string>) => {
      if (!recipe) return;
      setRunStarting(true);
      try {
        const body: Record<string, unknown> = {};
        if (Object.keys(vars).length > 0) body.vars = vars;
        const res = await fetch(
          apiPath(`/api/bridge/recipes/${encodeURIComponent(recipe.name)}/run`),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const data = (await res.json()) as { ok: boolean; taskId?: string; seq?: number; error?: string };
        if (data.ok) {
          const runHref = typeof data.seq === "number"
            ? `/runs/${data.seq}`
            : `/runs?recipe=${encodeURIComponent(recipe.name)}`;
          toast.success("Run started", {
            action: { label: "View run", onClick: () => router.push(runHref) },
          });
          setRunModalOpen(false);
          refetchRuns();
          refetchRecipes();
        } else {
          toast.error(`Run failed: ${data.error ?? "unknown"}`);
        }
      } catch (e) {
        toast.error(`Run failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setRunStarting(false);
      }
    },
    [recipe, toast, router, refetchRuns, refetchRecipes],
  );

  const handleToggle = useCallback(async () => {
    if (!recipe || toggling) return;
    const target = recipe.enabled === false;
    const trigger = recipe.trigger ?? "manual";
    if (!target && trigger !== "manual") {
      const proceed = window.confirm(
        `Disable "${recipe.name}"? Trigger "${trigger}" will stop firing until you re-enable.`,
      );
      if (!proceed) return;
    }
    setToggling(true);
    try {
      const res = await fetch(
        apiPath(`/api/bridge/recipes/${encodeURIComponent(recipe.name)}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: target }),
        },
      );
      if (!res.ok) throw new Error(`PATCH /recipes ${res.status}`);
      toast.success(target ? "Enabled" : "Disabled");
      refetchRecipes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
    }
  }, [recipe, toggling, toast, refetchRecipes]);

  const handleUninstall = useCallback(async () => {
    if (!recipe) return;
    const proceed = window.confirm(
      `Permanently delete "${recipe.name}"? This removes the YAML file. Cannot be undone.`,
    );
    if (!proceed) return;
    try {
      const res = await fetch(
        apiPath(`/api/bridge/recipes/${encodeURIComponent(recipe.name)}`),
        { method: "DELETE" },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        toast.error(`Delete failed: ${text || res.status}`);
        return;
      }
      toast.success(`Deleted ${recipe.name}`);
      router.push("/recipes");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [recipe, router, toast]);

  const scheduleString = useMemo(() => {
    if (!recipe) return "—";
    const trig = recipe.trigger ?? "manual";
    if (trig === "cron" || trig === "schedule") return recipe.schedule ?? "cron (unknown)";
    if (trig === "webhook") return recipe.webhookPath ?? "webhook";
    return trig;
  }, [recipe]);

  const lastRunDerived = useMemo(() => {
    if (!lastRun) return null;
    const finished = lastRun.status === "done" || lastRun.status === "success";
    const partialFail = finished && lastRun.hadStepErrors;
    const ok = finished && !lastRun.hadStepErrors;
    const fail = lastRun.status === "error" || lastRun.status === "failed";
    const tone: "ok" | "warn" | "err" | "info" | "muted" = ok
      ? "ok"
      : partialFail
        ? "warn"
        : fail
          ? "err"
          : lastRun.status === "running"
            ? "info"
            : "warn";
    const label = partialFail ? "completed with errors" : lastRun.status;
    return { tone, label, when: relTime(lastRun.startedAt) };
  }, [lastRun]);

  if (recipes && !recipe) {
    return (
      <EmptyState
        title="Recipe not found"
        description={`No recipe named "${name}" is installed.`}
        action={
          <Link href="/recipes" className="btn primary" style={{ textDecoration: "none" }}>
            Back to recipes
          </Link>
        }
      />
    );
  }

  // Build groups for the related panel from data already loaded on this page.
  const relatedGroups: RelatedGroup[] = [
    {
      label: "Recent runs",
      items: recentRuns.slice(0, 5).map((r) => ({
        kind: "run" as const,
        id: String(r.seq ?? ""),
        label: typeof r.seq === "number" ? `#${r.seq}` : r.status,
        meta: r.durationMs ? formatDuration(r.durationMs) : relTime(r.startedAt),
      })).filter((item) => item.id !== ""),
    },
    {
      label: "Connectors",
      items: requiredConnectors.map((id) => ({
        kind: "connector" as const,
        id,
        label: id,
        meta: connectorHealthMap.get(id) === true
          ? "healthy"
          : connectorHealthMap.get(id) === false
            ? "unhealthy"
            : undefined,
      })),
    },
    {
      label: "Latest inbox",
      items: latestInboxOutput
        ? [
            {
              kind: "inbox" as const,
              id: latestInboxOutput.filename,
              label: latestInboxOutput.filename,
              meta: relTime(latestInboxOutput.deliveredAt),
            },
          ]
        : [],
    },
  ];

  return (
    <div className="recipe-hub-layout">
      {/* main column */}
      <div className="recipe-hub-main" style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)", minWidth: 0 }}>
      <RunModal
        open={runModalOpen}
        recipe={recipe}
        onClose={() => setRunModalOpen(false)}
        onConfirm={handleRunConfirm}
        running={runStarting}
      />

      {/* SUMMARY */}
      <PatchCard className="hub-card" style={{ padding: "var(--s-4)", animationDelay: "0ms", animation: "hubCardIn 200ms ease both" }}>
        <SectionHeader>Summary</SectionHeader>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: "var(--s-4)",
            fontSize: "var(--fs-s)",
          }}
        >
          <div>
            <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-xs)" }}>Trigger</div>
            <div className="stat-value" style={{ fontFamily: "var(--font-mono)", marginTop: 6 }}>{recipe?.trigger ?? "manual"}</div>
          </div>
          <div>
            <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-xs)" }}>Schedule</div>
            <div className="stat-value" style={{ fontFamily: "var(--font-mono)", marginTop: 6 }}>{scheduleString}</div>
          </div>
          <div>
            <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-xs)" }}>Last run</div>
            <div className="stat-value" style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
              {lastRunDerived ? (
                <>
                  <StatusPill tone={lastRunDerived.tone}>{lastRunDerived.label}</StatusPill>
                  <span style={{ color: "var(--ink-3)" }}>{lastRunDerived.when}</span>
                </>
              ) : (
                <span style={{ color: "var(--ink-3)" }}>never</span>
              )}
            </div>
          </div>
          <div>
            <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-xs)" }}>Success rate</div>
            <div className="stat-value" style={{ fontFamily: "var(--font-mono)", marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
              {successPct == null ? "—" : `${successPct.toFixed(0)}%`}
              {runs.length > 0 && (
                <span style={{ color: "var(--ink-3)", marginLeft: 4, fontSize: "var(--fs-xs)" }}>
                  over {runs.length}
                </span>
              )}
            </div>
          </div>
          <div>
            <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-xs)" }}>Avg duration</div>
            <div className="stat-value" style={{ fontFamily: "var(--font-mono)", marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
              {formatDuration(avgDurationMs)}
            </div>
          </div>
        </div>
      </PatchCard>

      {/* RECENT RUNS */}
      <PatchCard className="hub-card" style={{ padding: "var(--s-4)", animation: "hubCardIn 220ms 40ms ease both", animationFillMode: "both" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <SectionHeader>Recent runs</SectionHeader>
          <Link
            href={`/runs?recipe=${encodeURIComponent(name)}`}
            style={{ fontSize: "var(--fs-xs)", color: "var(--accent)", textDecoration: "none" }}
          >
            View all runs →
          </Link>
        </div>
        {recentRuns.length === 0 ? (
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            padding: "24px 0",
            color: "var(--ink-3)",
            fontSize: "var(--fs-s)",
            textAlign: "center",
          }}>
            <span style={{ fontSize: 24, opacity: 0.4 }}>▷</span>
            No runs yet. Use <strong style={{ color: "var(--ink-2)" }}>Run now</strong> below to start one.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {recentRuns.map((r, i) => (
              <div
                key={`${r.seq ?? r.startedAt}-${i}`}
                className="hub-run-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: "var(--fs-xs)",
                  padding: "9px 4px",
                  borderBottom: i < recentRuns.length - 1 ? "1px solid var(--line-1)" : undefined,
                  animationDelay: `${i * 40}ms`,
                  borderRadius: 4,
                }}
              >
                {typeof r.seq === "number" ? (
                  <RunChip seq={r.seq} status={r.status} hadStepErrors={r.hadStepErrors} variant="row" />
                ) : (
                  <span style={{ fontFamily: "var(--font-mono)" }}>{r.status}</span>
                )}
                <span style={{ flex: 1, color: "var(--ink-3)" }}>{relTime(r.startedAt)}</span>
                {Array.isArray(r.inboxOutputs) && r.inboxOutputs.length > 0 && (
                  <Link
                    href={`/inbox?item=${encodeURIComponent(inboxItemKey(r.inboxOutputs[0].filename))}`}
                    title="View inbox output"
                    style={{
                      fontSize: "var(--fs-xs)",
                      color: "var(--accent)",
                      textDecoration: "none",
                    }}
                  >
                    → inbox
                  </Link>
                )}
                <span style={{ color: "var(--ink-2)", fontFamily: "var(--font-mono)" }}>
                  {formatDuration(r.durationMs)}
                </span>
              </div>
            ))}
          </div>
        )}
      </PatchCard>

      {/* HALT SUMMARY */}
      {haltSummary && haltSummary.total > 0 && (
        <PatchCard className="hub-card" style={{ padding: "var(--s-4)", animation: "hubCardIn 240ms 80ms ease both", animationFillMode: "both" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <SectionHeader>Halts</SectionHeader>
            <Link
              href={`/runs?recipe=${encodeURIComponent(name)}&halt=1`}
              style={{ fontSize: "var(--fs-xs)", color: "var(--accent)", textDecoration: "none" }}
            >
              View halts →
            </Link>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {(Object.entries(haltSummary.byCategory) as Array<[HaltCategory, number]>).map(
              ([cat, count], idx) => (
                <div
                  key={cat}
                  className="halt-badge"
                  title={HALT_CATEGORY_HINT[cat] ?? "Uncategorised halt."}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 10px",
                    borderRadius: 999,
                    background: "color-mix(in srgb, var(--amber) 8%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--amber) 35%, transparent)",
                    fontSize: "var(--fs-xs)",
                    color: "var(--amber)",
                    cursor: "help",
                    animationDelay: `${idx * 40}ms`,
                  }}
                >
                  <span style={{ fontFamily: "var(--font-mono)" }}>
                    {HALT_CATEGORY_LABEL[cat] ?? cat}
                  </span>
                  <span style={{ fontWeight: 600 }}>{count}</span>
                </div>
              ),
            )}
          </div>
        </PatchCard>
      )}

      {/* CONNECTORS */}
      {requiredConnectors.length > 0 && (
        <PatchCard className="hub-card" style={{ padding: "var(--s-4)", animation: "hubCardIn 240ms 100ms ease both", animationFillMode: "both" }}>
          <SectionHeader>Connectors required</SectionHeader>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {requiredConnectors.map((id) => (
              <ConnectorChip key={id} id={id} healthy={connectorHealthMap.get(id)} />
            ))}
          </div>
        </PatchCard>
      )}

      {/* LATEST INBOX OUTPUT */}
      {latestInboxOutput && (
        <PatchCard className="hub-card" style={{ padding: "var(--s-4)", animation: "hubCardIn 240ms 120ms ease both", animationFillMode: "both" }}>
          <SectionHeader>Latest output → Inbox</SectionHeader>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-s)" }}>
            <InboxChip name={latestInboxOutput.filename} recipeName={name} />
            <span style={{ color: "var(--ink-3)", fontSize: "var(--fs-xs)" }}>
              delivered {relTime(latestInboxOutput.deliveredAt)}
            </span>
            <Link
              href={`/inbox?item=${encodeURIComponent(inboxItemKey(latestInboxOutput.filename))}`}
              style={{ fontSize: "var(--fs-xs)", color: "var(--accent)", textDecoration: "none", marginLeft: "auto" }}
            >
              View in inbox →
            </Link>
          </div>
        </PatchCard>
      )}

      {/* CONTROLS */}
      <PatchCard className="hub-card" style={{ padding: "var(--s-4)", animation: "hubCardIn 260ms 140ms ease both", animationFillMode: "both" }}>
        <SectionHeader>Controls</SectionHeader>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-3)" }}>
          <button
            type="button"
            className="btn primary hub-control-btn"
            onClick={() => setRunModalOpen(true)}
            disabled={!recipe || recipe.enabled === false}
            title="Execute this recipe now"
          >
            ▶ Run now
          </button>
          <button
            type="button"
            className="btn ghost hub-control-btn"
            onClick={() => void handleToggle()}
            disabled={!recipe || toggling}
            aria-pressed={recipe?.enabled !== false}
          >
            {toggling ? (recipe?.enabled === false ? "Enabling…" : "Disabling…") : (recipe?.enabled === false ? "Enable" : "Disable")}
          </button>
          <Link
            href={`/recipes/${encodeURIComponent(name)}/edit`}
            className="btn ghost hub-control-btn"
            style={{ textDecoration: "none" }}
          >
            Edit
          </Link>
          <Link
            href={`/recipes/${encodeURIComponent(name)}/plan`}
            className="btn ghost hub-control-btn"
            style={{ textDecoration: "none" }}
          >
            Plan
          </Link>
          <Link
            href={`/recipes/compare?name=${encodeURIComponent(name)}`}
            className="btn ghost hub-control-btn"
            style={{ textDecoration: "none" }}
          >
            Compare versions
          </Link>
          <button
            type="button"
            className="btn ghost hub-control-btn"
            style={{ color: "var(--err)", marginLeft: "auto" }}
            onClick={() => void handleUninstall()}
            disabled={!recipe}
          >
            Uninstall
          </button>
        </div>
      </PatchCard>

      {/* DOCTOR — composed health diagnosis (lint + policy + recent halts) */}
      <PatchCard className="hub-card" style={{ padding: "var(--s-4)", animation: "hubCardIn 260ms 160ms ease both", animationFillMode: "both" }}>
        <SectionHeader>Doctor</SectionHeader>
        <DoctorPanel recipeName={name} />
      </PatchCard>
      </div>{/* end main column */}

      {/* related panel column */}
      <aside
        style={{
          position: "sticky",
          top: 80,
          padding: "var(--s-4, 16px)",
          background: "var(--bg-1)",
          borderRadius: "var(--r-2, 8px)",
          border: "1px solid var(--line-2)",
          minWidth: 0,
        }}
      >
        <RelatedPanel groups={relatedGroups} />
      </aside>
    </div>
  );
}

export default function RecipePage({
  params,
}: {
  params: Promise<{ name: string[] }>;
}) {
  const { name: rawNameParts } = use(params);
  const last = rawNameParts[rawNameParts.length - 1];

  if (last === "edit") {
    const recipeName = decodeURIComponent(rawNameParts.slice(0, -1).join("/"));
    return <RecipeEditPage name={recipeName} />;
  }
  if (last === "plan") {
    const recipeName = decodeURIComponent(rawNameParts.slice(0, -1).join("/"));
    return <RecipePlanPage name={recipeName} />;
  }

  const recipeName = canonicalRecipeKey(decodeURIComponent(rawNameParts.join("/")));
  return <RecipeHubOverviewPage name={recipeName} />;
}
