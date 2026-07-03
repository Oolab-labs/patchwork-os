"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { bandSeverity, buildAttentionItems } from "@/lib/attention";
import { recipeDisplayName } from "@/lib/recipeDisplay";
import { FirstRunChecklist } from "@/components/FirstRunChecklist";
import { StatCard } from "@/components/StatCard";
import { SkeletonStatCard } from "@/components/Skeleton";
import { relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { useBridgeStatus } from "@/hooks/useBridgeStatus";
import { isNoiseEvent } from "@/lib/activityNoise";
import { isHaltStatus } from "@/lib/runStatus";
import {
  AnimatedNumber,
  RunSparkBars,
  Sparkline,
} from "@/components/patchwork";
import { canonicalRecipeKey } from "@/lib/entityKey";
import {
  RecipeLeaderboard,
  type LeaderboardRun,
} from "@/components/RecipeLeaderboard";
import { LiveRunsStrip, type LiveRun } from "@/components/LiveRunsStrip";
import { LiveWire } from "@/components/LiveWire";
import { useRunRecipe } from "@/hooks/useRunRecipe";

// ---------------------------------------------------------------------------
// Keyframe injection — scoped to this page, no globals.css edits needed.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  total: number;
  messages: number;
}

interface BridgeHealth {
  status: string;
  uptimeMs: number;
  connections: number;
  extensionConnected: boolean;
  extensionVersion: string | null;
  activeSessions: number;
  tokens?: TokenTotals;
}

interface Pending {
  callId: string;
  toolName: string;
  tier: "low" | "medium" | "high";
  requestedAt: number;
  summary?: string;
}

interface Recipe {
  id?: string;
  name: string;
  enabled?: boolean;
  lastRun?: number;
  installedAt?: number;
}

interface ActivityEvent {
  kind: string;
  tool?: string;
  status?: "success" | "error";
  durationMs?: number;
  errorMessage?: string;
  timestamp?: string;
  at?: number;
  id?: number;
  event?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withAt(e: ActivityEvent): ActivityEvent {
  if (typeof e.at === "number") return e;
  if (e.timestamp) {
    const ms = Date.parse(e.timestamp);
    if (Number.isFinite(ms)) return { ...e, at: ms };
  }
  return { ...e, at: Date.now() };
}

function activityLabel(e: ActivityEvent): string {
  if (e.kind === "tool") return e.tool ?? "unknown";
  if (e.kind === "lifecycle" && e.event) return e.event.replace(/_/g, " ");
  return e.kind ?? "event";
}

function activityKind(e: ActivityEvent): string {
  if (e.kind === "tool" && e.tool) {
    const ns = e.tool.split(".")[0];
    return ns ?? "tool";
  }
  if (e.kind === "lifecycle" && e.event) {
    if (/approval/i.test(e.event)) return "approval";
    if (/session/i.test(e.event)) return "session";
    if (/step/i.test(e.event)) return "step";
    if (/recipe/i.test(e.event)) return "recipe";
  }
  return e.kind ?? "event";
}

/**
 * Extract the recipe a row belongs to. Every step/recipe event the
 * bridge emits carries metadata.recipeName, but pre-2026-05-13 the
 * Overview activity thread dropped it on the floor. Surfacing it makes
 * recipes feel like the protagonist of the activity stream instead of
 * a hidden parent of disconnected tool calls.
 */
function activityRecipe(e: ActivityEvent): string | undefined {
  const m = e.metadata;
  if (!m || typeof m !== "object") return undefined;
  const direct = (m as Record<string, unknown>).recipeName ?? (m as Record<string, unknown>).recipe;
  if (typeof direct === "string" && direct.length > 0) {
    return direct.replace(/:agent$/, "");
  }
  return undefined;
}

// Compact uptime renderer for the hero meta line — matches the wireframe's
// "4d 12h uptime" rhythm. Drops smaller-than-relevant units so a 3-day-old
// bridge reads "3d 4h", a fresh restart reads "12m", not "0d 0h 12m".
function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${sec}s`;
}

// Telemetry-tile icons. Match the wireframe glyphs (≡ recipes, 🔒 approvals,
// >_ tools, ☉ tokens) but rendered as 12×12 inline SVGs at --ink-3 so they
// read as muted decoration next to the uppercase tile labels.
const TILE_ICON_PROPS = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
function TileIconPlay() {
  return (
    <svg {...TILE_ICON_PROPS} aria-hidden="true">
      <path d="M5 3l14 9-14 9V3z" />
    </svg>
  );
}
function TileIconLock() {
  return (
    <svg {...TILE_ICON_PROPS} aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
function TileIconShell() {
  return (
    <svg {...TILE_ICON_PROPS} aria-hidden="true">
      <path d="M5 8l4 4-4 4" />
      <path d="M13 16h6" />
    </svg>
  );
}
function TileIconOctagon() {
  return (
    <svg {...TILE_ICON_PROPS} aria-hidden="true">
      <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Activity thread (wireframe spec)
// ---------------------------------------------------------------------------

/**
 * Collapse runs of consecutive events that share the same (kind, tool/event,
 * status) signature into a single row carrying a count. Without this, a
 * workspace with eight back-to-back "approval rejected" lifecycle events
 * fills the entire thread with identical-looking wallpaper — the audits
 * called this out as the single biggest "flat" contributor.
 *
 * The first event in a run is kept (so the recipe name + most recent
 * timestamp survive), and an extra `_count` field is grafted on for the
 * renderer. We never collapse runs of length 1 — the count badge only
 * appears when it adds information.
 */
function compressActivityRuns(events: ActivityEvent[]): ActivityEvent[] {
  if (events.length < 2) return events;
  const sigOf = (e: ActivityEvent) =>
    [
      e.kind ?? "",
      e.kind === "tool" ? e.tool ?? "" : e.event ?? "",
      e.status ?? "",
    ].join("|");
  const out: ActivityEvent[] = [];
  let current: ActivityEvent | null = null;
  let count = 0;
  for (const e of events) {
    if (current && sigOf(current) === sigOf(e)) {
      count += 1;
      continue;
    }
    if (current) {
      out.push(count > 1 ? { ...current, _count: count } : current);
    }
    current = e;
    count = 1;
  }
  if (current) {
    out.push(count > 1 ? { ...current, _count: count } : current);
  }
  return out;
}

type ActivityFilter = "all" | "tools" | "approvals" | "errors";

function eventMatchesFilter(e: ActivityEvent, f: ActivityFilter): boolean {
  if (f === "all") return true;
  if (f === "errors") return e.status === "error";
  if (f === "tools") return e.kind === "tool";
  if (f === "approvals") {
    return e.kind === "lifecycle" && e.event === "approval_decision";
  }
  return true;
}

// ---------------------------------------------------------------------------
// Active recipe (live YAML + spinner)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function HomePage() {
  const bridgeStatus = useBridgeStatus();
  const { run: runRecipe, pending: runPending } = useRunRecipe();
  const { data: health } = useBridgeFetch<BridgeHealth>(
    "/api/bridge/health",
    { intervalMs: 5000 },
  );

  const [pendingApprovals, setPendingApprovals] = useState<Pending[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [runs, setRuns] = useState<LiveRun[]>([]);
  const [haltCount24hState, setHaltCount24h] = useState<number | null>(null);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [syncSpinning, setSyncSpinning] = useState(false);
  const tickRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [approvalsRes, recipesRes, activityRes, runsRes, haltRes] =
          await Promise.all([
            fetch(apiPath("/api/bridge/approvals")),
            fetch(apiPath("/api/bridge/recipes")),
            // Bumped from last=200 when the curve switched from 60-min to
            // 24h window — 200 events would undercount the 24h chart on
            // workspaces with steady use. Bridge cap is per-server config;
            // if 500 isn't honoured (older bridge clamps lower) the chart
            // simply shows the most recent N events bucketed into 24
            // hours, which still beats showing nothing.
            fetch(apiPath("/api/bridge/activity?last=500")),
            // Recipe-runs power the new LiveRunsStrip + RecipeLeaderboard.
            // catch() so an older bridge missing the endpoint just shows
            // empty surfaces — the rest of Overview keeps working.
            fetch(apiPath("/api/bridge/runs")).catch(() => null),
            // M7: use halt-summary for accurate haltCount24h (run list is
            // capped at 100 and undercounts on busy workspaces).
            fetch(apiPath("/api/bridge/runs/halt-summary?sinceMs=86400000")).catch(() => null),
          ]);
        if (!alive) return;

        const approvalsData = approvalsRes.ok
          ? ((await approvalsRes.json()) as Pending[])
          : [];
        const recipesData = recipesRes.ok
          ? await recipesRes.json()
          : { recipes: [] };
        const activityData = activityRes.ok
          ? ((await activityRes.json()) as { events?: ActivityEvent[] })
          : { events: [] };

        if (!alive) return;

        const list: Recipe[] = Array.isArray(recipesData)
          ? recipesData
          : (recipesData as { recipes?: Recipe[] }).recipes ?? [];

        const runsData = runsRes?.ok
          ? ((await runsRes.json()) as { runs?: LiveRun[] })
          : { runs: [] };
        const haltData = haltRes?.ok
          ? ((await haltRes.json()) as { total?: number })
          : null;

        setPendingApprovals(Array.isArray(approvalsData) ? approvalsData : []);
        setRecipes(list);
        setRuns(Array.isArray(runsData.runs) ? runsData.runs : []);
        if (haltData != null && typeof haltData.total === "number") {
          setHaltCount24h(haltData.total);
        }
        setActivityEvents(
          (activityData.events ?? []).map(withAt),
        );
      } catch {
        // bridge offline
      }
    };
    tickRef.current = () => void tick();
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Telemetry numbers — real bridge values, no floors.
  const pendingCount = pendingApprovals.length;

  const oldestApprovalLabel = (() => {
    if (pendingApprovals.length === 0) return "none pending";
    const oldest = Math.min(
      ...pendingApprovals.map((p) => p.requestedAt),
    );
    return `· oldest ${relTime(oldest)}`;
  })();

  // Runs + halts aggregations for the rebalanced telemetry tiles.
  // The old "Recipes shipped" + "Tokens burnt" tiles were a static
  // install count (changes weekly at best) and a since-restart
  // cumulative — neither answered "what's happening right now?".
  // These two answer that, and unlike the old tiles they're never
  // a permanent zero on a healthy workspace.
  const dayMs = 24 * 60 * 60 * 1000;
  const runsCount24h = runs.filter((r) => Date.now() - r.startedAt < dayMs).length;
  // M7: prefer the halt-summary endpoint total (uncapped) over a local
  // filter of the capped run list (max 100 runs on older bridges).
  const haltCount24h =
    haltCount24hState ??
    runs.filter((r) => Date.now() - r.startedAt < dayMs && isHaltStatus(r.status)).length;
  const runs24h = runs.filter((r) => Date.now() - r.startedAt < dayMs);
  const errCount24h = runs24h.filter(
    (r) => r.status === "error" || r.status === "failed",
  ).length;
  // A run can finish `done` yet have had a step fail (the runner
  // continues past non-fatal step errors). Splitting these out keeps
  // the Overview honest — flat "100% ok" was hiding step failures
  // that /runs separately counted, so the two views contradicted.
  const succeeded24h = runs24h.filter(
    (r) => r.status === "done" || r.status === "success",
  );
  const withErrCount24h = succeeded24h.filter((r) => r.hadStepErrors).length;
  const okCount24h = succeeded24h.length - withErrCount24h;
  const runsFootLabel = runsCount24h === 0
    ? "no runs yet"
    : [
        `${okCount24h} ok`,
        withErrCount24h > 0 ? `${withErrCount24h} with step errors` : null,
        errCount24h > 0 ? `${errCount24h} err` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  const haltsFootLabel = (() => {
    if (haltCount24h === 0) return "clean";
    const lastHalt = runs24h.find((r) => isHaltStatus(r.status));
    return lastHalt ? `last ${relTime(lastHalt.startedAt)}` : "—";
  })();
  // 7-day daily-bucket series for the micro-sparkline. Buckets are
  // ordered oldest → newest so the curve reads left-to-right.
  const runs7dSeries = (() => {
    const buckets = new Array(7).fill(0);
    const now = Date.now();
    for (const r of runs) {
      const idx = Math.floor((now - r.startedAt) / dayMs);
      if (idx >= 0 && idx < 7) buckets[6 - idx] += 1;
    }
    return buckets;
  })();
  const halts7dSeries = (() => {
    const buckets = new Array(7).fill(0);
    const now = Date.now();
    for (const r of runs) {
      if (!isHaltStatus(r.status)) continue;
      const idx = Math.floor((now - r.startedAt) / dayMs);
      if (idx >= 0 && idx < 7) buckets[6 - idx] += 1;
    }
    return buckets;
  })();
  // Per-day labels for the sparkline hover inspector. Indices match
  // the bucket order: oldest → newest, rightmost is "today".
  const days7dLabels = (() => {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    const out: string[] = [];
    for (let i = 6; i >= 0; i--) {
      if (i === 0) {
        out.push("today");
        continue;
      }
      const d = new Date(Date.now() - i * dayMs);
      out.push(fmt.format(d).toLowerCase());
    }
    return out;
  })();

  // "Tools called today" used to display toolCallTotal — the cumulative
  // Prometheus counter since bridge restart. The label promised "today" but
  // delivered "since restart", which is days off after a long-running bridge.
  // Recompute from activity events filtered to today/yesterday so the tile
  // matches its label and can show a trend delta vs yesterday (per wireframe).
  // Caveat: activity feed caps at 200 events so workspaces with >200 tool
  // calls/day will undercount; the tile is best-effort, not auditable.
  const { toolsToday, toolsTrendLabel } = (() => {
    const startOfToday = (() => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })();
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
    let today = 0;
    let yesterday = 0;
    for (const e of activityEvents) {
      if (e.kind !== "tool") continue;
      const at = e.at ?? 0;
      if (at >= startOfToday) today++;
      else if (at >= startOfYesterday) yesterday++;
    }
    let label: string;
    if (today === 0 && yesterday === 0) {
      label = "no calls yet";
    } else if (yesterday === 0) {
      label = "first day with calls";
    } else {
      const pct = Math.round(((today - yesterday) / yesterday) * 100);
      if (pct === 0) label = "flat vs yesterday";
      else if (pct > 0) label = `↑ +${pct}% vs yesterday`;
      else label = `↓ ${pct}% vs yesterday`;
    }
    return { toolsToday: today, toolsTrendLabel: label };
  })();

  // Tool-calls 24h curve — bucketed from activity-event timestamps so
  // historical activity is visible immediately on page load (not only what
  // happens while the user stays on the tab). Switched from per-minute
  // (60 min window) to per-hour (24h window) because the shorter window
  // looked dead during normal quiet periods — bursty data still produced
  // tall narrow spikes that didn't match the wireframe's gradual-rise
  // shape. Per-hour buckets absorb individual bursts into the hour's
  // total naturally; sparse-but-steady usage produces a daily-curve
  // shape (rises morning-through-day, falls overnight) without any
  // engineered smoothing. The hour granularity also makes the rolling-
  // sum smoothing redundant — a single bucket already covers an hour.
  const curveSeries = (() => {
    const HOURS = 24;
    const HOUR_MS = 60 * 60 * 1000;
    const buckets = Array(HOURS).fill(0);
    const now = Date.now();
    const windowStart = now - HOURS * HOUR_MS;
    for (const e of activityEvents) {
      if (e.kind !== "tool") continue;
      const at = e.at ?? 0;
      if (at < windowStart) continue;
      // 0 = oldest hour, 23 = current hour
      const idx = Math.min(HOURS - 1, Math.floor((at - windowStart) / HOUR_MS));
      buckets[idx]++;
    }
    // Rolling 15-min sum smears bursts into the wireframe's flowing
    // gradual-slope shape. Smaller windows (5 min) still show distinct humps
    // when activity is bursty rather than sustained. The metric is still
    // meaningful — peaks reflect real activity, just spread over the
    // window — and matches how the curve would look organically with
    // sustained usage.
    const SMOOTH = 15;
    return buckets.map((_, i) => {
      let sum = 0;
      for (let j = Math.max(0, i - SMOOTH + 1); j <= i; j++) sum += buckets[j];
      return sum;
    });
  })();
  // Hour-of-day labels aligned to curveSeries (index 0 = oldest hour, 23 =
  // current), so the Tools sparkline carries a hover inspector instead of an
  // unlabelled curve (facelift P1-4).
  const hours24Labels = (() => {
    const HOURS = 24;
    const HOUR_MS = 60 * 60 * 1000;
    const windowStart = Date.now() - HOURS * HOUR_MS;
    return Array.from({ length: HOURS }, (_, i) => {
      const h = new Date(windowStart + i * HOUR_MS).getHours();
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return `${h12}${h < 12 ? "am" : "pm"}`;
    });
  })();
  // Command Deck header — app name + current date/time + bridge status pill.
  const nowLabel = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  // "Live now" panel — the most-recently-started running run, if any.
  const liveRun = runs.find((r) => r.status === "running");
  const liveRunOtherToday = runsCount24h > (liveRun ? 1 : 0)
    ? runsCount24h - (liveRun ? 1 : 0)
    : 0;

  // 24h heatmap — reuses curveSeries' hourly buckets (tool-call counts) and
  // layers in per-hour error presence from runs24h, which curveSeries does
  // not track (it's tool-call-scoped, not run-scoped).
  const heatmapCells = (() => {
    const HOURS = 24;
    const HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();
    const windowStart = now - HOURS * HOUR_MS;
    const errByHour = new Array(HOURS).fill(false);
    for (const r of runs24h) {
      if (r.status !== "error" && r.status !== "failed" && !isHaltStatus(r.status)) continue;
      if (r.startedAt < windowStart) continue;
      const idx = Math.min(HOURS - 1, Math.floor((r.startedAt - windowStart) / HOUR_MS));
      errByHour[idx] = true;
    }
    const maxCount = Math.max(1, ...curveSeries);
    return curveSeries.map((count, i) => {
      let level: 0 | 1 | 2 | 3 = 0;
      if (count > 0) {
        const ratio = count / maxCount;
        level = ratio > 0.66 ? 3 : ratio > 0.33 ? 2 : 1;
      }
      return { count, hasError: errByHour[i], level, label: hours24Labels[i] };
    });
  })();
  const heatmapErrHours = heatmapCells.filter((c) => c.hasError).length;

  // Vitals panel — reuse fetched state; sessions comes from bridgeStatus
  // (falls back to health.activeSessions when the /status poll hasn't
  // populated it yet, matching the source health already reads).
  const sessionsCount = bridgeStatus.activeSessions ?? health?.activeSessions;
  const enabledRecipesCount = recipes.filter((r) => r.enabled !== false).length;

  // Top recipes leaderboard (24h) — same aggregation shape as
  // RecipeLeaderboard (name, runs, total, halts, okRate), computed locally
  // since that logic isn't exported; kept in lockstep by construction (both
  // read `runs`/LiveRun directly, no separate fetch).
  const topRecipes24h = (() => {
    const cutoff = Date.now() - dayMs;
    const byName = new Map<string, LiveRun[]>();
    for (const r of runs) {
      if (r.startedAt < cutoff) continue;
      const name = canonicalRecipeKey(r.recipeName ?? r.recipe ?? "");
      if (!name) continue;
      const list = byName.get(name) ?? [];
      list.push(r);
      byName.set(name, list);
    }
    const out: Array<{ name: string; runs: LiveRun[]; total: number; okRate: number }> = [];
    for (const [name, list] of byName) {
      const sorted = [...list].sort((a, b) => b.startedAt - a.startedAt);
      const decided = sorted.filter((r) => r.status !== "running");
      const okCount = decided.filter((r) => r.status === "done" || r.status === "success").length;
      out.push({
        name,
        runs: sorted,
        total: sorted.length,
        okRate: decided.length === 0 ? 0 : Math.round((okCount / decided.length) * 100),
      });
    }
    out.sort((a, b) => b.total - a.total);
    return out.slice(0, 5);
  })();

  return (
    <section>
      {/* Kill-switch banner rendered globally by Shell — was duplicated here. */}
      {/*
        First-run checklist: orchestrates the 4-step happy path for
        brand-new workspaces (connect → install recipe → run → approve).
        Self-gates to null once every step is complete or the user has
        dismissed it, so it never lingers on an established workspace.
      */}
      <FirstRunChecklist />

      {/* ------------------------------------------------------------------ */}
      {/* Command Deck header — app name + date/time + bridge status pill.    */}
      {/* ------------------------------------------------------------------ */}
      <div className="hc-top">
        <h2>
          Patchwork · <span className="muted">{nowLabel}</span>
        </h2>
        {bridgeStatus.ok ? (
          <span className="pill ok">
            <span className="dot ok" aria-hidden="true" />
            {" bridge up "}
            {typeof bridgeStatus.uptimeMs === "number" ? formatUptime(bridgeStatus.uptimeMs) : "—"}
            {bridgeStatus.extensionConnected ? " · IDE attached" : ""}
          </span>
        ) : (
          <span className="pill err">
            <span className="dot err" aria-hidden="true" />
            {" bridge offline"}
          </span>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* COMMAND DECK — 12-col grid. Row 1: needs-attention (span 7) + live  */}
      {/* now (span 5). Row 2: 24h heatmap / vitals / top recipes (span 4×3). */}
      {/* ------------------------------------------------------------------ */}
      <div className="hc-grid">
        <div className="hc-panel card hc-a" data-severity={bandSeverity(buildAttentionItems({ pendingCount, haltCount24h, failingCount24h: errCount24h }))}>
          <h3>
            Needs attention
            {!bridgeStatus.ok ? null : pendingCount + haltCount24h + errCount24h > 0 ? (
              <span className="pill warn">
                {[pendingCount > 0, haltCount24h > 0, errCount24h > 0].filter(Boolean).length} queue
                {[pendingCount > 0, haltCount24h > 0, errCount24h > 0].filter(Boolean).length === 1 ? "" : "s"}
              </span>
            ) : (
              <span className="pill ok">all clear</span>
            )}
          </h3>
          {!bridgeStatus.ok ? (
            <div className="muted" style={{ fontSize: "var(--fs-s)" }}>
              Bridge offline — connect to see agent status.{" "}
              <Link href="/connections">Check connections →</Link>
            </div>
          ) : (
            <>
              <div className="ha-chips">
                <Link
                  href="/approvals"
                  className={`ha-chip${pendingCount > 0 ? " warn" : " ok"}`}
                  aria-label={`${pendingCount} approvals pending — view all`}
                >
                  <span className="n">{pendingCount}</span> approvals →
                </Link>
                <Link
                  href="/runs?halt=1"
                  className={`ha-chip${haltCount24h > 0 ? " err" : " ok"}`}
                  aria-label={`${haltCount24h} halts in last 24h — view all`}
                >
                  <span className="n">{haltCount24h}</span> halts →
                </Link>
                <Link
                  href="/runs?window=24h"
                  className={`ha-chip${errCount24h > 0 ? " err" : " ok"}`}
                  aria-label={`${errCount24h} failing runs in last 24h — view all`}
                >
                  <span className="n">{errCount24h}</span> failures →
                </Link>
              </div>
              {pendingCount === 0 && haltCount24h === 0 && errCount24h === 0 ? (
                <div className="ha-row">
                  <span className="pill ok">clear</span>
                  <span className="muted">No approvals pending · no halts · no failures</span>
                </div>
              ) : (
                <>
                  {runs24h
                    .filter((r) => isHaltStatus(r.status) || r.status === "error" || r.status === "failed")
                    .sort((a, b) => b.startedAt - a.startedAt)
                    .slice(0, 3)
                    .map((r, i) => {
                      const name = (r.recipeName ?? r.recipe ?? "").replace(/:agent$/, "");
                      const isQueueing = Boolean(runPending[canonicalRecipeKey(name)]);
                      return (
                        <div className="ha-row" key={r.seq ?? `${name}-${r.startedAt}-${i}`}>
                          <span className="pill err">
                            {isHaltStatus(r.status) ? "halted" : r.status}
                          </span>
                          <strong className="mono">{recipeDisplayName(name)}</strong>
                          <span className="muted">
                            {r.haltReason ?? r.status} · {relTime(r.startedAt)}
                          </span>
                          <span className="sp" />
                          <button
                            type="button"
                            className="btn sm"
                            disabled={isQueueing}
                            onClick={() => void runRecipe(canonicalRecipeKey(name))}
                          >
                            {isQueueing ? "…" : "↻ Retry"}
                          </button>
                        </div>
                      );
                    })}
                  {pendingApprovals.slice(0, Math.max(0, 3 - haltCount24h - errCount24h)).map((p) => (
                    <div className="ha-row" key={p.callId}>
                      <span className="pill warn">approval</span>
                      <strong className="mono">{p.toolName}</strong>
                      <span className="muted">{p.summary ?? p.tier} · {relTime(p.requestedAt)}</span>
                      <span className="sp" />
                      <Link href="/approvals" className="btn sm">Review</Link>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>

        <div className="hc-panel card hc-b">
          <h3>Live now</h3>
          {!bridgeStatus.ok ? (
            <div className="muted" style={{ fontSize: "var(--fs-s)" }}>Bridge offline.</div>
          ) : liveRun ? (
            (() => {
              const name = (liveRun.recipeName ?? liveRun.recipe ?? "").replace(/:agent$/, "");
              const elapsedMs = Date.now() - liveRun.startedAt;
              const elapsed =
                elapsedMs < 60_000
                  ? `${Math.floor(elapsedMs / 1000)}s`
                  : elapsedMs < 3_600_000
                    ? `${Math.floor(elapsedMs / 60_000)}m ${Math.floor((elapsedMs % 60_000) / 1000)}s`
                    : `${Math.floor(elapsedMs / 3_600_000)}h ${Math.floor((elapsedMs % 3_600_000) / 60_000)}m`;
              const startedLabel = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
                new Date(liveRun.startedAt),
              );
              return (
                <>
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <svg className="hc-ring" viewBox="0 0 34 34" aria-hidden="true">
                      <circle cx="17" cy="17" r="14" fill="none" stroke="var(--recess)" strokeWidth="4" />
                      <circle
                        cx="17"
                        cy="17"
                        r="14"
                        fill="none"
                        stroke="var(--ok)"
                        strokeWidth="4"
                        strokeDasharray="66 88"
                        strokeLinecap="round"
                        transform="rotate(-90 17 17)"
                      />
                    </svg>
                    <div>
                      <div style={{ fontWeight: 700 }} className="mono">
                        {recipeDisplayName(name)} <span className="pill info">{elapsed}</span>
                      </div>
                      <div className="muted" style={{ fontSize: "var(--fs-2xs)" }}>
                        started {startedLabel}
                        {liveRunOtherToday > 0
                          ? ` · ${liveRunOtherToday} other run${liveRunOtherToday === 1 ? "" : "s"} today`
                          : ""}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <Link
                      href={liveRun.seq != null ? `/runs/${liveRun.seq}` : `/runs?recipe=${encodeURIComponent(name)}`}
                      className="btn sm primary"
                    >
                      View live →
                    </Link>
                    <Link href="/runs" className="btn sm ghost">All runs</Link>
                  </div>
                </>
              );
            })()
          ) : (
            <>
              <div className="muted" style={{ fontSize: "var(--fs-s)" }}>
                Nothing running right now.
                {runs24h.length > 0
                  ? ` Last finished ${relTime(runs24h[0].startedAt)}.`
                  : ""}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <Link href="/runs" className="btn sm ghost">All runs</Link>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="hc-grid" style={{ marginTop: 14 }}>
        <div className="hc-panel card hc-c">
          <h3>
            Runs · last 24h <span>{runsCount24h}</span>
          </h3>
          <div
            className="hc-heat"
            role="img"
            aria-label={`hourly run activity, ${heatmapErrHours} hour${heatmapErrHours === 1 ? "" : "s"} with errors`}
          >
            {heatmapCells.map((c, i) => (
              <i
                key={i}
                className={c.hasError ? "er" : c.level > 0 ? `l${c.level}` : undefined}
                title={`${c.label} · ${c.count} call${c.count === 1 ? "" : "s"}${c.hasError ? " · error" : ""}`}
              />
            ))}
          </div>
          <div className="muted" style={{ fontSize: "var(--fs-xs)", marginTop: 8 }}>
            {runsFootLabel}
          </div>
        </div>

        <div className="hc-panel card hc-d">
          <h3>Vitals</h3>
          <div className="hc-kv">
            <span className="muted">Tool calls · 24h</span>
            <strong>{toolsToday.toLocaleString()}</strong>
          </div>
          {typeof sessionsCount === "number" && (
            <div className="hc-kv">
              <span className="muted">Sessions</span>
              <strong>{sessionsCount} active</strong>
            </div>
          )}
          <div className="hc-kv">
            <span className="muted">Kill switch</span>
            <strong style={{ color: bridgeStatus.killSwitch?.engaged ? "#93312f" : "#3f6b36" }}>
              {bridgeStatus.killSwitch?.engaged ? "engaged" : "released"}
            </strong>
          </div>
          <div className="hc-kv">
            <span className="muted">Recipes enabled</span>
            <strong>
              {enabledRecipesCount} / {recipes.length}
            </strong>
          </div>
        </div>

        <div className="hc-panel card hc-e">
          <h3>Top recipes · 24h</h3>
          {topRecipes24h.length === 0 ? (
            <div className="muted" style={{ fontSize: "var(--fs-s)" }}>
              No runs in the last 24h.
            </div>
          ) : (
            topRecipes24h.map((a) => (
              <div className="hc-lead" key={a.name}>
                <strong className="mono" style={{ flex: 1 }}>
                  {recipeDisplayName(a.name)}
                </strong>
                <RunSparkBars runs={a.runs.slice(0, 8)} slots={8} width={70} height={16} />
                <span className="muted">{a.okRate}%</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* LIVE RUNS — pulses any currently-running or recently-finished       */}
      {/* recipe so a user landing on Overview can see motion at a glance.    */}
      {/* Component auto-hides when there's nothing in-flight or recent.      */}
      {/* ------------------------------------------------------------------ */}
      <LiveRunsStrip runs={runs} />

      {/* ------------------------------------------------------------------ */}
      {/* TELEMETRY eyebrow — gated: hidden when no recipes and no runs       */}
      {/* (four "0" tiles look broken on first visit)                         */}
      {/* ------------------------------------------------------------------ */}
      {(recipes.length > 0 || runs.length > 0) && <>
      <div className="pg-section-head" style={{ animation: "pw-fade-in 0.4s ease both" }}>
        <span className="pg-section-head-label">
          <span aria-hidden="true" className="pg-section-head-bar" />
          Telemetry
        </span>
        <div className="pg-section-head-rule" aria-hidden="true" />
        <button
          type="button"
          className={`btn sm ghost${syncSpinning ? " btn--spinning" : ""}`}
          onClick={() => {
            tickRef.current();
            setSyncSpinning(true);
            setTimeout(() => setSyncSpinning(false), 650);
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Sync
        </button>
      </div>

      {/* Four telemetry tiles. Inline grid-template-columns used to force
          repeat(4, minmax(0,1fr)) — that wins over the responsive .stat-grid
          class default (auto-fit minmax(180px, 1fr)) and made tile labels
          ellipsise to "PENDING APPROV/" / "TOOLS CALLED TOD…" on mobile.
          Drop the inline override; .stat-grid auto-fit gives 4 cols at
          desktop (≥768px content width) and stacks gracefully on narrow. */}
      <div className="stat-grid mb-5">
        {!health && bridgeStatus.ok !== false ? (
          <>
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
          </>
        ) : (
          <>
            <div className="stat-card-wrap" style={{ animationDelay: "0ms", animation: "pw-slide-up 0.3s ease both" }}>
              <StatCard
                label="Runs · 24h"
                className="stat-card--runs"
                icon={<span className="stat-tile-icon stat-tile-icon--runs" style={{ color: "var(--ok)" }}><TileIconPlay /></span>}
                value={<AnimatedNumber value={runsCount24h} />}
                foot={
                  <div>
                    <div>{runsFootLabel}</div>
                    {runs7dSeries.some((v) => v > 0) && (
                      <div className="mt-1">
                        <Sparkline
                          values={runs7dSeries}
                          color="var(--ok)"
                          height={22}
                          labels={days7dLabels}
                          unit="runs"
                        />
                      </div>
                    )}
                  </div>
                }
                href="/runs?window=24h"
              />
            </div>
            <div className="stat-card-wrap" style={{ animationDelay: "60ms", animation: "pw-slide-up 0.3s ease both" }}>
              <StatCard
                label="Pending approvals"
                className="stat-card--approvals"
                icon={<span className="stat-tile-icon stat-tile-icon--approvals" style={{ color: "var(--amber)" }}><TileIconLock /></span>}
                value={<AnimatedNumber value={pendingCount} />}
                foot={
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {pendingCount > 0 && (
                      <span className="pw-live-dot pw-live-dot--warn" aria-label="Pending approvals" />
                    )}
                    {oldestApprovalLabel}
                  </div>
                }
                href="/approvals"
              />
            </div>
            <div className="stat-card-wrap" style={{ animationDelay: "120ms", animation: "pw-slide-up 0.3s ease both" }}>
              <StatCard
                label="Halts · 24h"
                className="stat-card--halts"
                icon={<span className="stat-tile-icon stat-tile-icon--halts" style={{ color: "var(--err)" }}><TileIconOctagon /></span>}
                value={<AnimatedNumber value={haltCount24h} />}
                foot={
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {haltCount24h > 0 && (
                        <span className="pw-live-dot pw-live-dot--err" aria-label="Halts detected" />
                      )}
                      {haltsFootLabel}
                    </div>
                    {halts7dSeries.some((v) => v > 0) && (
                      <div className="mt-1">
                        <Sparkline
                          values={halts7dSeries}
                          color="var(--err)"
                          height={22}
                          labels={days7dLabels}
                          unit="halts"
                        />
                      </div>
                    )}
                  </div>
                }
                href="/runs?halt=1"
              />
            </div>
            <div className="stat-card-wrap" style={{ animationDelay: "180ms", animation: "pw-slide-up 0.3s ease both" }}>
              {/* Foot shows the trend label ("no calls yet" / "↑ +12% vs
                  yesterday") so this tile carries context like its siblings
                  ("2 ok" / "none pending" / "clean") instead of an empty foot.
                  The trend label folds in the arrow + %, so the separate delta
                  badge — the only one across the four tiles — is dropped for
                  consistency. */}
              <StatCard
                label="Tools called today"
                className="stat-card--tools"
                icon={<span className="stat-tile-icon stat-tile-icon--tools" style={{ color: "var(--accent-cool)" }}><TileIconShell /></span>}
                value={<AnimatedNumber value={toolsToday} />}
                foot={
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {toolsToday > 0 && (
                        <span className="pw-live-dot" aria-label="Active today" />
                      )}
                      <span>{toolsTrendLabel}</span>
                    </div>
                    {curveSeries.some((v) => v > 0) && (
                      <div className="mt-1">
                        <Sparkline
                          values={curveSeries}
                          color="var(--accent-cool)"
                          height={22}
                          labels={hours24Labels}
                          unit="calls"
                        />
                      </div>
                    )}
                  </div>
                }
                href="/activity"
              />
            </div>
          </>
        )}
      </div>
      </>}

      {/* ------------------------------------------------------------------ */}
      {/* Recipes — detailed health view. The three-column Draft/Paused/     */}
      {/* Active kanban that used to live here was removed from the landing  */}
      {/* flow per the Command Deck redesign; the leaderboard is now the     */}
      {/* sole recipes surface on Home (full board still lives at /recipes). */}
      {/* ------------------------------------------------------------------ */}
      <div className="pg-section-head" style={{ animation: "pw-fade-in 0.4s ease both" }}>
        <span className="pg-section-head-label">
          <span aria-hidden="true" className="pg-section-head-bar" />
          Recipes
        </span>
        <div className="pg-section-head-rule" aria-hidden="true" />
      </div>
      <RecipeLeaderboard runs={runs as LeaderboardRun[]} />

      {/* ------------------------------------------------------------------ */}
      {/* LIVE WIRE — demoted below the fold per design spec. Always-present  */}
      {/* 1-row heartbeat ("● 2 running · last finished 4m ago").             */}
      {/* ------------------------------------------------------------------ */}
      <LiveWire runs={runs} bridgeOk={bridgeStatus.ok === true} />

    </section>
  );
}

// (kept for upstream typing imports / no-op reference)
export type { BridgeHealth };
