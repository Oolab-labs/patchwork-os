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
import { isHaltStatus } from "@/lib/runStatus";
import {
  ActionPill,
  AnimatedNumber,
  AreaChart,
  EntityTimeline,
  LivePill,
  QuiltHero,
  Sparkline,
  type TimelineEvent,
} from "@/components/patchwork";
import { RecipeChip, ToolChip } from "@/components/patchwork/entity";
import { canonicalRecipeKey } from "@/lib/entityKey";
import {
  RecipeLeaderboard,
  type LeaderboardRun,
} from "@/components/RecipeLeaderboard";
import { LiveRunsStrip, type LiveRun } from "@/components/LiveRunsStrip";
import { LiveWire } from "@/components/LiveWire";
import { FeaturedRecipeAside } from "@/components/FeaturedRecipeAside";

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
  const hasActivity = peak > 0 || total > 0;
  return (
    <div className="card tool-calls-card">
      <div className="tcw-header">
        <span className="stat-tile-icon stat-tile-icon--tools" aria-hidden="true">
          <TileIconShell />
        </span>
        <span className="card-h2">Tool calls — last 24 hours</span>
        {hasActivity && (
          <span
            className="pw-live-dot"
            aria-label="Live"
            title="Live data"
            style={{ marginRight: 4 }}
          />
        )}
        <LivePill connection={hasActivity ? "live" : "offline"} />
      </div>
      <div className="tcw-meta">
        {hasActivity
          ? <>peak {peak}/hour · {uniqueTools} unique tool{uniqueTools !== 1 ? "s" : ""} · {activeRecipesCount} recipe{activeRecipesCount !== 1 ? "s" : ""}</>
          : <>{activeRecipesCount} recipe{activeRecipesCount !== 1 ? "s" : ""} · no calls in 24h</>
        }
      </div>
      {hasActivity ? (
        <AreaChart
          series={[{ values: series, color: "var(--info)" }]}
          height={120}
          minimal
        />
      ) : (
        <div role="status" className="tcw-empty">
          <div>
            <span className="tcw-empty-msg">No tool calls in the last 24h.</span>{" "}
            <span>
              {bridgeOk
                ? "Run a recipe and the curve fills in."
                : "Bridge offline."}
            </span>
          </div>
          {bridgeOk && (
            <Link href="/recipes" className="tcw-empty-link">
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
    <div className="card card--pg">
      <div className="card-hd">
        <h2 className="card-h2">Activity thread</h2>
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
        <div className="atd-empty" style={{ animation: "pw-fade-in 0.3s ease both" }}>
          <div style={{ fontSize: 28, marginBottom: 6, opacity: 0.35 }} aria-hidden="true">⚡</div>
          <div className="atd-empty-title">No recent events.</div>
          <div className="atd-empty-body">
            Tool calls and lifecycle events from connected agents will
            appear here in real time.
          </div>
          <Link
            href="/activity"
            style={{
              display: "inline-block",
              marginTop: 10,
              fontSize: "var(--fs-xs)",
              color: "var(--accent)",
              textDecoration: "none",
              fontWeight: 500,
              transition: "opacity 0.15s ease",
            }}
          >
            View full activity log →
          </Link>
        </div>
      ) : (
        <div className="atd-stream">
          {/* vertical rail */}
          <div className="activity-rail" aria-hidden="true" />
          {events.map((e, i) => {
            const ts = e.at ?? Date.now();
            const tool = activityLabel(e);
            const kind = activityKind(e);
            const recipe = activityRecipe(e);
            const isErr = e.status === "error";
            const rawDurMs = e.durationMs;
            const dur = typeof rawDurMs === "number"
              ? rawDurMs >= 1000
                ? `${(rawDurMs / 1000).toFixed(1)}s`
                : `${rawDurMs}ms`
              : null;
            const rawCount = (e as Record<string, unknown>)._count;
            const repeatCount = typeof rawCount === "number" ? rawCount : 0;
            const eventKey = (e.id ?? `${e.kind}-${e.at ?? 0}-${e.tool ?? e.event ?? ""}`) as
              | string
              | number;
            const isFresh = freshKeys.has(eventKey);
            const kindPillClass = e.kind === "lifecycle"
              ? /rejected|error|halt/i.test(e.event ?? "") ? "err"
                : /done|success|complet/i.test(e.event ?? "") ? "ok"
                : /start|session/i.test(e.event ?? "") ? "info"
                : "muted"
              : "muted";
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: stable list
                key={e.id ?? i}
                className={`activity-row${isFresh ? " is-fresh" : ""}${isErr ? " is-err" : ""}`}
                style={{
                  animation: "pw-slide-up 0.25s ease both",
                  animationDelay: `${Math.min(i * 35, 350)}ms`,
                }}
              >
                <span
                  aria-hidden="true"
                  className="activity-dot"
                  data-err={isErr ? "true" : undefined}
                  data-tone={
                    e.kind === "lifecycle" && !isErr && kindPillClass !== "muted"
                      ? kindPillClass
                      : undefined
                  }
                />
                <span className="activity-ts">{relTime(ts)}</span>
                <span className="activity-content">
                  {recipe && (
                    <RecipeChip
                      name={recipe}
                      variant="row"
                    />
                  )}
                  {recipe && (
                    <span aria-hidden="true" className="muted">·</span>
                  )}
                  {e.kind === "tool" && e.tool ? (
                    <ToolChip name={e.tool} variant="row" />
                  ) : (
                    <span className="activity-tool-name">{tool}</span>
                  )}
                  {repeatCount > 1 && (
                    <span
                      className="pill muted xs"
                      title={`Last ${repeatCount} events collapsed`}
                    >
                      ×{repeatCount}
                    </span>
                  )}
                </span>
                <span className={`pill ${kindPillClass} xs`}>{kind}</span>
                {dur && <span className="activity-dur">{dur}</span>}
                {(e.kind === "tool" || isErr) && (
                  <span className={`pill ${isErr ? "err" : "ok"} xs`}>
                    {isErr ? "err" : "ok"}
                  </span>
                )}
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
// Needs-attention band
// ---------------------------------------------------------------------------

/**
 * Mission-control attention band.
 *
 * Shows three signals: pending approvals, halted runs in last 24h, and
 * error-status runs in last 24h. Each is a clickable chip that deep-links
 * into the relevant filtered surface. When all three are zero we render a
 * calm "all clear" state instead of an empty card — the card always
 * provides value (either "action needed" or "nothing broken").
 *
 * Deep-link verification:
 *  - /approvals         — no filter needed, approvals page shows all pending
 *  - /runs?halt=1       — runs/page.tsx reads searchParams.get("halt") === "1"
 *  - /runs?status=error — runs/page.tsx reads searchParams.get("status") but
 *                         the filter is named differently; use /runs?halt=1
 *                         for halts and /runs unfiltered for general errors
 *  - /activity          — activity/page.tsx is unfiltered entry point
 */
function NeedsAttentionBand({
  pendingCount,
  haltCount24h,
  failingCount24h,
  bridgeOk,
}: {
  pendingCount: number;
  haltCount24h: number;
  failingCount24h: number;
  bridgeOk: boolean;
}) {
  const items = [
    pendingCount > 0 && {
      count: pendingCount,
      label: pendingCount === 1 ? "approval pending" : "approvals pending",
      href: "/approvals",
      urgent: true,
    },
    haltCount24h > 0 && {
      count: haltCount24h,
      label: haltCount24h === 1 ? "halt · 24h" : "halts · 24h",
      href: "/runs?halt=1",
      urgent: false,
    },
    failingCount24h > 0 && {
      count: failingCount24h,
      label: failingCount24h === 1 ? "run failed · 24h" : "runs failed · 24h",
      href: "/runs?window=24h",
      urgent: false,
    },
  ].filter(Boolean) as Array<{ count: number; label: string; href: string; urgent: boolean }>;

  const allClear = items.length === 0;

  if (!bridgeOk) {
    return (
      <div className="attention-offline">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--err)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>
          <strong className="attention-offline-label">Bridge offline</strong>
          {" — connect to see agent status. "}
          <Link href="/connections" className="attention-offline-link">
            Check connections →
          </Link>
        </span>
      </div>
    );
  }

  if (allClear) {
    return (
      <div className="attention-clear">
        <div className="attention-clear-ring" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="attention-clear-ok">All clear</span>
          <span
            className="pw-live-dot"
            aria-label="All systems healthy"
            title="No issues detected"
          />
          <span className="attention-clear-sub">
            No approvals pending · no halts · no failures
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="attention-band">
      <span className="attention-band-label">Needs attention</span>
      <div className="attention-chips">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`attention-chip ${item.urgent ? "attention-chip--urgent" : "attention-chip--warn"}`}
            aria-label={`${item.count} ${item.label} — view all`}
          >
            <span className="attention-chip-count">{item.count}</span>
            <span className="attention-chip-label">{item.label}</span>
            <span className="attention-chip-arrow" aria-hidden="true">→</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unified activity timeline (EntityTimeline-based)
// ---------------------------------------------------------------------------

/**
 * Reshapes recent runs + pending approvals into TimelineEvent[] for
 * EntityTimeline. Merges and sorts newest-first; each item links out.
 *
 * Uses runs data (already fetched) and pendingApprovals. No new endpoints.
 */
function buildTimelineEvents(
  runs: LiveRun[],
  approvals: Pending[],
  activityEvents: ActivityEvent[],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // Recent runs (capped at 8)
  const recentRuns = [...runs]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 8);
  for (const r of recentRuns) {
    events.push({
      id: `run-${r.seq}`,
      kind: "run",
      timestamp: r.startedAt,
      label: r.recipeName ?? `run #${r.seq}`,
      status: r.status,
      meta: {
        seq: r.seq,
        recipeName: r.recipeName,
        hadStepErrors: r.hadStepErrors,
      },
    });
  }

  // Pending approvals
  for (const ap of approvals.slice(0, 4)) {
    events.push({
      id: `approval-${ap.callId}`,
      kind: "approval",
      timestamp: ap.requestedAt,
      label: ap.summary ?? ap.toolName,
      status: "pending",
      meta: {
        callId: ap.callId,
        decision: "pending",
      },
    });
  }

  // Supplement with a few recent activity events that aren't covered by runs
  const activitySlice = activityEvents
    .filter((e) => e.kind === "lifecycle" && e.event === "approval_decision")
    .slice(0, 3);
  for (const e of activitySlice) {
    const callId = (e.metadata as Record<string, unknown>)?.callId as string | undefined;
    if (!callId) continue;
    // Don't duplicate an already-present pending approval
    if (events.some((ev) => ev.id === `approval-${callId}`)) continue;
    events.push({
      id: `act-${e.id ?? e.at}`,
      kind: "approval",
      timestamp: e.at ?? Date.now(),
      label: (e.metadata as Record<string, unknown>)?.decision as string ?? "decision",
      meta: {
        callId,
        decision: (e.metadata as Record<string, unknown>)?.decision as string,
      },
    });
  }

  return events.sort((a, b) => b.timestamp - a.timestamp).slice(0, 15);
}

// ---------------------------------------------------------------------------
// Recipes-at-a-glance strip
// ---------------------------------------------------------------------------

/**
 * Top recipes by recent activity. Each links to /runs?recipe=<name>.
 * Uses the runs data already fetched — no new endpoint.
 */
function RecipesAtAGlance({ runs }: { runs: LiveRun[] }) {
  const dayMs = 24 * 60 * 60 * 1000;
  const recipeMap = new Map<string, { count: number; lastAt: number; hasHalt: boolean }>();
  for (const r of runs) {
    if (!r.recipeName) continue;
    const key = canonicalRecipeKey(r.recipeName);
    const existing = recipeMap.get(key) ?? { count: 0, lastAt: 0, hasHalt: false };
    recipeMap.set(key, {
      count: existing.count + 1,
      lastAt: Math.max(existing.lastAt, r.startedAt),
      hasHalt: existing.hasHalt || isHaltStatus(r.status),
    });
  }
  const sorted = Array.from(recipeMap.entries())
    .filter(([, v]) => Date.now() - v.lastAt < 7 * dayMs)
    .sort(([, a], [, b]) => b.lastAt - a.lastAt)
    .slice(0, 6);

  if (sorted.length === 0) return null;

  return (
    <div className="card card--pg mb-5">
      <div className="card-hd">
        <h2 className="card-h2">Recent recipes</h2>
        <ActionPill href="/recipes" ariaLabel="View all recipes">
          view all →
        </ActionPill>
      </div>
      <div className="rag-list">
        {sorted.map(([name, stats], idx) => {
          return (
            <Link
              key={name}
              href={`/runs?recipe=${encodeURIComponent(name)}`}
              className="rag-row row-hover"
              style={{ animationDelay: `${idx * 50}ms` }}
            >
              <span className="rag-name">{name}</span>
              <span className="rag-count rag-time">{relTime(stats.lastAt)}</span>
              <span aria-hidden="true" className="rag-sep">·</span>
              <span className="rag-count">{stats.count} run{stats.count !== 1 ? "s" : ""}</span>
              {stats.hasHalt && (
                <span className="pill err xs">halted</span>
              )}
            </Link>
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
  const runsCount24h = runs.filter((r) => Date.now() - r.startedAt < dayMs).length;
  const haltCount24h = runs.filter(
    (r) => Date.now() - r.startedAt < dayMs && isHaltStatus(r.status),
  ).length;
  const runs24h = runs.filter((r) => Date.now() - r.startedAt < dayMs);
  const errCount24h = runs24h.filter((r) => isHaltStatus(r.status)).length;
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

  // Hero copy follows the design's narrative shape — "stitched N patches
   // overnight, drafted M things that need a nod, and woke up clean" — but
   // every number is driven from real bridge data instead of hardcoded floors.
   // Falls back to a neutral line when the bridge is offline.
  const patchesStitched = activityEvents.filter(
    (e) => e.kind === "recipe" || e.kind === "tool",
  ).length;
  const headline = bridgeStatus.ok ? (
    patchesStitched > 0 && pendingCount > 0 ? (
      <>
        Your agents stitched{" "}
        <span className="num">{patchesStitched.toLocaleString()}</span>{" "}
        {patchesStitched === 1 ? "patch" : "patches"} overnight, drafted{" "}
        <span className="num">{pendingCount}</span>{" "}
        <span className="accent">
          {pendingCount === 1 ? "thing that needs a nod." : "things that need a nod."}
        </span>
      </>
    ) : patchesStitched > 0 ? (
      <>
        Your agents stitched{" "}
        <span className="num">{patchesStitched.toLocaleString()}</span>{" "}
        {patchesStitched === 1 ? "patch" : "patches"} overnight,{" "}
        <span className="accent">and woke up clean.</span>
      </>
    ) : pendingCount > 0 ? (
      <>
        Your agents drafted{" "}
        <span className="num">{pendingCount}</span>{" "}
        <span className="accent">
          {pendingCount === 1 ? "thing that needs a nod." : "things that need a nod."}
        </span>
      </>
    ) : (
      <>Your agents are quiet. <span className="accent">No activity overnight, no approvals pending.</span></>
    )
  ) : (
    <>Bridge offline — start it to see live agent activity here.</>
  );

  const summary = !bridgeStatus.ok
    ? "Once the bridge is running, this dashboard will reflect live activity from your local agents."
    : runsCount24h === 0
      ? "Bridge connected. No recipe runs in the last 24h."
      : haltCount24h > 0
        ? `Bridge connected. ${runsCount24h} run${runsCount24h !== 1 ? "s" : ""} in 24h — ${haltCount24h} halted.`
        : `Bridge connected. ${runsCount24h} run${runsCount24h !== 1 ? "s" : ""} ran clean in the last 24h.`;

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
      {/* Kill-switch banner rendered globally by Shell — was duplicated here. */}
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
      {/* NEEDS ATTENTION — mission-control band: pending approvals, halts,  */}
      {/* and errors. Zero state renders "all clear". Every chip links out.   */}
      {/* ------------------------------------------------------------------ */}
      <NeedsAttentionBand
        pendingCount={pendingCount}
        haltCount24h={haltCount24h}
        failingCount24h={errCount24h}
        bridgeOk={bridgeStatus.ok === true}
      />

      {/* ------------------------------------------------------------------ */}
      {/* LIVE WIRE — always-present 1-row heartbeat ("● 2 running · last    */}
      {/* finished 4m ago"). Pairs with LiveRunsStrip below, which only shows */}
      {/* when there's something in flight or just-finished — keeps the page */}
      {/* feeling alive even during quiet stretches.                          */}
      {/* ------------------------------------------------------------------ */}
      <LiveWire runs={runs} bridgeOk={bridgeStatus.ok === true} />

      {/* ------------------------------------------------------------------ */}
      {/* LIVE RUNS — pulses any currently-running or recently-finished       */}
      {/* recipe so a user landing on Overview can see motion at a glance.    */}
      {/* Component auto-hides when there's nothing in-flight or recent.      */}
      {/* ------------------------------------------------------------------ */}
      <LiveRunsStrip runs={runs} />

      {/* ------------------------------------------------------------------ */}
      {/* TELEMETRY eyebrow                                                    */}
      {/* ------------------------------------------------------------------ */}
      <div className="pg-section-head" style={{ animation: "pw-fade-in 0.4s ease both" }}>
        <span
          className="pg-section-head-label"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 3,
              height: 14,
              borderRadius: 2,
              background: "var(--accent)",
              flexShrink: 0,
            }}
          />
          Telemetry
        </span>
        <div className="pg-section-head-rule" aria-hidden="true" />
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => tickRef.current()}
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
                icon={<span className="stat-tile-icon stat-tile-icon--runs"><TileIconLines /></span>}
                value={<AnimatedNumber value={runsCount24h} />}
                foot={
                  <div>
                    <div>{runsFootLabel}</div>
                    {runs7dSeries.some((v) => v > 0) && (
                      <div className="mt-1">
                        <Sparkline
                          values={runs7dSeries}
                          color="var(--accent)"
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
                icon={<span className="stat-tile-icon stat-tile-icon--approvals"><TileIconLock /></span>}
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
                icon={<span className="stat-tile-icon stat-tile-icon--halts"><TileIconSun /></span>}
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
              <StatCard
                label="Tools called today"
                className="stat-card--tools"
                icon={<span className="stat-tile-icon stat-tile-icon--tools"><TileIconShell /></span>}
                value={<AnimatedNumber value={toolsToday} />}
                foot={
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {toolsToday > 0 && (
                      <span className="pw-live-dot" aria-label="Active today" />
                    )}
                    {toolsTrendLabel}
                  </div>
                }
                href="/activity"
              />
            </div>
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
      {/* Activity thread + Recipes at a glance                               */}
      {/* ------------------------------------------------------------------ */}
      <div className="pg-section-head" style={{ animation: "pw-fade-in 0.4s ease both" }}>
        <span
          className="pg-section-head-label"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 3,
              height: 14,
              borderRadius: 2,
              background: "var(--accent)",
              flexShrink: 0,
            }}
          />
          Activity
        </span>
        <div className="pg-section-head-rule" aria-hidden="true" />
        <Link href="/activity" className="btn sm ghost">view all →</Link>
      </div>
      <div className="grid-2 mb-5">
        {/* Left col: unified entity timeline (runs + approvals) */}
        <div className="card card--pg">
          <div className="card-hd">
            <h2 className="card-h2">Activity stream</h2>
            <ActionPill href="/activity" ariaLabel="View all activity">
              view all →
            </ActionPill>
          </div>
          <EntityTimeline
            events={buildTimelineEvents(runs, pendingApprovals, activityEvents)}
            ariaLabel="Recent runs and approvals"
          />
        </div>
        {/* Right col: classic activity thread for tool-level detail */}
        <ActivityThread
          events={activityEvents
            .filter((e) => !isNoiseEvent(e))
            .slice(-40)
            .reverse()
            .slice(0, 12)}
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Recipes at a glance — top 6 by run count over last 7 days           */}
      {/* Each row links to /runs?recipe=<name> (param honored by runs/page) */}
      {/* ------------------------------------------------------------------ */}
      <div className="pg-section-head" style={{ animation: "pw-fade-in 0.4s ease both" }}>
        <span
          className="pg-section-head-label"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 3,
              height: 14,
              borderRadius: 2,
              background: "var(--accent)",
              flexShrink: 0,
            }}
          />
          Recipes
        </span>
        <div className="pg-section-head-rule" aria-hidden="true" />
        <Link href="/recipes" className="btn sm ghost">view all →</Link>
      </div>
      <RecipesAtAGlance runs={runs} />

      {/* Recipe leaderboard — detailed health view */}
      <RecipeLeaderboard runs={runs as LeaderboardRun[]} />

    </section>
  );
}

// (kept for upstream typing imports / no-op reference)
export type { BridgeHealth };
