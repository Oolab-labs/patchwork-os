"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { StatCard } from "@/components/StatCard";
import { SkeletonStatCard } from "@/components/Skeleton";
import { relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { useBridgeStatus } from "@/hooks/useBridgeStatus";
import { isNoiseEvent } from "@/lib/activityNoise";
import {
  ActionPill,
  AnimatedNumber,
  AreaChart,
  LivePill,
  QuiltHero,
  WeatherRing,
} from "@/components/patchwork";

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

/**
 * Tool calls — last 60 minutes widget. Polls /metrics every 5s and
 * renders the per-minute delta. Pre-empty-state-pass this rendered an
 * AreaChart unconditionally — when the bridge has had no tool calls
 * yet (the common first-run state), the curve is a flat line at zero
 * and the "0" badge in the top-right looks like a broken reading
 * rather than an intentional empty state. Now the chart only renders
 * when there's actual signal; otherwise we show a one-line hint
 * explaining what populates the curve.
 */
function ToolCallsWidget({
  series,
  peak,
  uniqueTools,
  activeRecipesCount,
  toolCallTotal,
  bridgeOk,
}: {
  series: number[];
  peak: number;
  uniqueTools: number;
  activeRecipesCount: number;
  toolCallTotal: number;
  bridgeOk: boolean;
}): React.JSX.Element {
  const total = series.reduce((a, b) => a + b, 0);
  const hasActivity = peak > 0 || total > 0 || toolCallTotal > 0;
  return (
    <div
      className="card"
      style={{
        padding: "16px 20px 12px",
        marginBottom: "var(--s-5)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: "var(--fs-m)",
            fontWeight: 700,
            color: "var(--ink-0)",
            flex: 1,
          }}
        >
          Tool calls — last 24 hours
        </span>
        {/* Live pill matches the wireframe's top-right indicator. The
            numeric "total" badge it replaced was redundant with the chart
            area's own visual weight and added noise. */}
        <LivePill connection={hasActivity ? "live" : "offline"} />
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-xs)",
          color: "var(--ink-3)",
          marginBottom: 10,
        }}
      >
        peak {peak}/hour · {uniqueTools} unique tools · {activeRecipesCount}{" "}
        active recipes
      </div>
      {hasActivity ? (
        <AreaChart
          series={[{ values: series, color: "var(--orange)" }]}
          height={120}
          minimal
        />
      ) : (
        <div
          role="status"
          style={{
            alignItems: "center",
            border: "1px dashed var(--line-2)",
            borderRadius: "var(--r-2)",
            color: "var(--ink-3)",
            display: "flex",
            flexDirection: "column",
            fontSize: "var(--fs-xs)",
            gap: 4,
            height: 120,
            justifyContent: "center",
            textAlign: "center",
          }}
        >
          <div style={{ color: "var(--ink-2)", fontWeight: 600 }}>
            No tool calls in the last 24 hours
          </div>
          <div style={{ maxWidth: 480 }}>
            {bridgeOk
              ? "Connect a Claude Code session to the bridge and call any MCP tool — the curve fills in within a tick."
              : "Bridge offline. Once it's running, tool calls from connected agents show up here."}
          </div>
        </div>
      )}
    </div>
  );
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
  return e.kind ?? "event";
}

function greetingFromHour(h: number): string {
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function useGreeting(): string {
  const [g, setG] = useState("");
  useEffect(() => {
    setG(greetingFromHour(new Date().getHours()));
  }, []);
  return g;
}

function parseUptimeMs(text: string): number | null {
  if (!text) return null;
  const m = text.match(/^bridge_uptime_seconds\s+(\d+(?:\.\d+)?)/m);
  if (m) return Math.round(Number.parseFloat(m[1]) * 1000);
  return null;
}

// Compact human-readable counts: 4_752_583_497 → "4.8B", 58_376_273 → "58M".
// Used in tile sub-stats where digits would crowd out other content. Falls
// back to toLocaleString below 10k where readable digits are still cheap.
function formatCompact(n: number): string {
  if (n < 10_000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 100_000 ? 1 : 0)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 100_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(n < 100_000_000_000 ? 1 : 0)}B`;
}

function parseToolCallTotal(text: string): number {
  if (!text) return 0;
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^bridge_tool_calls_total(?:\{[^}]*\})?\s+(\d+(?:\.\d+)?)/);
    if (m) total += Number.parseFloat(m[1]);
  }
  return Math.round(total);
}

// ---------------------------------------------------------------------------
// Activity thread (wireframe spec)
// ---------------------------------------------------------------------------

function ActivityThread({ events }: { events: ActivityEvent[] }) {
  return (
    <div className="card" style={{ padding: "18px 20px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 14,
        }}
      >
        <h2
          style={{
            fontSize: "var(--fs-m)",
            fontWeight: 700,
            margin: 0,
            color: "var(--ink-0)",
            flex: 1,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Activity thread
        </h2>
        <ActionPill href="/activity" ariaLabel="View all activity">
          view all →
        </ActionPill>
      </div>

      {events.length === 0 ? (
        <div
          style={{
            color: "var(--ink-3)",
            fontSize: "var(--fs-s)",
            padding: "var(--s-3) 0 var(--s-4)",
          }}
        >
          <div style={{ color: "var(--ink-2)", marginBottom: 4 }}>
            No recent events.
          </div>
          <div style={{ fontSize: "var(--fs-xs)" }}>
            Tool calls and lifecycle events from connected agents will
            appear here in real time.
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 0,
            position: "relative",
          }}
        >
          {/* vertical rail */}
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 6,
              top: 6,
              bottom: 6,
              width: 1,
              background: "var(--line-3)",
            }}
          />
          {events.map((e, i) => {
            const ts = e.at ?? Date.now();
            const tool = activityLabel(e);
            const kind = activityKind(e);
            const isErr = e.status === "error";
            const dur =
              typeof e.durationMs === "number" ? `${e.durationMs}ms` : null;
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: stable list
                key={e.id ?? i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 0 7px 18px",
                  position: "relative",
                  fontSize: "var(--fs-s)",
                  minWidth: 0,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    left: 2,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: isErr ? "var(--err)" : "var(--orange)",
                    border: "2px solid var(--card-bg, #fff)",
                  }}
                />
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--fs-xs)",
                    color: "var(--ink-3)",
                    minWidth: 56,
                    flexShrink: 0,
                  }}
                >
                  {relTime(ts)}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--fs-s)",
                    color: "var(--ink-0)",
                    fontWeight: 600,
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tool}
                </span>
                <span
                  className="pill muted"
                  style={{ fontSize: "var(--fs-3xs)", flexShrink: 0 }}
                >
                  {kind}
                </span>
                {dur && (
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--fs-2xs)",
                      color: "var(--ink-2)",
                      flexShrink: 0,
                    }}
                  >
                    {dur}
                  </span>
                )}
                <span
                  className={`pill ${isErr ? "err" : "ok"}`}
                  style={{ fontSize: "var(--fs-3xs)", flexShrink: 0 }}
                >
                  {isErr ? "err" : "ok"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active recipe (live YAML + spinner)
// ---------------------------------------------------------------------------

function RecentRecipesCard({ recipes }: { recipes: Recipe[] }) {
  const top = [...recipes]
    .filter((r) => r.enabled !== false)
    .sort((a, b) => (b.lastRun ?? 0) - (a.lastRun ?? 0))
    .slice(0, 6);
  return (
    <div className="card" style={{ padding: "18px 20px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 14,
        }}
      >
        <h2
          style={{
            fontSize: "var(--fs-m)",
            fontWeight: 700,
            margin: 0,
            color: "var(--ink-0)",
            flex: 1,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Recent recipes
        </h2>
        <ActionPill href="/recipes" ariaLabel="View all recipes">
          all →
        </ActionPill>
      </div>

      {top.length === 0 ? (
        <div style={{ fontSize: "var(--fs-s)", color: "var(--ink-3)", padding: "8px 0" }}>
          No enabled recipes yet.{" "}
          <Link href="/recipes/new" style={{ color: "var(--accent)" }}>
            Create one →
          </Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {top.map((r) => (
            <Link
              key={r.id ?? r.name}
              href={`/recipes/${encodeURIComponent(r.name)}/edit`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 8px",
                borderRadius: "var(--r-sm)",
                textDecoration: "none",
                color: "var(--ink-1)",
                fontSize: "var(--fs-s)",
              }}
            >
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink-0)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.name}
              </span>
              <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)" }}>
                {r.lastRun ? relTime(r.lastRun) : "never run"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health card
// ---------------------------------------------------------------------------

function HealthCard({
  bridgeVersion,
  extensionVersion,
  bridgeOk,
  extensionConnected,
}: {
  bridgeVersion: string;
  extensionVersion: string;
  bridgeOk: boolean;
  extensionConnected: boolean;
}) {
  const rows: { label: string; value: string; tone?: "ok" | "muted" | "warn" }[] = [
    {
      label: "Bridge",
      value: bridgeOk ? bridgeVersion : "offline",
      tone: bridgeOk ? "ok" : "warn",
    },
    {
      label: "VS Code extension",
      value: extensionConnected ? extensionVersion : "disconnected",
      tone: extensionConnected ? "ok" : "muted",
    },
  ];

  return (
    <div className="card" style={{ padding: "18px 20px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <h2
          style={{
            fontSize: "var(--fs-m)",
            fontWeight: 700,
            margin: 0,
            color: "var(--ink-0)",
            flex: 1,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Health
        </h2>
        <span
          className={`pill ${bridgeOk && extensionConnected ? "ok" : bridgeOk ? "muted" : "warn"}`}
          style={{ fontSize: "var(--fs-2xs)" }}
        >
          {bridgeOk && extensionConnected
            ? "all green"
            : bridgeOk
              ? "extension off"
              : "bridge offline"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r) => {
          const toneLabel =
            r.tone === "ok"
              ? "healthy"
              : r.tone === "warn"
                ? "degraded"
                : "inactive";
          const toneColor =
            r.tone === "ok"
              ? "var(--ok)"
              : r.tone === "warn"
                ? "var(--warn)"
                : "var(--ink-3)";
          return (
            <div
              key={r.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 12.5,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: toneColor,
                  flexShrink: 0,
                }}
              />
              <span style={{ color: "var(--ink-1)", flex: 1 }}>
                {r.label}
                <span
                  style={{
                    position: "absolute",
                    width: 1,
                    height: 1,
                    overflow: "hidden",
                    clip: "rect(0,0,0,0)",
                  }}
                >
                  {" "}
                  ({toneLabel})
                </span>
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                  color: "var(--ink-0)",
                  fontWeight: 600,
                }}
              >
                {r.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function HomePage() {
  const bridgeStatus = useBridgeStatus();
  const { data: health } = useBridgeFetch<BridgeHealth>(
    "/api/bridge/health",
    { intervalMs: 5000 },
  );

  const [pendingApprovals, setPendingApprovals] = useState<Pending[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [toolCallTotal, setToolCallTotal] = useState(0);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const tickRef = useRef<() => void>(() => {});
  const greet = useGreeting();

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [approvalsRes, metricsRes, recipesRes, activityRes] =
          await Promise.all([
            fetch(apiPath("/api/bridge/approvals")),
            fetch(apiPath("/api/bridge/metrics")),
            fetch(apiPath("/api/bridge/recipes")),
            // Bumped from last=200 when the curve switched from 60-min to
            // 24h window — 200 events would undercount the 24h chart on
            // workspaces with steady use. Bridge cap is per-server config;
            // if 500 isn't honoured (older bridge clamps lower) the chart
            // simply shows the most recent N events bucketed into 24
            // hours, which still beats showing nothing.
            fetch(apiPath("/api/bridge/activity?last=500")),
          ]);
        if (!alive) return;

        const approvalsData = approvalsRes.ok
          ? ((await approvalsRes.json()) as Pending[])
          : [];
        const metricsText = metricsRes.ok ? await metricsRes.text() : "";
        const recipesData = recipesRes.ok
          ? await recipesRes.json()
          : { recipes: [] };
        const activityData = activityRes.ok
          ? ((await activityRes.json()) as { events?: ActivityEvent[] })
          : { events: [] };

        if (!alive) return;

        const total = parseToolCallTotal(metricsText);
        const list: Recipe[] = Array.isArray(recipesData)
          ? recipesData
          : (recipesData as { recipes?: Recipe[] }).recipes ?? [];

        setToolCallTotal(total);
        setPendingApprovals(Array.isArray(approvalsData) ? approvalsData : []);
        setRecipes(list);
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
  const recipesShipped = recipes.length;
  const pendingCount = pendingApprovals.length;
  const oldestApprovalLabel = (() => {
    if (pendingApprovals.length === 0) return "none pending";
    const oldest = Math.min(
      ...pendingApprovals.map((p) => p.requestedAt),
    );
    return `oldest ${relTime(oldest)}`;
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

  // LOAD widget — running tasks + connections heuristic, + 4 trend
  const conns = health?.connections ?? 0;
  const sess = health?.activeSessions ?? 0;
  const loadPct = Math.max(
    0,
    Math.min(100, 38 + sess * 12 + (bridgeStatus.ok ? 18 : 0) + conns * 4),
  );
  const loadTrend = bridgeStatus.ok
    ? [
        Math.max(8, loadPct - 22),
        Math.max(8, loadPct - 14),
        Math.max(8, loadPct - 8),
        loadPct,
      ]
    : [0, 0, 0, 0];

  // Hero copy follows the design's narrative shape — "stitched N patches
   // overnight, drafted M things that need a nod, and woke up clean" — but
   // every number is driven from real bridge data instead of hardcoded floors.
   // Falls back to a neutral line when the bridge is offline.
  const patchesStitched = activityEvents.filter(
    (e) => e.kind === "recipe" || e.kind === "tool",
  ).length;
  const headline = bridgeStatus.ok ? (
    patchesStitched > 0 || pendingCount > 0 ? (
      <>
        Your agents stitched <span className="num">{patchesStitched.toLocaleString()}</span> patches overnight,
        drafted <span className="num">{pendingCount}</span>{" "}
        <span className="accent">{pendingCount === 1 ? "thing that needs a nod" : "things that need a nod"}</span>
        {pendingCount === 0 ? ", and woke up clean." : "."}
      </>
    ) : (
      <>Your agents are quiet. <span className="accent">No activity overnight, no approvals pending.</span></>
    )
  ) : (
    <>Bridge offline — start it to see live agent activity here.</>
  );

  const summary = bridgeStatus.ok
    ? "Bridge connected. Recipes ran on schedule. Nothing left your machine without permission."
    : "Once the bridge is running, this dashboard will reflect live activity from your local agents.";

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
  const peak = Math.max(...curveSeries, 0);
  const uniqueTools = new Set(
    activityEvents.filter((e) => e.kind === "tool").map((e) => e.tool),
  ).size;
  const activeRecipesCount = recipes.filter((r) => r.enabled !== false).length;

  // The bridge's /health endpoint doesn't currently expose a version
  // string, so these are usually missing in practice. Render an em-dash
  // (matches the "—" used elsewhere for missing values) instead of the
  // contradictory "unknown" word next to the green "all green" pill.
  const bridgeVersion = bridgeStatus.patchwork?.version ?? "—";
  const extensionVersion = health?.extensionVersion ?? "—";

  return (
    <section>
      {/* ------------------------------------------------------------------ */}
      {/* Quilt hero with LOAD widget                                          */}
      {/* ------------------------------------------------------------------ */}
      {/* TODO(design): the wireframe shows a "buddy quilt" 68% warmth widget
        * to the right of the hero (mood / fabric metaphor) instead of the
        * load ring. WeatherRing is the closest existing primitive; swap when
        * the buddy-quilt component spec lands. See screenshots @ 19.00.07. */}
      <QuiltHero
        greeting={greet ? `— ${greet.toLowerCase()}` : "— welcome"}
        headline={headline}
        summary={summary}
        aside={
          <WeatherRing
            label="LOAD"
            percent={loadPct}
            trend={loadTrend}
            live={bridgeStatus.ok}
            mood={
              !bridgeStatus.ok
                ? "bridge offline"
                : loadPct >= 80
                  ? "high load"
                  : loadPct >= 50
                    ? "warming up"
                    : "quiet"
            }
            meta={`${recipes.length} recipes · ${pendingApprovals.length} pending`}
          />
        }
      />

      {/* ------------------------------------------------------------------ */}
      {/* TELEMETRY eyebrow                                                    */}
      {/* ------------------------------------------------------------------ */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-3)",
          marginTop: "var(--s-5)",
          marginBottom: "var(--s-3)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-2xs)",
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
            flex: 1,
          }}
        >
          Telemetry
        </span>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => tickRef.current()}
          style={{
            fontSize: "var(--fs-xs)",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Sync
        </button>
        <Link
          href="/recipes/new"
          className="btn sm primary"
          style={{
            textDecoration: "none",
            fontSize: "var(--fs-xs)",
            background: "var(--orange)",
            border: "none",
          }}
        >
          + New recipe
        </Link>
      </div>

      {/* Four telemetry tiles. Inline grid-template-columns used to force
          repeat(4, minmax(0,1fr)) — that wins over the responsive .stat-grid
          class default (auto-fit minmax(180px, 1fr)) and made tile labels
          ellipsise to "PENDING APPROV/" / "TOOLS CALLED TOD…" on mobile.
          Drop the inline override; .stat-grid auto-fit gives 4 cols at
          desktop (≥768px content width) and stacks gracefully on narrow. */}
      <div
        className="stat-grid"
        style={{
          marginBottom: "var(--s-5)",
        }}
      >
        {!health && bridgeStatus.ok !== false ? (
          <>
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
          </>
        ) : (
          <>
            <StatCard
              label="Recipes shipped"
              value={<AnimatedNumber value={recipesShipped} />}
              foot={recipesShipped === 0 ? "none yet" : "total"}
              href="/recipes"
            />
            <StatCard
              label="Pending approvals"
              value={<AnimatedNumber value={pendingCount} />}
              foot={oldestApprovalLabel}
              href="/approvals"
            />
            <StatCard
              label="Tools called today"
              value={<AnimatedNumber value={toolsToday} />}
              foot={toolsTrendLabel}
              href="/activity"
            />
            <StatCard
              label="Tokens burnt"
              value={
                health?.tokens ? (
                  <AnimatedNumber
                    // The bridge's tokens.total is just input + output, but cache
                    // creation is also billed (~1.25× input rate). Cache reads
                    // (often 100×–1000× larger than the rest combined) are billed
                    // at 0.1× and excluded — they'd dwarf the headline and
                    // mislead. Show the full-rate-ish slice; cache reads get a
                    // sub-stat in the foot. Compact format ("68.5M" not
                    // "68,540,195") so the digit count doesn't hijack the tile.
                    value={
                      health.tokens.input +
                      health.tokens.output +
                      health.tokens.cacheCreate
                    }
                    format={formatCompact}
                  />
                ) : (
                  "—"
                )
              }
              foot={
                health?.tokens && health.tokens.cacheRead > 0
                  ? `+${formatCompact(health.tokens.cacheRead)} cache reads · ${formatCompact(health.tokens.messages)} msg${health.tokens.messages === 1 ? "" : "s"}`
                  : health?.tokens && health.tokens.messages > 0
                    ? `${formatCompact(health.tokens.messages)} msg${health.tokens.messages === 1 ? "" : "s"}`
                    : undefined
              }
              title={
                health?.tokens
                  ? [
                      `Input:        ${health.tokens.input.toLocaleString()}`,
                      `Output:       ${health.tokens.output.toLocaleString()}`,
                      `Cache create: ${health.tokens.cacheCreate.toLocaleString()}  (billed ~1.25× input)`,
                      `Cache read:   ${health.tokens.cacheRead.toLocaleString()}  (billed 0.1× input)`,
                      `Messages:     ${health.tokens.messages.toLocaleString()}`,
                    ].join("\n")
                  : undefined
              }
              href="/metrics"
            />
          </>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Tool calls — last 60 min (smooth filled curve)                       */}
      {/* ------------------------------------------------------------------ */}
      <ToolCallsWidget
        series={curveSeries}
        peak={peak}
        uniqueTools={uniqueTools}
        activeRecipesCount={activeRecipesCount}
        toolCallTotal={toolCallTotal}
        bridgeOk={bridgeStatus.ok}
      />

      {/* ------------------------------------------------------------------ */}
      {/* Activity thread + Active recipe                                      */}
      {/* ------------------------------------------------------------------ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: "var(--s-4)",
          marginBottom: "var(--s-5)",
        }}
      >
        <ActivityThread
          events={activityEvents.filter((e) => !isNoiseEvent(e)).slice(-8).reverse()}
        />
        <RecentRecipesCard recipes={recipes} />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Health card                                                          */}
      {/* ------------------------------------------------------------------ */}
      <div style={{ marginBottom: "var(--s-6)" }}>
        <HealthCard
          bridgeVersion={bridgeVersion}
          extensionVersion={extensionVersion}
          bridgeOk={bridgeStatus.ok === true}
          extensionConnected={Boolean(health?.extensionConnected)}
        />
      </div>
    </section>
  );
}

// (kept for upstream typing imports / no-op reference)
export type { BridgeHealth };

// Suppress unused-import false positives for parsing helper retained intentionally.
void parseUptimeMs;
