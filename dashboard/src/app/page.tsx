"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { recipeDisplayName } from "@/lib/recipeDisplay";
import { FirstRunChecklist } from "@/components/FirstRunChecklist";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { useBridgeStatus } from "@/hooks/useBridgeStatus";
import { isHaltStatus } from "@/lib/runStatus";
import { canonicalRecipeKey } from "@/lib/entityKey";
import type { LiveRun } from "@/components/LiveRunsStrip";
import { useRunRecipe } from "@/hooks/useRunRecipe";
import {
  useManualPollStaleness,
  getStaleFetchSummary,
  subscribeStaleFetchRegistry,
} from "@/lib/staleFetchRegistry";
import { useCancelRun } from "@/hooks/useCancelRun";
import { CancelRunDialog } from "@/components/CancelRunDialog";
import { computeSuccessPct } from "@/lib/recipeRunHealth";
import {
  isReversible,
  lastDemotion,
  readyToAdvance,
  taskName,
  topPromotable,
  type ShadowResponse,
  type WorkerReport,
} from "@/lib/workerTrust";
import { describeNextRun, humanizeSchedule } from "@/lib/humanSchedule";
import { usePaneShortcut } from "@/hooks/usePaneShortcuts";
import { isNoiseEvent } from "@/lib/activityNoise";
import { eventLevel as activityEventLevel } from "@/lib/activityLevel";
import { collapseConsecutiveEvents } from "@/lib/collapseConsecutiveEvents";
import { triggerLabel } from "@/lib/triggerLabel";
import { previewText } from "@/lib/textPreview";

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
  schedule?: string;
  trigger?: { type?: string } | string;
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

interface InboxItem {
  name: string;
  modifiedAt: string;
  preview: string;
  provenance?: { recipe?: string };
}

// Slim mirror of `GateDecisionRecord` (src/workerGateDecisionLog.ts) — only
// the fields this pane actually renders. The bridge's `GET /gate/decisions`
// (backing `patchwork gate explain`) has never had a dashboard consumer
// before this pane; this is its first.
interface GateDecisionRecord {
  seq: number;
  decidedAt: number;
  workerId: string;
  toolName: string;
  classKey: string;
  action: "allow" | "gate";
  owned: boolean;
  earnedLevel: number;
  autonomyCeiling: number;
  effectiveLevel: number;
  contextCeiling?: number;
  contextRiskScore?: number;
  contextRiskReasons?: string[];
  reason: string;
  recipeName: string;
  gatePolicyVersion: string;
}

// Short level→phrase vocabulary, index = trust level 0-4. Mirrors
// PLAIN_LEVEL_SHORT in app/workers/page.tsx (the source of "asks first" /
// "acts + undo" etc.) — kept as a local copy since that array isn't
// currently exported from a shared lib; do not invent new phrasing here.
const GATE_LEVEL_SHORT = [
  "suggests only",
  "asks first",
  "acts + undo",
  "acts + spot-check",
  "on its own",
];
function gateLevelPhrase(n: number): string {
  return GATE_LEVEL_SHORT[n] ?? `level ${n}`;
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

// Compact uptime renderer for the statusline — "4d 12h", "3h 4m", "12m", "8s".
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

// "halted Xh Ym ago" ticker for pane 0's header.
function formatAgo(ms: number): string {
  if (ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  const mins = Math.floor(sec / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m ago`;
  if (mins > 0) return `${mins}m ${sec % 60}s ago`;
  return `${sec}s ago`;
}

function eventLine(e: ActivityEvent): string {
  if (e.kind === "tool") return e.tool ?? "tool";
  if (e.kind === "lifecycle" && e.event) return e.event.replace(/_/g, " ");
  return e.kind ?? "event";
}

function tsLabel(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(at));
}

const MUTE_KEY = "patchwork.td.attentionMuteUntil";

function readMuteUntil(): number {
  if (typeof window === "undefined") return 0;
  try {
    const v = window.localStorage.getItem(MUTE_KEY);
    return v ? Number(v) || 0 : 0;
  } catch {
    return 0;
  }
}

function writeMuteUntil(ts: number) {
  try {
    window.localStorage.setItem(MUTE_KEY, String(ts));
  } catch {
    /* private mode */
  }
}

const SHOW_PLUMBING_KEY = "patchwork.td.showPlumbing";

function readShowPlumbing(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SHOW_PLUMBING_KEY) === "1";
  } catch {
    return false;
  }
}

function writeShowPlumbing(v: boolean) {
  try {
    window.localStorage.setItem(SHOW_PLUMBING_KEY, v ? "1" : "0");
  } catch {
    /* private mode */
  }
}

/** Live clock — client-only, renders "—" during SSR/first paint to avoid
 *  hydration mismatch, then ticks 1s via useEffect. */
function useClock(): string {
  const [label, setLabel] = useState("—");
  useEffect(() => {
    const fmt = () =>
      new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date());
    setLabel(fmt());
    const id = setInterval(() => setLabel(fmt()), 1000);
    return () => clearInterval(id);
  }, []);
  return label;
}

/** Subscribes to the shared staleFetchRegistry (the same registry
 *  `useBridgeFetch({ trackStaleness: true })` and `useManualPollStaleness`
 *  write to) so the deck's own statusline clock segment can flip to an
 *  amber "data as of HH:MM:SS — reconnecting…" state whenever ANY of the
 *  deck's own tracked fetchers has gone stale — a separate, page-local
 *  presentation of the same underlying signal the global `StalenessStrip`
 *  banner shows, not a duplicate state machine. */
function useDeckStaleness() {
  const [summary, setSummary] = useState(() => getStaleFetchSummary());
  useEffect(() => {
    const recompute = () => setSummary(getStaleFetchSummary());
    recompute();
    const unsubscribe = subscribeStaleFetchRegistry(recompute);
    const id = setInterval(recompute, 1000);
    return () => {
      unsubscribe();
      clearInterval(id);
    };
  }, []);
  return summary;
}

/** Forces a re-render every `everyMs` so relative-time / countdown strings
 *  stay live without each consumer running its own interval. */
function useTick(everyMs: number): number {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return Date.now();
}

// Fleet pane (2): how many individual rows show before collapsing the
// rest into a "+N more" link, and how recent a run has to be to count as
// "active" rather than "idle".
const FLEET_VISIBLE_CAP = 6;
const FLEET_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Pane shell
// ---------------------------------------------------------------------------

interface PaneProps {
  index: number;
  id: string;
  title: string;
  activePane: number;
  setActivePane: (n: number) => void;
  href?: string;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

function Pane({
  index,
  id,
  title,
  activePane,
  setActivePane,
  href,
  headerExtra,
  children,
  className,
}: PaneProps) {
  const active = activePane === index;
  return (
    <section
      className={`td-pane${active ? " td-pane-active" : ""}${className ? ` ${className}` : ""}`}
      role="region"
      aria-label={title}
      tabIndex={0}
      data-pane-index={index}
      onFocus={() => setActivePane(index)}
      onClick={() => setActivePane(index)}
    >
      <header className="td-pane-head">
        <span className="td-pane-tag">{index}:{id}</span>
        <span className="td-pane-title">{title}</span>
        <span className="td-pane-sp" />
        {headerExtra}
        {href && (
          <Link href={href} className="td-pane-link" aria-label={`Open ${title}`}>
            →
          </Link>
        )}
      </header>
      <div className="td-pane-body">{children}</div>
    </section>
  );
}

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
  // Pane 4 (workers) and pane 6 (inbox) have no state in the pre-existing
  // fetch effect below — new proxy wiring per the plan's Pane 4/6 sections.
  const { data: shadowData, error: shadowError } = useBridgeFetch<ShadowResponse>(
    "/api/bridge/workers/shadow",
    { intervalMs: 15000, trackStaleness: true },
  );
  // Gate activity feed for pane 4 — GET /gate/decisions with no filters
  // returns the most-recent decisions across ALL workers (query() only
  // filters fields that are actually supplied), so this is a genuine "last
  // N gate decisions, any worker" feed, not a per-worker/per-class lookup.
  // Same 15s cadence as the workers-shadow fetch above (no new timer).
  const { data: gateDecisionsData, error: gateDecisionsError } = useBridgeFetch<{
    decisions?: GateDecisionRecord[];
  }>("/api/bridge/gate/decisions?limit=6", { intervalMs: 15000, trackStaleness: true });
  const { data: inboxData, error: inboxError } = useBridgeFetch<{ items?: InboxItem[] }>(
    "/api/inbox",
    { intervalMs: 15000, trackStaleness: true },
  );

  const [pendingApprovals, setPendingApprovals] = useState<Pending[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [runs, setRuns] = useState<LiveRun[]>([]);
  // Stop control shared by the 0:attention live-run row and the 1:tail
  // in-progress row — same hook/dialog the other 4 cancel call sites
  // (GlobalLiveRunsStrip, LiveRunsStrip, /runs, /runs/[seq]) already use.
  // Optimistic local override by seq, same pattern as LiveRunsStrip.tsx,
  // so a just-cancelled run stops showing "running" before the next poll.
  const [cancelledSeqs, setCancelledSeqs] = useState<Set<number>>(new Set());
  const cancelRun = useCancelRun((seq) => {
    setCancelledSeqs((prev) => new Set(prev).add(seq));
  });
  const [haltCount24hState, setHaltCount24h] = useState<number | null>(null);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [fetchErrors, setFetchErrors] = useState<{
    approvals?: boolean;
    recipes?: boolean;
    activity?: boolean;
    runs?: boolean;
  }>({});
  const tickRef = useRef<() => void>(() => {});

  // Primary user-visible feed for Overview: the recipes/runs/halts/activity
  // fan-out below. This drives every telemetry tile on the page ("what's
  // happening right now?") — if it stalls silently, the operator sees
  // frozen counters that look identical to "nothing is happening", which
  // is the exact failure mode this whole staleness feature exists to
  // catch. `/api/bridge/health` (fetched separately via useBridgeFetch
  // above) is a narrower secondary signal and not chosen here.
  const { markSuccess: markOverviewPollSuccess } = useManualPollStaleness({
    key: "/api/bridge/recipes+runs+halts",
    intervalMs: 5000,
    refetch: () => tickRef.current(),
  });
  // Ref indirection so the tick() effect (deps: []) doesn't need to
  // depend on markOverviewPollSuccess's identity, which changes every
  // render.
  const markOverviewPollSuccessRef = useRef(markOverviewPollSuccess);
  markOverviewPollSuccessRef.current = markOverviewPollSuccess;

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [approvalsRes, recipesRes, activityRes, runsRes, haltRes] =
          await Promise.all([
            fetch(apiPath("/api/bridge/approvals")),
            fetch(apiPath("/api/bridge/recipes")),
            fetch(apiPath("/api/bridge/activity?last=500")),
            fetch(apiPath("/api/bridge/runs")).catch(() => null),
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
        setActivityEvents((activityData.events ?? []).map(withAt));
        setFetchErrors({
          approvals: !approvalsRes.ok,
          recipes: !recipesRes.ok,
          activity: !activityRes.ok,
          runs: runsRes ? !runsRes.ok : true,
        });
        markOverviewPollSuccessRef.current();
      } catch {
        // bridge offline — fail soft, keep last-known state.
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

  // Live clock (statusline). SSR-safe placeholder, ticks client-side.
  const clockLabel = useClock();
  // Aggregate staleness across the deck's own tracked fetchers (the
  // primary recipes/runs/halts/activity poll via useManualPollStaleness
  // above, plus workers/shadow, gate/decisions, and inbox via
  // useBridgeFetch's trackStaleness). When any is stale, the clock
  // segment itself flips to an amber "data as of … reconnecting…"
  // instead of the live tick.
  const deckStaleness = useDeckStaleness();
  // Drive re-renders for the attention "halted Xh Ym ago" ticker + the
  // cron countdowns in pane 3 — both need a 1s heartbeat but shouldn't
  // each run their own interval.
  const nowMs = useTick(1000);

  const pendingCount = pendingApprovals.length;

  const dayMs = 24 * 60 * 60 * 1000;
  const haltCount24h =
    haltCount24hState ??
    runs.filter((r) => Date.now() - r.startedAt < dayMs && isHaltStatus(r.status)).length;
  const runs24h = runs.filter((r) => Date.now() - r.startedAt < dayMs);
  const errCount24h = runs24h.filter(
    (r) => r.status === "error" || r.status === "failed",
  ).length;
  const succeeded24h = runs24h.filter(
    (r) => r.status === "done" || r.status === "success",
  );
  const withErrCount24h = succeeded24h.filter((r) => r.hadStepErrors).length;
  const okCount24h = succeeded24h.length - withErrCount24h;

  const sessionsCount = bridgeStatus.activeSessions ?? health?.activeSessions;
  const enabledRecipesCount = recipes.filter((r) => r.enabled !== false).length;

  // ---- Pane 0: attention -------------------------------------------------
  const [muteUntil, setMuteUntilState] = useState(0);
  useEffect(() => setMuteUntilState(readMuteUntil()), []);
  const isMuted = muteUntil > nowMs;

  const attentionRuns = runs24h
    .filter((r) => isHaltStatus(r.status) || r.status === "error" || r.status === "failed")
    .sort((a, b) => b.startedAt - a.startedAt);
  const topAttentionRun = attentionRuns[0];
  const attentionCount = pendingCount + haltCount24h + errCount24h;

  // A run "live" locally overrides its status if we've already optimistically
  // cancelled it (same override LiveRunsStrip.tsx uses) so the Stop control
  // disappears immediately instead of waiting on the next poll tick.
  const liveRuns = runs
    .filter((r) => r.status === "running" && !(r.seq != null && cancelledSeqs.has(r.seq)))
    .sort((a, b) => b.startedAt - a.startedAt);
  const topLiveRun = liveRuns[0];

  // ---- Pane 1: tail (activity) --------------------------------------------
  // Default-hide bridge-lifecycle plumbing (grace/extension/heartbeat
  // churn) — previously this pane showed near-100% plumbing NOTE events
  // with zero runs/tools/gate-decisions visible. `isNoiseEvent` is the
  // same filter /activity and the Overview thread already use, so this
  // pane doesn't invent a fourth definition of "plumbing".
  const [showPlumbing, setShowPlumbing] = useState(false);
  useEffect(() => setShowPlumbing(readShowPlumbing()), []);

  const tailEvents = useMemo(() => {
    const visible = showPlumbing
      ? activityEvents
      : activityEvents.filter((e) => !isNoiseEvent(e));
    // Newest at the bottom per spec — activityEvents already arrives newest
    // first (matches /activity's ordering), so sort ascending then collapse
    // consecutive duplicates (e.g. a burst of the same failing tool call)
    // before taking the most recent rows.
    const sorted = [...visible].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    return collapseConsecutiveEvents(sorted).slice(-7);
  }, [activityEvents, showPlumbing]);
  const hiddenPlumbingCount = useMemo(
    () => (showPlumbing ? 0 : activityEvents.filter((e) => isNoiseEvent(e)).length),
    [activityEvents, showPlumbing],
  );
  const tailSummary =
    tailEvents.length > 0
      ? `Latest: ${eventLine(tailEvents[tailEvents.length - 1].event)}`
      : "No recent activity.";

  // Map recipe name -> the single live run for it (undefined when 0 or 2+
  // live runs share a name — ambiguous, so no Stop control renders rather
  // than risk stopping the wrong run). Backs the tail row Stop control:
  // a tail event whose metadata.recipeName matches a currently-running
  // run's recipe name is treated as representing that in-progress run.
  const liveRunByRecipeName = useMemo(() => {
    const m = new Map<string, LiveRun | null>();
    for (const r of liveRuns) {
      const name = (r.recipeName ?? r.recipe ?? "").replace(/:agent$/, "");
      if (!name) continue;
      m.set(name, m.has(name) ? null : r);
    }
    return m;
  }, [liveRuns]);

  function tailEventLiveRun(e: ActivityEvent): LiveRun | undefined {
    const metaName = e.metadata?.recipeName;
    if (typeof metaName !== "string" || !metaName) return undefined;
    const match = liveRunByRecipeName.get(metaName.replace(/:agent$/, ""));
    return match ?? undefined;
  }

  // ---- Pane 2: fleet -------------------------------------------------------
  const allRunsMap = useMemo(() => {
    const m = new Map<string, LiveRun[]>();
    for (const r of runs) {
      const key = canonicalRecipeKey(r.recipeName ?? r.recipe ?? "");
      if (!key) continue;
      const list = m.get(key) ?? [];
      list.push(r);
      m.set(key, list);
    }
    for (const list of m.values()) list.sort((a, b) => b.startedAt - a.startedAt);
    return m;
  }, [runs]);

  const fleetAllRows = useMemo(() => {
    return recipes.map((r) => {
      const key = canonicalRecipeKey(r.name);
      const runList = allRunsMap.get(key) ?? [];
      const pct = computeSuccessPct(runList);
      const trigger =
        typeof r.trigger === "string"
          ? r.trigger
          : r.trigger?.type ?? (r.schedule ? "cron" : "manual");
      const enabled = r.enabled !== false;
      const hasRecentRun = runList.some((run) => Date.now() - run.startedAt < FLEET_RECENT_MS);
      // Bucket 0 = enabled + recently run (the recipes actually doing
      // work), 1 = enabled but idle, 2 = everything else — disabled
      // recipes and one-off debug/manual-test artifacts. Bug fixed:
      // previously this only looked at *enabled* recipes sorted by raw
      // run count, so a disabled/manual "Outcome Ingester Debug1/2/3"
      // artifact with a pile of manual test runs could still outrank a
      // real cron recipe that simply runs less often.
      const bucket = !enabled ? 2 : hasRecentRun ? 0 : 1;
      return { recipe: r, key, runList, pct, trigger, enabled, bucket };
    });
  }, [recipes, allRunsMap]);

  const fleetRows = useMemo(() => {
    return [...fleetAllRows]
      .sort((a, b) => {
        if (a.bucket !== b.bucket) return a.bucket - b.bucket;
        // Within a bucket, most-recently-active first.
        const aLast = a.runList[0]?.startedAt ?? 0;
        const bLast = b.runList[0]?.startedAt ?? 0;
        return bLast - aLast;
      })
      .slice(0, FLEET_VISIBLE_CAP);
  }, [fleetAllRows]);

  const fleetOverflowCount = fleetAllRows.length - fleetRows.length;

  // ---- Pane 3: next (cron countdown) --------------------------------------
  // Bug: this used to list every cron-triggered recipe — enabled AND
  // paused — so a paused recipe rendering "(off)" crowded out the ones
  // that will actually fire next. Only enabled cron recipes belong in the
  // main list; paused ones collapse to a single footer count instead.
  const isCronRecipe = (r: Recipe) => {
    const trigger = typeof r.trigger === "string" ? r.trigger : r.trigger?.type;
    return Boolean(r.schedule) || trigger === "cron";
  };
  const cronRows = useMemo(() => {
    return recipes
      .filter((r) => isCronRecipe(r) && r.enabled !== false)
      .map((r) => ({ recipe: r, hs: humanizeSchedule(r.schedule) }))
      .sort((a, b) => {
        const av = a.hs.nextRunAt ?? Infinity;
        const bv = b.hs.nextRunAt ?? Infinity;
        return av - bv;
      });
  }, [recipes]);
  const pausedCronCount = useMemo(
    () => recipes.filter((r) => isCronRecipe(r) && r.enabled === false).length,
    [recipes],
  );

  // ---- Pane 4: workers -----------------------------------------------------
  const workers: WorkerReport[] = shadowData?.workers ?? [];
  function workerStatusWord(w: WorkerReport): "ready" | "climbing" | "reversible" {
    if (readyToAdvance(w)) return "ready";
    const hasNonReversibleOwned = w.board.some(
      (b) => b.owned && !isReversible(b.classKey),
    );
    return hasNonReversibleOwned ? "climbing" : "reversible";
  }
  const gateDecisions: GateDecisionRecord[] = gateDecisionsData?.decisions ?? [];
  const [expandedGateSeq, setExpandedGateSeq] = useState<number | null>(null);

  // ---- Pane 6: inbox ---------------------------------------------------
  // Data source: workspace-level GET /api/inbox (proxies bridge GET /inbox,
  // src/inboxRoutes.ts:108) — a real, already-proxied cross-recipe listing
  // route exists, so this pane is real data, not omitted. "Unread" tracking
  // reuses the same seenNames-in-localStorage idea as app/inbox/page.tsx,
  // scoped separately since this is a different, smaller surface.
  const INBOX_SEEN_KEY = "patchwork.td.inboxSeen";
  const [inboxSeen, setInboxSeen] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(INBOX_SEEN_KEY);
      if (raw) setInboxSeen(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore */
    }
  }, []);
  const inboxItems = (inboxData?.items ?? []).slice(0, 3);

  // Pane focus / keyboard nav (usePaneShortcuts, PR #1092).
  const [activePane, setActivePane] = useState(0);
  const PANE_HREFS = [
    "/runs?halt=1",
    "/activity",
    "/recipes",
    "/recipes",
    "/workers",
    undefined,
    "/inbox",
  ] as const;
  usePaneShortcut(
    (e) => {
      if (/^[0-6]$/.test(e.key)) {
        setActivePane(Number(e.key));
        return;
      }
      if (e.key === "Enter") {
        const href = PANE_HREFS[activePane];
        if (href) window.location.href = href;
      }
    },
    [activePane],
  );

  const killSwitchLabel = bridgeStatus.killSwitch?.engaged ? "engaged" : "released";

  return (
    <section className="td-root">
      <FirstRunChecklist />

      {/* Statusline */}
      <div className="td-statusline" role="status" aria-label="Bridge status">
        <span className="td-seg td-seg-brand">
          patchwork · local:{bridgeStatus.port ?? bridgeStatus.patchwork?.port ?? "—"}
        </span>
        <span className={`td-seg${bridgeStatus.ok ? " td-ok" : " td-err"}`}>
          {bridgeStatus.ok
            ? `● bridge ${typeof bridgeStatus.uptimeMs === "number" ? formatUptime(bridgeStatus.uptimeMs) : "—"}`
            : "● offline"}
        </span>
        <span className="td-seg">
          runs 24h: <span className="td-ok">{okCount24h} ok</span> ·{" "}
          <span className={errCount24h > 0 ? "td-err" : undefined}>{errCount24h} err</span>
        </span>
        <span className={`td-seg${pendingCount > 0 ? " td-warn" : ""}`}>
          approvals: {pendingCount}
        </span>
        <span className={`td-seg${haltCount24h > 0 ? " td-err" : ""}`}>
          halts: {haltCount24h}
        </span>
        <span className="td-seg">
          ks: <span className={bridgeStatus.killSwitch?.engaged ? "td-err" : "td-ok"}>{killSwitchLabel}</span>
        </span>
        <span className="td-sp" />
        {deckStaleness.anyStale ? (
          <span className="td-seg td-clock td-warn" suppressHydrationWarning>
            data as of{" "}
            {deckStaleness.mostRecentSuccessAt != null
              ? tsLabel(deckStaleness.mostRecentSuccessAt)
              : "—"}{" "}
            — reconnecting…
          </span>
        ) : (
          <span className="td-seg td-clock" suppressHydrationWarning>
            {clockLabel}
          </span>
        )}
      </div>

      <div className="td-grid">
        {/* 0: attention */}
        <Pane
          index={0}
          id="attention"
          title="attention"
          activePane={activePane}
          setActivePane={setActivePane}
          href="/runs?halt=1"
          headerExtra={
            attentionCount > 0 ? (
              <>
                <span className="td-muted">· {attentionCount} item{attentionCount === 1 ? "" : "s"}</span>
                {topAttentionRun && (
                  <span className="td-muted td-pane-sp" style={{ textAlign: "right" }}>
                    halted {formatAgo(nowMs - topAttentionRun.startedAt)}
                  </span>
                )}
              </>
            ) : null
          }
        >
          {!bridgeStatus.ok ? (
            <div className="td-error-row">bridge offline — can&apos;t reach attention data</div>
          ) : (
            <>
              {topLiveRun && (() => {
                const name = (topLiveRun.recipeName ?? topLiveRun.recipe ?? "").replace(/:agent$/, "");
                const isStopping =
                  topLiveRun.seq != null &&
                  cancelRun.cancelSeq === topLiveRun.seq &&
                  cancelRun.phase === "cancelling";
                const agoMs = nowMs - topLiveRun.startedAt;
                return (
                  <div className="td-attention-item td-attention-live">
                    <div className="td-attention-head">
                      <span className="td-pill td-pill-warn">running</span>
                      <strong className="mono">{recipeDisplayName(name)}</strong>
                      <span className="td-muted">started {formatAgo(agoMs)}</span>
                    </div>
                    <div className="td-attention-actions">
                      <button
                        type="button"
                        className="btn sm ghost"
                        disabled={isStopping || topLiveRun.seq == null}
                        title={`Stop this run of ${name}`}
                        onClick={() => {
                          if (topLiveRun.seq != null) cancelRun.requestConfirm(topLiveRun.seq);
                        }}
                      >
                        {isStopping ? "stopping…" : "■ Stop"}
                      </button>
                      <Link href={`/runs/${topLiveRun.seq ?? ""}`} className="btn sm ghost">
                        View run
                      </Link>
                    </div>
                  </div>
                );
              })()}
              {isMuted ? (
                <div className="td-muted-row">
                  Muted until {new Date(muteUntil).toLocaleTimeString()}.{" "}
                  <button
                    type="button"
                    className="td-link-btn"
                    onClick={() => {
                      writeMuteUntil(0);
                      setMuteUntilState(0);
                    }}
                  >
                    unmute
                  </button>
                </div>
              ) : attentionCount === 0 ? (
                !topLiveRun && <div className="td-empty-line">nothing needs you</div>
              ) : (
              <>
              {topAttentionRun && (() => {
                const name = (topAttentionRun.recipeName ?? topAttentionRun.recipe ?? "").replace(/:agent$/, "");
                const key = canonicalRecipeKey(name);
                const isQueueing = Boolean(runPending[key]);
                const agoMs = nowMs - topAttentionRun.startedAt;
                return (
                  <div className="td-attention-item">
                    <div className="td-attention-head">
                      <span className="td-pill td-pill-err">
                        {isHaltStatus(topAttentionRun.status) ? "halted" : topAttentionRun.status}
                      </span>
                      <strong className="mono">{recipeDisplayName(name)}</strong>
                      <span className="td-muted">{formatAgo(agoMs)}</span>
                    </div>
                    {topAttentionRun.haltReason && (
                      <div className="td-attention-reason">└ {topAttentionRun.haltReason}</div>
                    )}
                    <div className="td-attention-actions">
                      <button
                        type="button"
                        className="btn sm"
                        disabled={isQueueing}
                        onClick={() => void runRecipe(key)}
                      >
                        {isQueueing ? "queued…" : "↻ Retry"}
                      </button>
                      <Link
                        href={`/recipes/${encodeURIComponent(name)}?diagnose=1#doctor`}
                        className="btn sm ghost"
                      >
                        Doctor
                      </Link>
                      <Link href="/connections" className="btn sm ghost">
                        Connections
                      </Link>
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => {
                          const until = Date.now() + 24 * 60 * 60 * 1000;
                          writeMuteUntil(until);
                          setMuteUntilState(until);
                        }}
                      >
                        Mute 24h
                      </button>
                    </div>
                  </div>
                );
              })()}
              {pendingCount > 0 && (
                <div className="td-attention-foot">
                  <Link href="/approvals">{pendingCount} approval{pendingCount === 1 ? "" : "s"} pending →</Link>
                </div>
              )}
              </>
              )}
            </>
          )}
        </Pane>

        {/* 1: tail */}
        <Pane
          index={1}
          id="tail"
          title="tail"
          activePane={activePane}
          setActivePane={setActivePane}
          href="/activity"
          headerExtra={
            <>
              <span className="td-muted mono">· ~/.patchwork/activity</span>
              <button
                type="button"
                className="td-link-btn td-plumbing-toggle"
                aria-pressed={showPlumbing}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setShowPlumbing((prev) => {
                    const next = !prev;
                    writeShowPlumbing(next);
                    return next;
                  });
                }}
              >
                {showPlumbing
                  ? "hide plumbing"
                  : hiddenPlumbingCount > 0
                    ? `show plumbing (${hiddenPlumbingCount})`
                    : "show plumbing"}
              </button>
              <span className={deckStaleness.anyStale ? "td-warn" : "td-ok"}>
                ● {deckStaleness.anyStale ? "reconnecting" : "live"}
              </span>
            </>
          }
        >
          {fetchErrors.activity ? (
            <div className="td-error-row">activity feed unavailable</div>
          ) : (
            <>
              {/* sr-only aria-atomic summary instead of literal aria-live
                  per-row (existing precedent: ActivityTicker.tsx deliberately
                  sets aria-live="off" to avoid screen-reader spam from
                  fast-updating rows; approvals/page.tsx:1080 uses this
                  role="status" + sr-only summary-region pattern). */}
              <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                {tailSummary}
              </div>
              <div className="td-tail" aria-hidden="true">
                {tailEvents.length === 0 ? (
                  <div className="td-muted-row">no recent events</div>
                ) : (
                  tailEvents.map(({ event: e, count }, i) => {
                    const level = activityEventLevel(e);
                    const rowLiveRun = tailEventLiveRun(e);
                    const isStopping =
                      rowLiveRun?.seq != null &&
                      cancelRun.cancelSeq === rowLiveRun.seq &&
                      cancelRun.phase === "cancelling";
                    return (
                      <div
                        className={`td-tail-row td-lvl-${level} td-tail-enter`}
                        key={e.id ?? `${e.at}-${i}`}
                        // The parent .td-tail is aria-hidden (a fast-updating
                        // feed would spam screen readers) — a row carrying a
                        // Stop control must stay reachable, so un-hide it.
                        aria-hidden={rowLiveRun ? "false" : undefined}
                      >
                        <span className="td-tail-ts">{tsLabel(e.at ?? Date.now())}</span>
                        <span className="td-tail-level">{level.toUpperCase()}</span>
                        <span className="td-tail-msg">
                          {eventLine(e)}
                          {count > 1 ? ` ×${count}` : ""}
                        </span>
                        {rowLiveRun && rowLiveRun.seq != null && (
                          <button
                            type="button"
                            className="btn sm ghost td-tail-stop"
                            disabled={isStopping}
                            title={`Stop this run of ${(rowLiveRun.recipeName ?? rowLiveRun.recipe ?? "").replace(/:agent$/, "")}`}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              cancelRun.requestConfirm(rowLiveRun.seq as number);
                            }}
                          >
                            {isStopping ? "stopping…" : "■ Stop"}
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </Pane>

        {/* 2: fleet */}
        <Pane
          index={2}
          id="fleet"
          title="fleet"
          activePane={activePane}
          setActivePane={setActivePane}
          href="/recipes"
          headerExtra={
            <span className="td-muted">
              · {enabledRecipesCount}/{recipes.length} on
            </span>
          }
        >
          {fetchErrors.recipes ? (
            <div className="td-error-row">recipe list unavailable</div>
          ) : fleetRows.length === 0 ? (
            <div className="td-empty-line">no recipes installed</div>
          ) : (
            <>
              {fleetRows.map(({ recipe, runList, pct, trigger }) => (
                <div className="td-fleet-row" key={recipe.name}>
                  <span className="td-fleet-glyph">{recipe.enabled !== false ? "▶" : "⏸"}</span>
                  <strong className="mono td-fleet-name">{recipeDisplayName(recipe.name)}</strong>
                  <span className="td-muted td-fleet-trigger">{triggerLabel(trigger)}</span>
                  <span className="td-fleet-bar" aria-hidden="true">
                    {Array.from({ length: 6 }, (_, i) => {
                      const r = runList[i];
                      if (!r) {
                        // No run history for this slot — render a neutral
                        // placeholder dot, not a dim-gray filled block that
                        // reads as "ran and looked empty/failed".
                        return (
                          <span key={i} className="td-blk-empty">
                            ·
                          </span>
                        );
                      }
                      const err = r.status === "error" || r.status === "failed" || isHaltStatus(r.status);
                      return (
                        <span key={i} className={err ? "td-blk-err" : "td-blk-ok"}>
                          █
                        </span>
                      );
                    })}
                  </span>
                  <span className="td-muted">{pct == null ? "—" : `${Math.round(pct)}%`}</span>
                </div>
              ))}
              {fleetOverflowCount > 0 && (
                <Link href="/recipes" className="td-more-link">
                  +{fleetOverflowCount} more →
                </Link>
              )}
            </>
          )}
        </Pane>

        {/* 3: next (cron countdown) */}
        <Pane index={3} id="next" title="next" activePane={activePane} setActivePane={setActivePane} href="/recipes">
          {fetchErrors.recipes ? (
            <div className="td-error-row">recipe schedules unavailable</div>
          ) : cronRows.length === 0 ? (
            <div className="td-empty-line">
              no schedules — every enabled recipe is event-driven
            </div>
          ) : (
            <>
              {cronRows.slice(0, 6).map(({ recipe, hs }) => {
                const remaining = hs.nextRunAt != null ? hs.nextRunAt - nowMs : null;
                const countdown =
                  remaining == null
                    ? hs.humanized
                      ? describeNextRun(hs.nextRunAt) ?? hs.text
                      : hs.text
                    : remaining < 3_600_000
                      ? mmss(remaining)
                      : new Date(hs.nextRunAt as number).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                        });
                return (
                  <div className="td-next-row" key={recipe.name}>
                    <strong className="mono td-next-name">{recipeDisplayName(recipe.name)}</strong>
                    <span className="td-muted">{countdown}</span>
                  </div>
                );
              })}
              {pausedCronCount > 0 && (
                <Link href="/recipes?filter=paused" className="td-more-link">
                  {pausedCronCount} scheduled recipe{pausedCronCount === 1 ? "" : "s"} are off →
                </Link>
              )}
            </>
          )}
        </Pane>

        {/* 4: workers */}
        <Pane index={4} id="workers" title="workers" activePane={activePane} setActivePane={setActivePane} href="/workers">
          {shadowError ? (
            <div className="td-error-row">worker trust data unavailable</div>
          ) : workers.length === 0 ? (
            <div className="td-empty-line">no worker activity yet</div>
          ) : (
            workers.slice(0, 6).map((w) => {
              const status = workerStatusWord(w);
              const promo = topPromotable(w);
              const demoted = lastDemotion(w);
              // Diamond trust-dial (mockup's .hd-ascii "▰▰▰▱" glyph
              // vocabulary): filled = ceiling out of 4 levels (L0-L4),
              // red instead of green when the worker's most recent event
              // was a demotion. ⚑ flags a higher earned-but-capped level.
              const dialLen = 4;
              const filled = Math.min(dialLen, Math.max(0, w.autonomyCeiling));
              return (
                <div className="td-worker-row" key={w.workerId}>
                  <strong className="mono td-worker-name">{w.name}</strong>
                  <span className="td-worker-bar" aria-hidden="true">
                    {Array.from({ length: dialLen }, (_, i) => (
                      <span key={i} className={i < filled ? (demoted ? "td-blk-err" : "td-blk-ok") : "td-blk-empty"}>
                        {i < filled ? "▰" : "▱"}
                      </span>
                    ))}
                    <span className="td-muted">L{w.autonomyCeiling}</span>
                  </span>
                  <span className={`td-worker-status td-worker-status-${status}`}>
                    {status === "ready" && promo ? `⚑L${promo.level} ` : ""}
                    {status}
                    {demoted ? " ▼" : ""}
                    {status === "ready" && promo ? ` ↑ ${taskName(promo.classKey)}` : ""}
                  </span>
                </div>
              );
            })
          )}

          {/* Gate activity — first-ever dashboard surface of the Decision
              Record (GET /gate/decisions, backs `patchwork gate explain`).
              Renders the last ~6 gate decisions across all workers. */}
          <div className="td-gate-activity">
            <div className="td-gate-activity-title td-muted">gate activity</div>
            {gateDecisionsError ? (
              <div className="td-error-row">gate activity unavailable</div>
            ) : gateDecisions.length === 0 ? (
              <div className="td-empty-line">no gate decisions yet</div>
            ) : (
              gateDecisions.slice(0, 6).map((d) => {
                const isOpen = expandedGateSeq === d.seq;
                const hhmm = new Date(d.decidedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                });
                return (
                  <div className="td-gate-row-wrap" key={d.seq}>
                    <button
                      type="button"
                      className="td-gate-row"
                      aria-expanded={isOpen}
                      onClick={() =>
                        setExpandedGateSeq(isOpen ? null : d.seq)
                      }
                    >
                      <span className="mono td-muted">{hhmm}</span>
                      <span className="td-gate-verb">GATE</span>
                      <span className="mono">{d.workerId}</span>
                      <span className="td-muted mono">{d.classKey}</span>
                      <span className="td-gate-arrow">→</span>
                      <span>{gateLevelPhrase(d.effectiveLevel)}</span>
                    </button>
                    {isOpen && (
                      <div className="td-gate-explain">
                        <div>
                          effective L{d.effectiveLevel} ({gateLevelPhrase(d.effectiveLevel)})
                          {" vs required "}
                          {d.action === "allow" ? "— none (allowed)" : "higher"}
                        </div>
                        <div>
                          earned L{d.earnedLevel} · autonomy ceiling L{d.autonomyCeiling}
                          {d.contextCeiling !== undefined
                            ? ` · context ceiling L${d.contextCeiling}`
                            : ""}
                        </div>
                        {d.contextRiskReasons && d.contextRiskReasons.length > 0 && (
                          <div>context signals: {d.contextRiskReasons.join(", ")}</div>
                        )}
                        <div className="td-muted">{d.reason}</div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </Pane>

        {/* 5: vitals */}
        <Pane index={5} id="vitals" title="vitals" activePane={activePane} setActivePane={setActivePane}>
          <div className="td-kv-row">
            <span className="td-muted">sessions</span>
            <strong>{typeof sessionsCount === "number" ? sessionsCount : "—"}</strong>
          </div>
          <div className="td-kv-row">
            <span className="td-muted">tool calls · 24h</span>
            <strong>{activityEvents.filter((e) => e.kind === "tool").length}</strong>
          </div>
          <div className="td-kv-row">
            <span className="td-muted">kill switch</span>
            <strong className={bridgeStatus.killSwitch?.engaged ? "td-err" : "td-ok"}>
              {killSwitchLabel}
            </strong>
          </div>
          <div className="td-kv-row">
            <span className="td-muted">approvals</span>
            <strong className={pendingCount > 0 ? "td-warn" : undefined}>
              {pendingCount} pending
            </strong>
          </div>
          <div className="td-kv-row">
            <span className="td-muted">recipes enabled</span>
            <strong>
              {enabledRecipesCount} / {recipes.length}
            </strong>
          </div>
        </Pane>

        {/* 6: inbox */}
        <Pane index={6} id="inbox" title="inbox" activePane={activePane} setActivePane={setActivePane} href="/inbox">
          {inboxError ? (
            <div className="td-error-row">inbox unavailable</div>
          ) : inboxItems.length === 0 ? (
            <div className="td-empty-line">inbox is empty</div>
          ) : (
            inboxItems.map((item) => {
              const isNew = !inboxSeen.has(item.name);
              return (
                <Link
                  href="/inbox"
                  className="td-inbox-row"
                  key={item.name}
                  onClick={() => {
                    setInboxSeen((prev) => {
                      const next = new Set(prev);
                      next.add(item.name);
                      try {
                        window.localStorage.setItem(INBOX_SEEN_KEY, JSON.stringify([...next]));
                      } catch {
                        /* ignore */
                      }
                      return next;
                    });
                  }}
                >
                  {isNew && <span className="td-pill td-pill-warn">NEW</span>}
                  <span className="td-inbox-preview">
                    {previewText(item.preview, 60) || item.name}
                  </span>
                </Link>
              );
            })
          )}
        </Pane>
      </div>

      <CancelRunDialog
        open={cancelRun.phase === "confirming"}
        onClose={cancelRun.dismiss}
        onConfirm={() => void cancelRun.confirm()}
        recipeName={
          runs.find((r) => r.seq === cancelRun.cancelSeq)?.recipeName
        }
        seq={cancelRun.cancelSeq}
      />
    </section>
  );
}

// (kept for upstream typing imports / no-op reference)
export type { BridgeHealth };
