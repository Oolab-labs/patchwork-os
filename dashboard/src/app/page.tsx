"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { bandSeverity, buildAttentionItems } from "@/lib/attention";
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
  QuiltHero,
  Sparkline,
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
  const items = buildAttentionItems({ pendingCount, haltCount24h, failingCount24h });

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
    <div className="attention-band" data-severity={bandSeverity(items)}>
      <span className="attention-band-label">Needs attention</span>
      <div className="attention-chips">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`attention-chip attention-chip--${item.severity}`}
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
// Recipes kanban (Draft / Paused / Active) — Framley/Kilo style
// ---------------------------------------------------------------------------

/** Derive stable pastel avatar colour from recipe name. */
function ragColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  // Yellow-green hues (40–200) read brighter to the eye; cap their lightness
  // lower so white initials clear ~5.2:1 across all hues (facelift P3-13).
  const lightness = hue >= 40 && hue <= 200 ? 28 : 34;
  return `hsl(${hue}, 55%, ${lightness}%)`;
}

/** Up to 2 uppercase initials from a recipe name. */
function ragInitials(name: string): string {
  const parts = name.replace(/[-_./]/g, " ").split(" ").filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Human-readable display name (capitalised, dashes→spaces). */
function ragDisplayName(name: string): string {
  return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Short role text per column. */
function ragRole(
  kind: "draft" | "paused" | "active",
  name: string,
  runCount: number,
  hasHalt: boolean,
): string {
  if (kind === "draft") return "No recent runs";
  if (kind === "paused") return "Paused";
  if (hasHalt) return `${runCount} run${runCount !== 1 ? "s" : ""} · halted`;
  return `${runCount} run${runCount !== 1 ? "s" : ""}`;
}

/** Tag from last segment of recipe name for category chip. */
function ragTag(name: string): string {
  const n = name.toLowerCase();
  if (/tweet|twitter|social/.test(n)) return "SOCIAL";
  if (/github|commit|pull.?req|code.?review|pr.?review/.test(n)) return "GITHUB";
  if (/gmail|email|inbox|mail/.test(n)) return "EMAIL";
  if (/slack/.test(n)) return "SLACK";
  if (/linear/.test(n)) return "LINEAR";
  if (/notion/.test(n)) return "NOTION";
  if (/health|monitor|check|alert|watch|status/.test(n)) return "OPS";
  if (/snapshot|compact|compac/.test(n)) return "OPS";
  if (/daily|morning|weekly|hourly|schedule|cron/.test(n)) return "CRON";
  if (/journal|diary|ambient|note|memo/.test(n)) return "NOTES";
  if (/report|digest|summary|brief/.test(n)) return "REPORT";
  if (/test|debug|ci|build/.test(n)) return "CI";
  if (/customer|support|ticket|escalat/.test(n)) return "SUPPORT";
  if (/secur|auth/.test(n)) return "SECURITY";
  if (/usage|analytic|metric/.test(n)) return "ANALYTICS";
  if (/deploy|release|infra/.test(n)) return "DEVOPS";
  if (/sync|mirror|replicate|backup/.test(n)) return "SYNC";
  if (/webhook|event|trigger/.test(n)) return "EVENTS";
  const first = name.replace(/[-_]/g, " ").split(/\s+/).find(w => w.length > 2) ?? "RECIPE";
  return first.slice(0, 9).toUpperCase();
}
function tagColorClass(tag: string): string {
  switch (tag) {
    case "OPS": case "CI": case "DEVOPS": case "SECURITY": return "rag3-chip--tag-blue";
    case "CRON": case "SCHEDULE": case "EVENTS": case "SYNC": return "rag3-chip--tag-purple";
    case "SOCIAL": case "MARKETING": return "rag3-chip--tag-pink";
    case "NOTES": case "DOCS": case "REPORT": return "rag3-chip--tag-slate";
    case "SUPPORT": case "INBOX": return "rag3-chip--tag-amber";
    case "GITHUB": case "LINEAR": case "NOTION": case "ANALYTICS": return "rag3-chip--tag-teal";
    case "EMAIL": case "SLACK": return "rag3-chip--tag-indigo";
    default: return "";
  }
}

/** Calendar icon inline. */
function RagCalIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="1" y="2" width="12" height="11" rx="2" />
      <path d="M1 6h12M5 1v2M9 1v2" />
    </svg>
  );
}

/** Ring/ok-rate icon inline. */
function RagRingIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="7" cy="7" r="5" />
    </svg>
  );
}

/** Column status icon */
function RagColIcon({ kind }: { kind: "draft" | "paused" | "active" }) {
  if (kind === "active") return (
    <svg width="10" height="10" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <polygon points="3,1 13,7 3,13" />
    </svg>
  );
  if (kind === "paused") return (
    <svg width="10" height="10" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <rect x="2" y="1" width="3.5" height="12" rx="1"/><rect x="8.5" y="1" width="3.5" height="12" rx="1"/>
    </svg>
  );
  // draft — circle
  return (
    <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="7" cy="7" r="5" />
    </svg>
  );
}

/**
 * Framley/Kilo-style three-column recipe kanban.
 * Draft | Paused | Active — each card shows avatar initials, name, run summary, and chips.
 */
function RecipesAtAGlance({
  runs,
  recipes,
}: {
  runs: LiveRun[];
  recipes: Recipe[];
}) {
  const { run: runRecipe, pending: runPending } = useRunRecipe();
  const dayMs = 24 * 60 * 60 * 1000;

  const runMap = new Map<string, { count: number; ok: number; lastAt: number; hasHalt: boolean }>();
  for (const r of runs) {
    if (!r.recipeName) continue;
    const key = canonicalRecipeKey(r.recipeName);
    const e = runMap.get(key) ?? { count: 0, ok: 0, lastAt: 0, hasHalt: false };
    const isOk = r.status === "done" || r.status === "success";
    runMap.set(key, {
      count: e.count + 1,
      ok: e.ok + (isOk ? 1 : 0),
      lastAt: Math.max(e.lastAt, r.startedAt),
      hasHalt: e.hasHalt || isHaltStatus(r.status),
    });
  }

  const draft: Recipe[] = [];
  const paused: Recipe[] = [];
  const active: Recipe[] = [];

  for (const recipe of recipes) {
    if (recipe.enabled === false) {
      paused.push(recipe);
    } else {
      const s = runMap.get(canonicalRecipeKey(recipe.name));
      if (s && Date.now() - s.lastAt < 7 * dayMs) active.push(recipe);
      else draft.push(recipe);
    }
  }
  active.sort((a, b) => {
    const as = runMap.get(canonicalRecipeKey(a.name));
    const bs = runMap.get(canonicalRecipeKey(b.name));
    return (bs?.lastAt ?? 0) - (as?.lastAt ?? 0);
  });

  const cols = [
    { kind: "draft"  as const, label: "Draft",  items: draft  },
    { kind: "paused" as const, label: "Paused", items: paused },
    { kind: "active" as const, label: "Active", items: active },
  ];

  const defaultTab = active.length > 0 ? "active" : draft.length > 0 ? "draft" : "paused";
  // Hook must be above the early return to satisfy Rules of Hooks
  const [activeTab, setActiveTab] = useState<"draft" | "paused" | "active">(defaultTab);

  if (recipes.length === 0) return null;

  return (
    <div className="card card--pg mb-5">
      {/* Section header row */}
      <div className="rag3-hd">
        <h2 className="rag3-title">
          Your Recipes
          <span className="rag3-title-count">{recipes.length}</span>
        </h2>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <Link href="/recipes" className="btn sm ghost">View all</Link>
          <Link href="/recipes/new" className="btn sm primary">+ New</Link>
        </div>
      </div>

      {/* Mobile tab strip — hidden on desktop via CSS */}
      <div className="rag3-tabs">
        {cols.map(({ kind, label, items }) => (
          <button
            key={kind}
            type="button"
            className={`rag3-tab${activeTab === kind ? " rag3-tab--active" : ""}`}
            onClick={() => setActiveTab(kind)}
          >
            {label}
            <span className="rag3-tab-count">{items.length}</span>
          </button>
        ))}
      </div>

      {/* Three-column kanban */}
      <div className="rag3-grid" data-active-tab={activeTab}>
        {cols.map(({ kind, label, items }) => (
          <div key={kind} className="rag3-col" data-kind={kind}>
            {/* Column header */}
            <div className="rag3-col-hd">
              <span className={`rag3-col-icon rag3-col-icon--${kind}`}>
                <RagColIcon kind={kind} />
              </span>
              <span className="rag3-col-label">{label}</span>
              <span className="rag3-col-count">{items.length}</span>
              <Link
                href={`/recipes/new?status=${kind}`}
                className="rag3-col-add"
                aria-label={`New ${label.toLowerCase()} recipe`}
                title={`New ${label.toLowerCase()} recipe`}
              >
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="7" y1="1" x2="7" y2="13"/><line x1="1" y1="7" x2="13" y2="7"/>
                </svg>
              </Link>
            </div>

            {/* Card stack */}
            <div className="rag3-cards">
              {items.length === 0 && (
                <p className="rag3-empty">No recipes here</p>
              )}
              {items.slice(0, 6).map((recipe) => {
                const stats = runMap.get(canonicalRecipeKey(recipe.name));
                const refDate = stats?.lastAt ?? recipe.installedAt;
                const dateLabel = refDate
                  ? (() => {
                      const d = new Date(refDate);
                      const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                      return `${d.getDate()} ${M[d.getMonth()]}`.toUpperCase();
                    })()
                  : null;
                const roleText = ragRole(kind, recipe.name, stats?.count ?? 0, stats?.hasHalt ?? false);
                const isQueueing = Boolean(runPending[canonicalRecipeKey(recipe.name)]);

                return (
                  <div key={recipe.name} className={`rag3-card rag3-card--${kind}`}>
                    <Link
                      href={`/recipes/${encodeURIComponent(recipe.name)}/edit`}
                      className="rag3-card-link"
                    >
                      <div className="rag3-card-top">
                        <span className="rag3-avatar" style={{ background: ragColor(recipe.name) }} aria-hidden="true">
                          {ragInitials(recipe.name)}
                        </span>
                        <div className="rag3-card-info">
                          <div className="rag3-card-name" title={ragDisplayName(recipe.name)}>{ragDisplayName(recipe.name)}</div>
                          <div className="rag3-card-role">{roleText}</div>
                        </div>
                      </div>
                      <div className="rag3-card-chips">
                        {dateLabel && (
                          <span className="rag3-chip">
                            <RagCalIcon />{dateLabel}
                          </span>
                        )}
                        {stats && (
                          <span className="rag3-chip">
                            <RagRingIcon />{stats.ok}/{stats.count}
                          </span>
                        )}
                        {(() => { const t = ragTag(recipe.name); return <span className={`rag3-chip rag3-chip--tag ${tagColorClass(t)}`}>{t}</span>; })()}
                      </div>
                    </Link>
                    {kind === "active" && (
                      <button
                        type="button"
                        className="rag3-card-run"
                        aria-label={`Run ${ragDisplayName(recipe.name)} now`}
                        title={`Run ${ragDisplayName(recipe.name)}`}
                        disabled={isQueueing}
                        onClick={(e) => { e.preventDefault(); void runRecipe(canonicalRecipeKey(recipe.name)); }}
                      >
                        {isQueueing ? "…" : "▶"}
                      </button>
                    )}
                  </div>
                );
              })}
              {items.length > 6 && (
                <Link href="/recipes" className="rag3-more">
                  +{items.length - 6} more
                </Link>
              )}
            </div>
          </div>
        ))}
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
  const [syncSpinning, setSyncSpinning] = useState(false);
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
                icon={<span className="stat-tile-icon stat-tile-icon--runs" style={{ color: "var(--accent)" }}><TileIconPlay /></span>}
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
              {(() => {
                const toolsDelta = (() => {
                  const m = toolsTrendLabel.match(/([+-]\d+)%/);
                  return m ? m[1] + "%" : undefined;
                })();
                return (
                  <StatCard
                    label="Tools called today"
                    className="stat-card--tools"
                    icon={<span className="stat-tile-icon stat-tile-icon--tools" style={{ color: "var(--accent-cool)" }}><TileIconShell /></span>}
                    value={<AnimatedNumber value={toolsToday} />}
                    delta={toolsDelta}
                    foot={
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {toolsToday > 0 && (
                            <span className="pw-live-dot" aria-label="Active today" />
                          )}
                        </div>
                        {curveSeries.some((v) => v > 0) && (
                          <div className="mt-1">
                            <Sparkline
                              values={curveSeries}
                              color="var(--accent-cool)"
                              height={22}
                            />
                          </div>
                        )}
                      </div>
                    }
                    href="/activity"
                  />
                );
              })()}
            </div>
          </>
        )}
      </div>
      </>}

      {/* ------------------------------------------------------------------ */}
      {/* Recipes at a glance — top 6 by run count over last 7 days           */}
      {/* Each row links to /runs?recipe=<name> (param honored by runs/page) */}
      {/* ------------------------------------------------------------------ */}
      <div className="pg-section-head" style={{ animation: "pw-fade-in 0.4s ease both" }}>
        <span className="pg-section-head-label">
          <span aria-hidden="true" className="pg-section-head-bar" />
          Recipes
        </span>
        <div className="pg-section-head-rule" aria-hidden="true" />
        <Link href="/recipes" className="btn sm ghost">view all →</Link>
      </div>
      <RecipesAtAGlance runs={runs} recipes={recipes} />

      {/* Recipe leaderboard — detailed health view */}
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
