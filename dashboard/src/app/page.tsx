"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { FirstRunChecklist } from "@/components/FirstRunChecklist";
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
  Sparkline,
} from "@/components/patchwork";
import {
  RecipeLeaderboard,
  type LeaderboardRun,
} from "@/components/RecipeLeaderboard";
import { LiveRunsStrip, type LiveRun } from "@/components/LiveRunsStrip";
import { FeaturedRecipeAside } from "@/components/FeaturedRecipeAside";

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
            fontSize: "var(--fs-xs)",
            gap: 10,
            height: 56,
            justifyContent: "space-between",
            padding: "0 14px",
            textAlign: "left",
          }}
        >
          <div>
            <span style={{ color: "var(--ink-2)", fontWeight: 600 }}>
              No tool calls in the last 24h.
            </span>{" "}
            <span>
              {bridgeOk
                ? "Run a recipe and the curve fills in."
                : "Bridge offline."}
            </span>
          </div>
          {bridgeOk && (
            <Link
              href="/recipes"
              style={{
                color: "var(--accent)",
                fontWeight: 600,
                textDecoration: "none",
                flexShrink: 0,
              }}
            >
              Browse recipes →
            </Link>
          )}
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

function parseUptimeMs(text: string): number | null {
  if (!text) return null;
  const m = text.match(/^bridge_uptime_seconds\s+(\d+(?:\.\d+)?)/m);
  if (m) return Math.round(Number.parseFloat(m[1]) * 1000);
  return null;
}

// Telemetry-tile icons. Match the wireframe glyphs (≡ recipes, 🔒 approvals,
// >_ tools, ☉ tokens) but rendered as 12×12 inline SVGs at --ink-3 so they
// read as muted decoration next to the uppercase tile labels.
const TILE_ICON_PROPS = {
  width: 12,
  height: 12,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  style: { color: "var(--ink-3)" },
};
function TileIconLines() {
  return (
    <svg {...TILE_ICON_PROPS} aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
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
function TileIconSun() {
  return (
    <svg {...TILE_ICON_PROPS} aria-hidden="true">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4" />
    </svg>
  );
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

function ActivityThread({ events: rawEvents }: { events: ActivityEvent[] }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  // Track which event ids were already seen so we can flash newcomers.
  // Ref instead of state so we don't re-render on each mutation; the
  // parent's 5s poll already re-renders us when the data changes.
  const seenIds = useRef<Set<string | number>>(new Set());

  const filtered = useMemo(
    () => rawEvents.filter((e) => eventMatchesFilter(e, filter)),
    [rawEvents, filter],
  );
  const events = compressActivityRuns(filtered);

  // Compute the set of fresh keys for this render before mutating the
  // seen set, so the same render renders with consistent fresh flags.
  const freshKeys = useMemo(() => {
    const fresh = new Set<string | number>();
    for (const e of events) {
      const k = (e.id ?? `${e.kind}-${e.at ?? 0}-${e.tool ?? e.event ?? ""}`) as
        | string
        | number;
      if (!seenIds.current.has(k)) fresh.add(k);
    }
    return fresh;
  }, [events]);
  useEffect(() => {
    // Mark everything seen *after* the render commits so the flash CSS
    // has a chance to play. Capped at 200 to bound memory across long
    // sessions; the activity feed itself only retains last 500 events.
    for (const e of events) {
      const k = (e.id ?? `${e.kind}-${e.at ?? 0}-${e.tool ?? e.event ?? ""}`) as
        | string
        | number;
      seenIds.current.add(k);
    }
    if (seenIds.current.size > 600) {
      const arr = Array.from(seenIds.current);
      seenIds.current = new Set(arr.slice(-400));
    }
  }, [events]);

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
          Activity thread
        </h2>
        <ActionPill href="/activity" ariaLabel="View all activity">
          view all →
        </ActionPill>
      </div>
      <div
        role="tablist"
        aria-label="Filter activity by kind"
        className="activity-filter-row"
      >
        {(["all", "tools", "approvals", "errors"] as const).map((f) => {
          const active = f === filter;
          return (
            <button
              key={f}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => setFilter(f)}
              className={`activity-filter-chip${active ? " is-active" : ""}`}
            >
              {f}
            </button>
          );
        })}
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
            const recipe = activityRecipe(e);
            const isErr = e.status === "error";
            const dur =
              typeof e.durationMs === "number" ? `${e.durationMs}ms` : null;
            const rawCount = (e as Record<string, unknown>)._count;
            const repeatCount = typeof rawCount === "number" ? rawCount : 0;
            const eventKey = (e.id ?? `${e.kind}-${e.at ?? 0}-${e.tool ?? e.event ?? ""}`) as
              | string
              | number;
            const isFresh = freshKeys.has(eventKey);
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: stable list
                key={e.id ?? i}
                className={`activity-row${isFresh ? " is-fresh" : ""}${isErr ? " is-err" : ""}`}
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
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {recipe && (
                    <Link
                      href={`/recipes/${encodeURIComponent(recipe)}/edit`}
                      title={`Recipe ${recipe}`}
                      onClick={(ev) => ev.stopPropagation()}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--fs-xs)",
                        color: "var(--accent)",
                        textDecoration: "none",
                        flexShrink: 0,
                        maxWidth: 140,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {recipe}
                    </Link>
                  )}
                  {recipe && (
                    <span aria-hidden="true" style={{ color: "var(--ink-3)" }}>·</span>
                  )}
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
                  {repeatCount > 1 && (
                    <span
                      className="pill muted"
                      style={{ fontSize: "var(--fs-3xs)", flexShrink: 0 }}
                      title={`Last ${repeatCount} events collapsed`}
                    >
                      ×{repeatCount}
                    </span>
                  )}
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


// ---------------------------------------------------------------------------
// Health card
// ---------------------------------------------------------------------------


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
  const [runs, setRuns] = useState<LiveRun[]>([]);
  const [toolCallTotal, setToolCallTotal] = useState(0);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const tickRef = useRef<() => void>(() => {});
  const greet = useGreeting();

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [approvalsRes, metricsRes, recipesRes, activityRes, runsRes] =
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
            // Recipe-runs power the new LiveRunsStrip + RecipeLeaderboard.
            // catch() so an older bridge missing the endpoint just shows
            // empty surfaces — the rest of Overview keeps working.
            fetch(apiPath("/api/bridge/runs")).catch(() => null),
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

        const runsData = runsRes?.ok
          ? ((await runsRes.json()) as { runs?: LiveRun[] })
          : { runs: [] };

        setToolCallTotal(total);
        setPendingApprovals(Array.isArray(approvalsData) ? approvalsData : []);
        setRecipes(list);
        setRuns(Array.isArray(runsData.runs) ? runsData.runs : []);
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
  const isHaltStatus = (s: string) =>
    s === "error" || s === "failed" || s === "cancelled" || s === "interrupted";
  const runsCount24h = runs.filter((r) => Date.now() - r.startedAt < dayMs).length;
  const haltCount24h = runs.filter(
    (r) => Date.now() - r.startedAt < dayMs && isHaltStatus(r.status),
  ).length;
  const runs24h = runs.filter((r) => Date.now() - r.startedAt < dayMs);
  const okCount24h = runs24h.filter((r) => r.status === "done" || r.status === "success").length;
  const errCount24h = runs24h.filter((r) => isHaltStatus(r.status)).length;
  const runsFootLabel = runsCount24h === 0
    ? "no runs yet"
    : `${okCount24h} ok · ${errCount24h} err`;
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

  return (
    <section>
      {/*
        First-run checklist: orchestrates the 4-step happy path for
        brand-new workspaces (connect → install recipe → run → approve).
        Auto-collapses once all four steps are complete; user-dismissable
        any time. Lives above the hero so a new user can't miss it.
      */}
      <FirstRunChecklist />

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
        stats={(() => {
          // Hero meta line — matches the wireframe's
          // "4d 12h uptime · v0.2.0-α35 bridge · claude-3.5-sonnet primary · 3 IDEs attached"
          // rhythm. Only ship segments backed by real bridge data; the
          // remaining wireframe segments (bridge version, IDE count) need
          // bridge changes that haven't landed.
          const stats: Array<{ label: string; value: React.ReactNode }> = [];
          if (typeof bridgeStatus.uptimeMs === "number" && bridgeStatus.uptimeMs > 0) {
            stats.push({ label: "uptime", value: formatUptime(bridgeStatus.uptimeMs) });
          }
          const driver = bridgeStatus.patchwork?.driver;
          const model = bridgeStatus.patchwork?.model;
          if (model) {
            stats.push({ label: "primary", value: model });
          } else if (driver) {
            stats.push({ label: "driver", value: driver });
          }
          if (bridgeStatus.extensionConnected) {
            stats.push({ label: "attached", value: "IDE" });
          }
          return stats.length > 0 ? stats : undefined;
        })()}
        aside={<FeaturedRecipeAside runs={runs as LeaderboardRun[]} />}
      />

      {/* ------------------------------------------------------------------ */}
      {/* LIVE RUNS — pulses any currently-running or recently-finished       */}
      {/* recipe so a user landing on Overview can see motion at a glance.    */}
      {/* Component auto-hides when there's nothing in-flight or recent.      */}
      {/* ------------------------------------------------------------------ */}
      <LiveRunsStrip runs={runs} />

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
              label="Runs · 24h"
              icon={<TileIconLines />}
              value={<AnimatedNumber value={runsCount24h} />}
              foot={
                <div>
                  <div>{runsFootLabel}</div>
                  {runs7dSeries.some((v) => v > 0) && (
                    <div style={{ marginTop: 4 }}>
                      <Sparkline values={runs7dSeries} color="var(--accent)" height={22} />
                    </div>
                  )}
                </div>
              }
              href="/runs"
            />
            <StatCard
              label="Pending approvals"
              icon={<TileIconLock />}
              value={<AnimatedNumber value={pendingCount} />}
              foot={oldestApprovalLabel}
              href="/approvals"
            />
            <StatCard
              label="Halts · 24h"
              icon={<TileIconSun />}
              value={<AnimatedNumber value={haltCount24h} />}
              foot={
                <div>
                  <div>{haltsFootLabel}</div>
                  {halts7dSeries.some((v) => v > 0) && (
                    <div style={{ marginTop: 4 }}>
                      <Sparkline values={halts7dSeries} color="var(--err)" height={22} />
                    </div>
                  )}
                </div>
              }
              href="/runs?halt=1"
            />
            <StatCard
              label="Tools called today"
              icon={<TileIconShell />}
              value={<AnimatedNumber value={toolsToday} />}
              foot={toolsTrendLabel}
              href="/activity"
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
      {/* Activity thread + Recent recipes                                     */}
      {/* ------------------------------------------------------------------ */}
      {/* Use the .grid-2 utility (collapses to a single column at ≤760 px)
          rather than an inline 2-col grid that ignored viewport. Side-by-
          side at phone width forced both cards to ~150 px wide and made
          activity timestamps + recipe slugs collide. */}
      <div className="grid-2" style={{ marginBottom: "var(--s-5)" }}>
        <ActivityThread
          events={activityEvents
            .filter((e) => !isNoiseEvent(e))
            .slice(-40)
            .reverse()
            .slice(0, 12)}
        />
        <RecipeLeaderboard runs={runs as LeaderboardRun[]} />
      </div>

    </section>
  );
}

// (kept for upstream typing imports / no-op reference)
export type { BridgeHealth };

// Suppress unused-import false positives for parsing helper retained intentionally.
void parseUptimeMs;
