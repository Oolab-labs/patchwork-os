"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { apiPath } from "@/lib/api";
import { recipeDisplayName } from "@/lib/recipeDisplay";
import { FirstRunChecklist } from "@/components/FirstRunChecklist";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { useBridgeStatus } from "@/hooks/useBridgeStatus";
import { isHaltStatus } from "@/lib/runStatus";
import { canonicalRecipeKey } from "@/lib/entityKey";
import type { LiveRun } from "@/components/LiveRunsStrip";
import { useRunRecipe } from "@/hooks/useRunRecipe";
import { useToggleRecipeEnabled } from "@/hooks/useToggleRecipeEnabled";
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
import { classifyPendingAction, reversibilityRank } from "@/lib/actionClass";
import { BlastBadge } from "@/components/patchwork";
import { usePaneShortcut } from "@/hooks/usePaneShortcuts";
import { isNoiseEvent } from "@/lib/activityNoise";
import { eventLevel as activityEventLevel } from "@/lib/activityLevel";
import { collapseConsecutiveEvents } from "@/lib/collapseConsecutiveEvents";
import { triggerLabel } from "@/lib/triggerLabel";
import { previewText } from "@/lib/textPreview";
import { useToast } from "@/components/Toast";

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
  /** Present on tool-call entries from an interactive WebSocket session
   *  (src/transport.ts's `this.sessionId`); absent/undefined for
   *  recipe/cron-triggered tool calls, which have no session to attach to
   *  — that's real, not a bug (see docs/in-flight.md 2026-07-04). */
  sessionId?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

interface InboxItem {
  name: string;
  modifiedAt: string;
  preview: string;
  provenance?: { recipe?: string; runSeq?: number };
}

// 7:copilot — Tier 1 lever-action chat. `CopilotAction` mirrors the
// bridge's `/copilot/message` response shape (src/copilot/parseIntent.ts);
// `status` is client-side only, added once the card renders. "undone" is
// reachable only from "done" on pause_recipe/enable_recipe — run_recipe
// has no undo (nothing to revert once a recipe has actually run).
type CopilotActionStatus = "pending" | "running" | "done" | "undoing" | "undone";
interface CopilotAction {
  kind: "pause_recipe" | "enable_recipe" | "run_recipe";
  recipeName: string;
  status: CopilotActionStatus;
  /** The user message text that produced this action — recorded on the
   *  Decision Record when confirmed, so /traces can show what was asked
   *  for, not just what ran. */
  sourceText: string;
}
interface CopilotMessage {
  id: number;
  role: "user" | "bot";
  text: string;
  action?: CopilotAction;
}

// A worker-filed issue awaiting the operator's confirm/reject verdict —
// the self-confirm-prohibited "Clear the decisions" surface formerly on
// the standalone /today page, folded into 0:attention here (2026-07-04).
// Never a recipe step / MCP tool; POST /api/bridge/outcomes is the only
// way to move a worker's `issue` dial (see CLAUDE.md "outcomes confirm").
interface PendingConfirmation {
  issueUrl: string;
  recipeName: string;
  workerId: string;
  workerName: string;
  filedAt: number;
  classKey: string;
  title?: string;
}
interface PendingOutcomesResponse {
  pending: PendingConfirmation[];
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

/** One gate-decision row + its click-to-expand explain panel. Extracted
 *  so it can render both in the flat single-worker list and inside each
 *  worker's collapsible group without duplicating the JSX. */
function GateRow({
  d,
  isOpen,
  onToggle,
  indent,
}: {
  d: GateDecisionRecord;
  isOpen: boolean;
  onToggle: () => void;
  indent?: boolean;
}) {
  const hhmm = new Date(d.decidedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return (
    <div className={`td-gate-row-wrap${indent ? " td-gate-row-indent" : ""}`}>
      <button type="button" className="td-gate-row" aria-expanded={isOpen} onClick={onToggle}>
        <span className="mono td-muted">{hhmm}</span>
        <span className="td-gate-verb">GATE</span>
        {!indent && <span className="mono">{d.workerId}</span>}
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
            {d.contextCeiling !== undefined ? ` · context ceiling L${d.contextCeiling}` : ""}
          </div>
          {d.contextRiskReasons && d.contextRiskReasons.length > 0 && (
            <div>context signals: {d.contextRiskReasons.join(", ")}</div>
          )}
          <div className="td-muted">{d.reason}</div>
        </div>
      )}
    </div>
  );
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

/** A duration (not "ago"), for fleet's "avg 48s" metadata line. */
function formatDurationShort(ms: number): string {
  if (ms < 0) ms = 0;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins}m ${sec % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

// Phase 4: halt-age escalation — a halt sitting unaddressed for hours
// shouldn't look identical to one from 2 minutes ago. The attention pane's
// pool is `runs24h` (bounded to the last 24h — see the statusline's "runs
// 24h" tile), so tiers live inside that window: fresh <1h, stale 1-6h,
// critical >=6h ("this has been open a quarter of the day, unaddressed").
type HaltAgeTier = "fresh" | "stale" | "critical";
function haltAgeTier(ageMs: number): HaltAgeTier {
  if (ageMs >= 6 * 60 * 60 * 1000) return "critical";
  if (ageMs >= 60 * 60 * 1000) return "stale";
  return "fresh";
}

/**
 * Plain-English summary for a raw halt-reason string shown in the
 * attention panel (e.g. "[agent step skipped: ANTHROPIC_API_KEY not
 * set]"). Non-technical users shouldn't have to parse bracket-wrapped
 * internals to know what to do — the raw text is always still available
 * behind a details expander, this just supplies the friendly headline.
 */
function friendlyHaltSummary(raw: string): { text: string; fixHint?: string } {
  const r = raw.toLowerCase();
  if (r.includes("api_key") && (r.includes("not set") || r.includes("missing"))) {
    return {
      text: "This automation needs an API key set up before it can run.",
      fixHint: "Add it in Settings, then re-run this automation.",
    };
  }
  if (r.includes("not set") || r.includes("missing")) {
    return {
      text: "This automation is missing a setting it needs to run.",
      fixHint: "Check Settings, then re-run this automation.",
    };
  }
  if (r.includes("timeout") || r.includes("timed out")) {
    return { text: "This automation took too long and was stopped." };
  }
  if (r.includes("rate limit") || r.includes("rate-limit")) {
    return { text: "An external service is rate-limiting this automation right now." };
  }
  return { text: "Something went wrong while running this automation." };
}

/** agreed/compared as a 0-100 trust percentage, or null if there's no
 *  comparison history yet (never fabricate a rate from zero data) — the
 *  mockup's W-A "ready for more independence — 92% over 38 tries" copy,
 *  backed by data the pane already fetches. */
function workerTrustPct(w: WorkerReport): number | null {
  if (w.compared <= 0) return null;
  return Math.round((w.agreed / w.compared) * 100);
}

// The former standalone /today page's "unified morning" layout (numbered
// 1/2/3 sections + progress dots + collapse-to-clear banner), removed as
// a page in #1112, restored here as a section on Overview between the
// statusline and the pane grid per user request (2026-07-04) — the
// minimal "N of 3 done" text-only version from the first attempt at this
// wasn't what was wanted; this is a faithful port of the richer mockup
// (docs artifact 21d32382, "TY · Unified morning" section) using data the
// panes below already compute, not a second source of truth. Approvals
// and worker-verdict actions here are ADDITIVE to 0:attention's existing
// versions of the same queues (user's explicit choice — some duplication,
// more surface area, rather than relocating that pane's content).
function TodayMorningSection({
  newestUnreadBrief,
  newestBrief,
  onMarkBriefRead,
  approvals,
  approvalBusy,
  onApprovalDecide,
  workerPending,
  outcomeBusy,
  onOutcomeDecide,
  promotableWorkers,
  demotedRecentWorkers,
  otherWorkerCount,
}: {
  newestUnreadBrief: InboxItem | undefined;
  newestBrief: InboxItem | undefined;
  onMarkBriefRead: (name: string) => void;
  approvals: Pending[];
  approvalBusy: string | null;
  onApprovalDecide: (p: Pending, decision: "approve" | "reject") => void;
  workerPending: PendingConfirmation[];
  outcomeBusy: string | null;
  onOutcomeDecide: (p: PendingConfirmation, disposition: "confirmed" | "junk") => void;
  promotableWorkers: WorkerReport[];
  demotedRecentWorkers: WorkerReport[];
  otherWorkerCount: number;
}) {
  const decisionsDone = approvals.length === 0 && workerPending.length === 0;
  const teamDone = promotableWorkers.length === 0 && demotedRecentWorkers.length === 0;
  const briefDone = !newestUnreadBrief;
  const doneCount = [decisionsDone, teamDone, briefDone].filter(Boolean).length;
  const allDone = doneCount === 3;

  const sortedApprovals = [...approvals].sort(
    (a, b) =>
      reversibilityRank(classifyPendingAction(a.toolName)?.reversibility) -
      reversibilityRank(classifyPendingAction(b.toolName)?.reversibility),
  );

  if (allDone) {
    return (
      <div className="td-today-done" role="status">
        <span aria-hidden="true">✓</span> You&apos;re clear — check back tomorrow.
      </div>
    );
  }

  const decisionCount = approvals.length + workerPending.length;
  const titleParts: ReactNode[] = [];
  if (!decisionsDone) {
    titleParts.push(
      <em key="decisions">
        {decisionCount} decision{decisionCount === 1 ? "" : "s"}
      </em>,
    );
  }
  if (!briefDone) titleParts.push("one brief");

  return (
    <div className="td-today">
      <div className="td-today-head">
        <span className="td-today-title">
          Morning.{" "}
          {titleParts.length === 0 ? (
            "Nothing waiting"
          ) : (
            titleParts.reduce<ReactNode[]>(
              (acc, part, i) => (i === 0 ? [part] : [...acc, ", ", part]),
              [],
            )
          )}
          , and you&apos;re clear.
        </span>
        <span className="td-today-progress" aria-label={`${doneCount} of 3 done`}>
          <i className={decisionsDone ? "d" : ""} />
          <i className={teamDone ? "d" : ""} />
          <i className={briefDone ? "d" : ""} />
        </span>
      </div>

      <div className="td-today-sec">
        <div className="td-today-sh">
          <span className="td-today-n">1</span>
          <h3>Read the brief</h3>
          {newestUnreadBrief && <span className="td-muted">from {newestUnreadBrief.provenance?.recipe ?? "morning-brief"}</span>}
        </div>
        {newestUnreadBrief ? (
          <div className="td-today-card">
            <p className="td-today-brief-text">{newestUnreadBrief.preview}</p>
            <div className="td-today-actions">
              <Link href="/inbox" className="btn sm ghost">
                Open full note
              </Link>
              <span className="td-sp" />
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => onMarkBriefRead(newestUnreadBrief.name)}
              >
                Mark read ✓
              </button>
            </div>
          </div>
        ) : (
          <div className="td-today-card td-muted">
            {newestBrief ? "No new brief since last read." : "No briefs yet."}
          </div>
        )}
      </div>

      <div className="td-today-sec">
        <div className="td-today-sh">
          <span className="td-today-n">2</span>
          <h3>Clear the decisions</h3>
          {!decisionsDone && (
            <span className="td-muted">{decisionCount} waiting · worst first</span>
          )}
        </div>
        {decisionsDone ? (
          <div className="td-today-card td-muted">Nothing waiting.</div>
        ) : (
          <div className="td-today-card td-today-rows">
            {sortedApprovals.map((p) => (
              <div className="td-today-row" key={p.callId}>
                <BlastBadge cls={classifyPendingAction(p.toolName)} />
                <span className="td-today-row-body">
                  <strong className="mono">{p.toolName}</strong>
                  {p.summary ? ` — ${p.summary}` : ""}
                </span>
                <span className="td-sp" />
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={approvalBusy === p.callId}
                  onClick={() => onApprovalDecide(p, "approve")}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={approvalBusy === p.callId}
                  onClick={() => onApprovalDecide(p, "reject")}
                >
                  Deny
                </button>
              </div>
            ))}
            {workerPending.map((p) => (
              <div className="td-today-row" key={p.issueUrl}>
                <span className="pill muted">verdict</span>
                <span className="td-today-row-body">
                  <strong>{p.workerName}</strong> filed &ldquo;{p.title ?? "a new issue"}&rdquo; — real?
                </span>
                <span className="td-sp" />
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={outcomeBusy === p.issueUrl}
                  onClick={() => onOutcomeDecide(p, "confirmed")}
                >
                  Looks real
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={outcomeBusy === p.issueUrl}
                  onClick={() => onOutcomeDecide(p, "junk")}
                >
                  Not real
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="td-today-sec">
        <div className="td-today-sh">
          <span className="td-today-n">3</span>
          <h3>Glance at the team</h3>
        </div>
        {teamDone ? (
          <div className="td-today-card td-muted">Team is quiet and healthy.</div>
        ) : (
          <div className="td-today-card td-today-rows">
            {promotableWorkers.map((w) => {
              const pct = workerTrustPct(w);
              return (
                <div className="td-today-row" key={`promo-${w.workerId}`}>
                  <span className="dot ok" />
                  <span className="td-today-row-body">
                    <strong>{w.name}</strong> is ready for a promotion
                    {pct != null ? ` — ${pct}% over ${w.compared} tries.` : "."}
                  </span>
                  <span className="td-sp" />
                  <Link href="/workers" className="btn sm ghost">
                    Raise limit →
                  </Link>
                </div>
              );
            })}
            {demotedRecentWorkers.map((w) => {
              const pct = workerTrustPct(w);
              return (
                <div className="td-today-row" key={`demote-${w.workerId}`}>
                  <span className="dot warn" />
                  <span className="td-today-row-body">
                    <strong>{w.name}</strong> rebuilding trust after a recent demotion
                    {pct != null ? ` (${pct}%).` : "."}
                  </span>
                </div>
              );
            })}
            {otherWorkerCount > 0 && (
              <div className="td-today-row">
                <span className="dot mut" />
                <span className="td-today-row-body">
                  {otherWorkerCount} other{otherWorkerCount === 1 ? "" : "s"} quiet and healthy ·{" "}
                  <Link href="/workers">full roster →</Link>
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function eventLine(e: ActivityEvent): string {
  if (e.kind === "tool") return e.tool ?? "tool";
  if (e.kind === "lifecycle" && e.event) return e.event.replace(/_/g, " ");
  return e.kind ?? "event";
}

/** Tool-call entries carry sessionId top-level (src/transport.ts); lifecycle
 *  entries carry it under metadata (src/bridge.ts). Absent for recipe/cron-
 *  triggered tool calls, which have no interactive session — that's real,
 *  not a gap (see docs/in-flight.md 2026-07-04 session-tagging entry). */
function eventSessionId(e: ActivityEvent): string | undefined {
  if (typeof e.sessionId === "string") return e.sessionId;
  const meta = e.metadata;
  if (meta && typeof meta.sessionId === "string") return meta.sessionId;
  return undefined;
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

// Phase 4 fix: mute used to be purely time-based — a "Mute 24h" click on
// today's halt would also hide tomorrow's unrelated halt for the rest of
// the window. Persist WHICH halt was muted alongside the timestamp, and
// only suppress the attention pane while the current top halt is still
// that same one — a genuinely new/different halt bypasses the mute.
const MUTE_FINGERPRINT_KEY = "patchwork.td.attentionMuteFingerprint";

function readMuteFingerprint(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(MUTE_FINGERPRINT_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeMuteFingerprint(fp: string) {
  try {
    window.localStorage.setItem(MUTE_FINGERPRINT_KEY, fp);
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
  const { toggle: toggleRecipeEnabled } = useToggleRecipeEnabled();
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
  // Worker-verdict confirm queue — formerly /today §2's "worker verdict"
  // rows. Same 15s poll cadence as the workers-shadow request (no new timer).
  const {
    data: pendingOutcomesData,
    refetch: refetchPendingOutcomes,
  } = useBridgeFetch<PendingOutcomesResponse>("/api/bridge/outcomes/pending", {
    intervalMs: 15000,
    trackStaleness: true,
  });
  const toast = useToast();
  const [outcomeBusy, setOutcomeBusy] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);

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
  // Audit finding: this 5s poll used to overwrite `recipes` wholesale with
  // zero reconciliation against an in-flight toggle's optimistic write. If
  // the poll's GET started before a copilot/recipes-page toggle's PATCH
  // landed, it could resolve AFTER the toggle and clobber the correct
  // post-toggle state back to the pre-toggle value — e.g. Undo silently
  // re-disabling instead of re-enabling. See `recipeOverrideUntilRef`
  // (declared near recipeToggleCallbacks below, referenced inside tick()'s
  // merge) for the time-based guard against this.

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
        // Merge rather than blind-replace: a recipe still inside its
        // post-toggle grace window (see recipeOverrideUntilRef below)
        // keeps its locally-known `enabled` value instead of being
        // overwritten by this poll's possibly-pre-toggle server snapshot.
        setRecipes((prev) => {
          const overrides = recipeOverrideUntilRef.current;
          const now = Date.now();
          const prevByName = new Map(prev.map((r) => [r.name, r]));
          return list.map((r) => {
            const until = overrides[r.name];
            if (!until || now >= until) return r;
            const localR = prevByName.get(r.name);
            return localR ? { ...r, enabled: localR.enabled } : r;
          });
        });
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
  // Mockup's H-C ".hc-kv" trend annotations (mined idea #3) — scoped to
  // sessions only, not every KV row: sessions is a small gauge that
  // genuinely goes up/down between polls, so a delta is informative. A
  // monotonic 24h counter (tool calls) or a rarely-changing one (recipes
  // enabled) would just show noise or near-always-zero, so those are left
  // alone rather than fabricating a "trend" that isn't one.
  const prevSessionsRef = useRef<number | undefined>(undefined);
  const [sessionsDelta, setSessionsDelta] = useState<number | null>(null);
  useEffect(() => {
    if (typeof sessionsCount !== "number") return;
    if (
      typeof prevSessionsRef.current === "number" &&
      prevSessionsRef.current !== sessionsCount
    ) {
      setSessionsDelta(sessionsCount - prevSessionsRef.current);
    }
    prevSessionsRef.current = sessionsCount;
  }, [sessionsCount]);
  const enabledRecipesCount = recipes.filter((r) => r.enabled !== false).length;

  // Mockup's H-C ".hc-heat" 24-hour activity grid (mined idea #1) — one
  // cell per hour of the last 24h, colored by event density/errors.
  // Caveat, stated honestly rather than silently: activityEvents is
  // capped at the last 500 fetched events (`/api/bridge/activity?last=500`
  // above), so on a very high-traffic bridge the earliest hours in this
  // window may under-count — this is the same fetch every other
  // activity-derived number on this page already relies on, not a new
  // limitation introduced here.
  const activityHeatmap = useMemo(() => {
    const HOURS = 24;
    const bucketMs = 60 * 60 * 1000;
    const cells = Array.from({ length: HOURS }, () => ({ count: 0, errors: 0 }));
    const cutoff = nowMs - HOURS * bucketMs;
    for (const e of activityEvents) {
      if (isNoiseEvent(e)) continue;
      const at = e.at ?? 0;
      if (at < cutoff || at > nowMs) continue;
      const bucketIndex = Math.min(HOURS - 1, Math.floor((nowMs - at) / bucketMs));
      const cell = cells[HOURS - 1 - bucketIndex];
      cell.count += 1;
      if (e.status === "error") cell.errors += 1;
    }
    const maxCount = Math.max(1, ...cells.map((c) => c.count));
    return { cells, maxCount };
  }, [activityEvents, nowMs]);

  // ---- Pane 0: attention -------------------------------------------------
  const [muteUntil, setMuteUntilState] = useState(0);
  const [muteFingerprint, setMuteFingerprintState] = useState("");
  useEffect(() => {
    setMuteUntilState(readMuteUntil());
    setMuteFingerprintState(readMuteFingerprint());
  }, []);

  const attentionRuns = runs24h
    .filter((r) => isHaltStatus(r.status) || r.status === "error" || r.status === "failed")
    .sort((a, b) => b.startedAt - a.startedAt);
  const topAttentionRun = attentionRuns[0];
  const workerPending = pendingOutcomesData?.pending ?? [];
  const attentionCount = pendingCount + haltCount24h + errCount24h + workerPending.length;
  const topWorkerPending = [...workerPending].sort((a, b) => a.filedAt - b.filedAt)[0];
  // Worst-blast-tier pending approval first (mockup's A-A "Considered" —
  // "sorted by blast radius, the one that can't be undone is on top").
  // Maps directly onto the worker-autonomy gate's existing
  // domain:reversibility:blastTier vocabulary via classifyPendingAction.
  const topApproval = [...pendingApprovals].sort(
    (a, b) =>
      reversibilityRank(classifyPendingAction(a.toolName)?.reversibility) -
      reversibilityRank(classifyPendingAction(b.toolName)?.reversibility),
  )[0];
  // Identity of whatever halt is currently the top attention item — a
  // "Mute 24h" click only ever fires from inside that halt's own action
  // row, so this is what a stored mute fingerprint gets compared against.
  const topAttentionFingerprint = topAttentionRun
    ? `run:${topAttentionRun.seq ?? topAttentionRun.startedAt}`
    : "";
  const isMuted =
    muteUntil > nowMs &&
    (topAttentionFingerprint === "" || topAttentionFingerprint === muteFingerprint);

  async function actOutcome(p: PendingConfirmation, disposition: "confirmed" | "junk") {
    setOutcomeBusy(p.issueUrl);
    try {
      const res = await fetch(apiPath("/api/bridge/outcomes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueUrl: p.issueUrl,
          disposition,
          recipeName: p.recipeName,
          workerClass: p.classKey,
        }),
      });
      if (!res.ok) throw new Error(`Update failed (${res.status})`);
      toast.success(disposition === "confirmed" ? "Marked real" : "Marked not real");
      refetchPendingOutcomes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setOutcomeBusy(null);
    }
  }

  // Mirrors approvals/page.tsx's `decide()` — same endpoint, same high-tier
  // confirm/reason-prompt gate (a stray click on a high-tier `rm -rf`
  // approving instantly was a real, already-fixed bug there; this surface
  // must not reopen it). A 409 means another session already decided —
  // treated as success so the row just clears rather than erroring.
  async function actApproval(p: Pending, decision: "approve" | "reject") {
    if (decision === "approve" && p.tier === "high") {
      const proceed = window.confirm(`Approve high-risk ${p.toolName}? This cannot be undone.`);
      if (!proceed) return;
    }
    let reason: string | undefined;
    if (decision === "reject" && p.tier === "high") {
      const entered = window.prompt(
        `Why are you rejecting ${p.toolName}? (logged for audit; max 500 chars)`,
        "",
      );
      if (entered === null) return;
      reason = entered.trim() || undefined;
    }
    setApprovalBusy(p.callId);
    try {
      const init: RequestInit = { method: "POST" };
      if (reason) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify({ reason: reason.slice(0, 500) });
      }
      const res = await fetch(apiPath(`/api/bridge/approvals/${decision}/${p.callId}`), init);
      if (!res.ok && res.status !== 409) throw new Error(`${decision} failed (${res.status})`);
      toast.success(decision === "approve" ? "Approved" : "Denied");
      setPendingApprovals((prev) => prev.filter((x) => x.callId !== p.callId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setApprovalBusy(null);
    }
  }

  // A run "live" locally overrides its status if we've already optimistically
  // cancelled it (same override LiveRunsStrip.tsx uses) so the Stop control
  // disappears immediately instead of waiting on the next poll tick.
  const liveRuns = runs
    .filter((r) => r.status === "running" && !(r.seq != null && cancelledSeqs.has(r.seq)))
    .sort((a, b) => b.startedAt - a.startedAt);
  const topLiveRun = liveRuns[0];
  // Mockup's H-A "wire" footer line — a persistent heartbeat distinct from
  // the halted/pending list above it, so the pane isn't silent when
  // there's genuinely nothing wrong. Most recently *finished* run (not
  // running), across all statuses.
  const lastFinishedRun = runs
    .filter((r) => r.status !== "running" && r.doneAt != null)
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))[0];

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
      // runList is sorted most-recent-first (allRunsMap above) — a
      // data-backed pulse on the ▶ glyph for a recipe with a run in
      // progress right now, not decorative motion.
      const isLive = runList[0]?.status === "running";
      return { recipe: r, key, runList, pct, trigger, enabled, bucket, isLive };
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
  // Mockup's W-B "Ledger" worker-row/task-subrow split (mined idea #9,
  // previously deferred to a future /workers detail page) — brought into
  // this compact pane per user request: when multiple workers are
  // engaged, one flat feed mixing all their decisions together gets
  // unreadable fast. Grouped by worker, collapsed by default, one open
  // at a time (accordion). A single worker keeps today's flat list —
  // there's nothing to disambiguate with only one source.
  const [expandedGateWorker, setExpandedGateWorker] = useState<string | null>(null);
  const gateWorkerIds = Array.from(new Set(gateDecisions.map((d) => d.workerId)));
  // Team rollup — formerly /today §3's "N ready to promote" framing.
  // Per-row ⚑/▼ markers below already carry the detail; this is just the
  // one-line "should I even look" summary the deck's header convention
  // wants (mirrors 0:attention's "· N items" / 2:fleet's "N/M on").
  const promotableWorkers = workers.filter(readyToAdvance);
  const demotedRecentWorkers = workers.filter((w) => {
    const d = lastDemotion(w);
    return Boolean(d) && Date.now() - (d?.at ?? 0) < 7 * 86_400_000;
  });
  const promotableCount = promotableWorkers.length;
  const demotedRecentCount = demotedRecentWorkers.length;

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
  // Shared by the 6:inbox row click and the morning-strip's "Mark read" —
  // one seen-set, so reading the brief from either place clears both.
  function markInboxSeen(name: string) {
    setInboxSeen((prev) => {
      const next = new Set(prev);
      next.add(name);
      try {
        window.localStorage.setItem(INBOX_SEEN_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }
  const inboxAllItems = inboxData?.items ?? [];
  const inboxItems = inboxAllItems.slice(0, 3);
  const inboxUnreadCount = inboxAllItems.filter((item) => !inboxSeen.has(item.name)).length;
  const isBriefItem = (name: string) => name.toLowerCase().includes("morning-brief");
  const briefItems = inboxAllItems
    .filter((item) => isBriefItem(item.name))
    .slice()
    .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  const newestBrief = briefItems[0];
  const newestUnreadBrief = briefItems.find((item) => !inboxSeen.has(item.name));

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

  // ---- 7:copilot -----------------------------------------------------------
  // Tier 1 lever-action chat (docs/plans/dashboard-terminal-copilot-plan-
  // 2026-07-03.md). Message history is client-side only, not persisted —
  // matches the mockup (a fresh session starts with an empty transcript).
  // "Chat proposes, buttons dispose": /copilot/message NEVER executes
  // anything, it only returns {reply, action?}; the Confirm button below
  // calls the SAME gated hooks (`toggleRecipeEnabled`, `runRecipe`) every
  // other pane already uses — never a raw endpoint call.
  const [copilotMessages, setCopilotMessages] = useState<CopilotMessage[]>([]);
  const [copilotInput, setCopilotInput] = useState("");
  const [copilotSending, setCopilotSending] = useState(false);
  const copilotMsgSeq = useRef(0);
  const copilotMsgsRef = useRef<HTMLDivElement>(null);
  // Tracks whether the user was scrolled near the bottom BEFORE the latest
  // render's DOM mutation, via a live onScroll listener rather than
  // recomputing post-mutation (scrollHeight/scrollTop already reflect the
  // newly-appended content by the time a useEffect runs, so a post-hoc
  // check can't tell "was at bottom" from "just became not-at-bottom
  // because a message landed"). Defaults true so the initial empty state
  // and first message both auto-scroll.
  const copilotNearBottomRef = useRef(true);
  // Auto-scroll to the newest message/thinking-indicator — without this,
  // a reply landing past the 340px scroll cap is invisible until the
  // user manually scrolls down. Only sticks to bottom if the user hadn't
  // scrolled up to reread earlier history — otherwise a new message would
  // yank their view away from what they're reading.
  useEffect(() => {
    const el = copilotMsgsRef.current;
    if (el && copilotNearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [copilotMessages, copilotSending]);

  // Chat history is session-only (not persisted across reloads — matches
  // the mockup) but still needs a cap: an all-day session chatting with
  // the copilot would otherwise grow this array (and its DOM projection)
  // unbounded, unlike every other polled array on this page which either
  // replaces wholesale or is capped by its own query (e.g. tailEvents).
  const COPILOT_MAX_MESSAGES = 100;
  function appendCopilotMessage(msg: CopilotMessage) {
    setCopilotMessages((prev) => {
      const next = [...prev, msg];
      return next.length > COPILOT_MAX_MESSAGES
        ? next.slice(next.length - COPILOT_MAX_MESSAGES)
        : next;
    });
  }

  async function sendCopilotMessage() {
    const text = copilotInput.trim();
    if (!text || copilotSending) return;
    setCopilotInput("");
    const userMsg: CopilotMessage = {
      id: ++copilotMsgSeq.current,
      role: "user",
      text,
    };
    appendCopilotMessage(userMsg);
    setCopilotSending(true);
    try {
      const res = await fetch(apiPath("/api/bridge/copilot/message"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        reply?: string;
        action?: Omit<CopilotAction, "status" | "sourceText">;
      };
      const botMsg: CopilotMessage = {
        id: ++copilotMsgSeq.current,
        role: "bot",
        text: res.ok ? (data.reply ?? "(no reply)") : "Couldn't reach the copilot endpoint.",
        action:
          res.ok && data.action
            ? { ...data.action, status: "pending", sourceText: text }
            : undefined,
      };
      appendCopilotMessage(botMsg);
    } catch (e) {
      appendCopilotMessage({
        id: ++copilotMsgSeq.current,
        role: "bot",
        text: `Couldn't reach the copilot endpoint: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setCopilotSending(false);
    }
  }

  function setCopilotActionStatus(
    msgId: number,
    status: CopilotActionStatus,
    kind?: CopilotAction["kind"],
  ) {
    setCopilotMessages((prev) =>
      prev.map((m) =>
        m.id === msgId && m.action
          ? { ...m, action: { ...m.action, status, ...(kind && { kind }) } }
          : m,
      ),
    );
  }

  // Best-effort Decision Record write — the mockup's promise that copilot
  // actions are "attributable in /traces" like cron. Uses the same HTTP
  // route (POST /traces/decision, #1094) the ctxSaveTrace MCP tool backs.
  // Fire-and-forget: a failed audit write must never block or roll back
  // an action the operator already confirmed.
  function recordCopilotDecisionTrace(action: CopilotAction, solution: string) {
    void fetch(apiPath("/api/bridge/traces/decision"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: `copilot:${action.recipeName}`,
        problem: action.sourceText,
        solution,
        tags: ["copilot", action.kind],
        source: "copilot",
      }),
    }).catch((e) => {
      console.error("[copilot] decision-trace write failed:", e);
    });
  }

  // Keeps the page's local `recipes` array in sync with a copilot-driven
  // pause/enable/undo, mirroring recipes/page.tsx's handleToggleEnabled.
  // Without this, a second toggle in the same session (e.g. Undo right
  // after Confirm) recomputes its target off a stale `enabled` value and
  // can silently repeat the same PATCH instead of flipping back.
  //
  // Audit finding: checking the toggle hook's `pending` map alone isn't
  // enough to protect this from the 5s poll (see toggleRecipePendingRef
  // above) — a poll request that started BEFORE the toggle but resolves
  // shortly AFTER it completes lands with `pending` already cleared, so
  // it would still clobber the just-confirmed state. recipeOverrideUntilRef
  // instead grants each toggled recipe a short time-based grace window
  // (comfortably longer than one poll cycle) during which the poll's
  // merge keeps the locally-known value regardless of in-flight status.
  const recipeOverrideUntilRef = useRef<Record<string, number>>({});
  const RECIPE_OVERRIDE_GRACE_MS = 8000;

  function recipeToggleCallbacks(recipeName: string) {
    return {
      onOptimistic: (nextEnabled: boolean) => {
        recipeOverrideUntilRef.current[recipeName] = Date.now() + RECIPE_OVERRIDE_GRACE_MS;
        setRecipes((prev) =>
          prev.map((r) => (r.name === recipeName ? { ...r, enabled: nextEnabled } : r)),
        );
      },
      onRollback: (previousEnabled: boolean) => {
        recipeOverrideUntilRef.current[recipeName] = Date.now() + RECIPE_OVERRIDE_GRACE_MS;
        setRecipes((prev) =>
          prev.map((r) => (r.name === recipeName ? { ...r, enabled: previousEnabled } : r)),
        );
      },
    };
  }

  async function confirmCopilotAction(msg: CopilotMessage) {
    const action = msg.action;
    if (!action || action.status !== "pending") return;
    setCopilotActionStatus(msg.id, "running");
    if (action.kind === "run_recipe") {
      const result = await runRecipe(action.recipeName);
      setCopilotActionStatus(msg.id, result.ok ? "done" : "pending");
      if (result.ok) {
        recordCopilotDecisionTrace(action, `Ran "${action.recipeName}" via copilot.`);
      }
      return;
    }
    // pause_recipe / enable_recipe — same gated hook the recipes page uses,
    // including its confirm() gate before disabling an autonomous trigger.
    const recipe = recipes.find((r) => r.name === action.recipeName);
    if (!recipe) {
      setCopilotActionStatus(msg.id, "pending");
      return;
    }
    const trigger =
      typeof recipe.trigger === "string" ? recipe.trigger : recipe.trigger?.type;
    const result = await toggleRecipeEnabled(
      { name: recipe.name, enabled: recipe.enabled, trigger },
      recipeToggleCallbacks(recipe.name),
    );
    setCopilotActionStatus(msg.id, result.ok ? "done" : "pending");
    if (result.ok) {
      const verb = action.kind === "pause_recipe" ? "Disabled" : "Enabled";
      recordCopilotDecisionTrace(
        action,
        `${verb} "${action.recipeName}" via copilot lever action.`,
      );
    }
  }

  // Undo — pause_recipe/enable_recipe only (a run can't be un-run). Calls
  // the identical gated hook a second time; toggleRecipeEnabled reads the
  // CURRENT recipe.enabled off shared state, so this naturally flips back
  // to the pre-confirm state without needing to track it separately. If
  // the recipe is now autonomous+enabled, the hook's own confirm() gate
  // fires again exactly as it would for a manual disable elsewhere.
  async function undoCopilotAction(msg: CopilotMessage) {
    const action = msg.action;
    if (!action || action.status !== "done" || action.kind === "run_recipe") return;
    const recipe = recipes.find((r) => r.name === action.recipeName);
    if (!recipe) return;
    setCopilotActionStatus(msg.id, "undoing");
    const trigger =
      typeof recipe.trigger === "string" ? recipe.trigger : recipe.trigger?.type;
    const result = await toggleRecipeEnabled(
      { name: recipe.name, enabled: recipe.enabled, trigger },
      recipeToggleCallbacks(recipe.name),
    );
    if (result.ok) {
      setCopilotActionStatus(msg.id, "undone");
      recordCopilotDecisionTrace(
        action,
        `Reverted "${action.recipeName}" back to its prior state via copilot undo.`,
      );
    } else {
      setCopilotActionStatus(msg.id, "done");
    }
  }

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

      <TodayMorningSection
        newestUnreadBrief={newestUnreadBrief}
        newestBrief={newestBrief}
        onMarkBriefRead={markInboxSeen}
        approvals={pendingApprovals}
        approvalBusy={approvalBusy}
        onApprovalDecide={actApproval}
        workerPending={workerPending}
        outcomeBusy={outcomeBusy}
        onOutcomeDecide={actOutcome}
        promotableWorkers={promotableWorkers}
        demotedRecentWorkers={demotedRecentWorkers}
        otherWorkerCount={Math.max(
          0,
          workers.length -
            new Set([...promotableWorkers, ...demotedRecentWorkers].map((w) => w.workerId)).size,
        )}
      />

      <div className="td-grid">
        {/* 0: attention */}
        <Pane
          index={0}
          id="attention"
          title="Needs your attention"
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
                      writeMuteFingerprint("");
                      setMuteFingerprintState("");
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
                const ageTier = haltAgeTier(agoMs);
                return (
                  <div className={`td-attention-item${ageTier !== "fresh" ? ` td-attention-${ageTier}` : ""}`}>
                    <div className="td-attention-head">
                      <span className={`td-pill td-pill-err${ageTier === "critical" ? " td-pill-critical" : ""}`}>
                        {isHaltStatus(topAttentionRun.status) ? "halted" : topAttentionRun.status}
                      </span>
                      <strong className="mono">{recipeDisplayName(name)}</strong>
                      <span className={`td-muted${ageTier !== "fresh" ? " td-age-stale" : ""}`}>
                        {formatAgo(agoMs)}
                        {ageTier === "critical" ? " — needs attention" : ageTier === "stale" ? " — unaddressed" : ""}
                      </span>
                    </div>
                    {topAttentionRun.haltReason && (() => {
                      const { text, fixHint } = friendlyHaltSummary(topAttentionRun.haltReason);
                      return (
                        <div className="td-attention-reason">
                          └ {text}
                          {fixHint && <span className="td-attention-fix-hint"> {fixHint}</span>}
                          <details className="td-attention-raw">
                            <summary>Show technical details</summary>
                            <code className="mono">{topAttentionRun.haltReason}</code>
                          </details>
                        </div>
                      );
                    })()}
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
                          writeMuteFingerprint(topAttentionFingerprint);
                          setMuteFingerprintState(topAttentionFingerprint);
                        }}
                      >
                        Mute 24h
                      </button>
                    </div>
                  </div>
                );
              })()}
              {topApproval && (
                <div className="td-attention-item">
                  <div className="td-attention-head">
                    <BlastBadge cls={classifyPendingAction(topApproval.toolName)} />
                    <strong className="mono">{topApproval.toolName}</strong>
                    <span className="td-muted">
                      filed {formatAgo(nowMs - topApproval.requestedAt)}
                    </span>
                  </div>
                  {topApproval.summary && (
                    <div className="td-attention-reason">└ {topApproval.summary}</div>
                  )}
                  <div className="td-attention-actions">
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={approvalBusy === topApproval.callId}
                      onClick={() => void actApproval(topApproval, "approve")}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn sm ghost"
                      disabled={approvalBusy === topApproval.callId}
                      onClick={() => void actApproval(topApproval, "reject")}
                    >
                      Deny
                    </button>
                  </div>
                </div>
              )}
              {topWorkerPending && (
                <div className="td-attention-item">
                  <div className="td-attention-head">
                    <span className="pill muted">worker verdict</span>
                    <strong className="mono">{topWorkerPending.workerName}</strong>
                    <span className="td-muted">filed {formatAgo(nowMs - topWorkerPending.filedAt)}</span>
                  </div>
                  <div className="td-attention-reason">└ {topWorkerPending.title ?? "a new issue"}</div>
                  <div className="td-attention-actions">
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={outcomeBusy === topWorkerPending.issueUrl}
                      onClick={() => void actOutcome(topWorkerPending, "confirmed")}
                    >
                      Looks real
                    </button>
                    <button
                      type="button"
                      className="btn sm ghost"
                      disabled={outcomeBusy === topWorkerPending.issueUrl}
                      onClick={() => void actOutcome(topWorkerPending, "junk")}
                    >
                      Not real
                    </button>
                  </div>
                </div>
              )}
              {(pendingCount > 0 || workerPending.length > 0) && (
                <div className="td-attention-foot">
                  {pendingCount > 0 && (
                    <Link href="/approvals">{pendingCount} approval{pendingCount === 1 ? "" : "s"} pending →</Link>
                  )}
                  {pendingCount > 0 && workerPending.length > 0 ? " · " : ""}
                  {workerPending.length > 0 && (
                    <Link href="/workers">{workerPending.length} verdict{workerPending.length === 1 ? "" : "s"} pending →</Link>
                  )}
                </div>
              )}
              </>
              )}
              {(topLiveRun ?? lastFinishedRun) && (
                <div className="td-attention-wire">
                  <span className={`dot ${topLiveRun ? "ok" : "mut"}`} aria-hidden="true" />
                  {topLiveRun ? (
                    <>
                      {liveRuns.length} running · {(topLiveRun.recipeName ?? topLiveRun.recipe ?? "").replace(/:agent$/, "")}
                    </>
                  ) : lastFinishedRun ? (
                    <>
                      last finished {formatAgo(nowMs - (lastFinishedRun.doneAt ?? nowMs))} ·{" "}
                      {(lastFinishedRun.recipeName ?? lastFinishedRun.recipe ?? "").replace(/:agent$/, "")}
                    </>
                  ) : null}
                </div>
              )}
            </>
          )}
        </Pane>

        {/* 1: tail */}
        <Pane
          index={1}
          id="tail"
          title="Live activity"
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
                        {eventSessionId(e) && (
                          <span className="td-tail-session td-muted">
                            session {eventSessionId(e)?.slice(0, 8)}
                          </span>
                        )}
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
          title="Your automations"
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
              {fleetRows.map(({ recipe, runList, pct, trigger, enabled, isLive }) => {
                const hasHistory = runList.length > 0;
                // Continuous proportional fill bar (mockup's .hd-ascii block
                // sparkline) — was previously 6 discrete per-run history
                // dots, a different metric (history) rendered a different
                // way (spaced) than the mockup's single packed fill-bar
                // sized to the success percentage.
                const BAR_WIDTH = 8;
                const filled = pct == null ? 0 : Math.round((pct / 100) * BAR_WIDTH);
                // Mockup's R-A ".ra-meta" row (mined idea #7) — avg
                // duration + last-run-relative-time, using the same
                // runList this row's health bar already computes from.
                const finishedRuns = runList.filter((r) => r.durationMs != null);
                const avgDurationMs =
                  finishedRuns.length > 0
                    ? finishedRuns.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) /
                      finishedRuns.length
                    : null;
                const lastRun = runList[0];
                return (
                  <div
                    className={`td-fleet-row${enabled ? "" : " td-fleet-row-off"}`}
                    key={recipe.name}
                  >
                    <div className="td-fleet-row-top">
                      <span
                        className={`td-fleet-glyph${isLive ? " td-fleet-glyph-live" : ""}`}
                        title={isLive ? "running now" : enabled ? "enabled" : "paused"}
                      >
                        {enabled ? "▶" : "⏸"}
                      </span>
                      <strong className="mono td-fleet-name">{recipeDisplayName(recipe.name)}</strong>
                      <span className="td-muted td-fleet-trigger">{triggerLabel(trigger)}</span>
                      {!enabled ? (
                        <span className="td-fleet-bar td-muted" aria-hidden="true">
                          {"─".repeat(BAR_WIDTH)}
                        </span>
                      ) : (
                        // Keyed by `filled` so the whole bar remounts (and
                        // replays its fade-in) when the success rate changes
                        // between polls — reuses the tail pane's existing
                        // .td-tail-enter convention rather than a new one.
                        <span className="td-fleet-bar td-tail-enter" key={filled} aria-hidden="true">
                          {Array.from({ length: BAR_WIDTH }, (_, i) =>
                            i < filled ? (
                              <span key={i} className="td-blk-ok">
                                █
                              </span>
                            ) : (
                              <span key={i} className="td-blk-empty">
                                {hasHistory ? "─" : "·"}
                              </span>
                            ),
                          )}
                        </span>
                      )}
                      <span className="td-muted">{!enabled ? "off" : pct == null ? "—" : `${Math.round(pct)}%`}</span>
                    </div>
                    {enabled && hasHistory && (avgDurationMs != null || lastRun) && (
                      <div className="td-fleet-meta td-muted">
                        {avgDurationMs != null && <>avg {formatDurationShort(avgDurationMs)}</>}
                        {avgDurationMs != null && lastRun ? " · " : ""}
                        {lastRun && <>{formatAgo(nowMs - lastRun.startedAt)}</>}
                      </div>
                    )}
                  </div>
                );
              })}
              {fleetOverflowCount > 0 && (
                <Link href="/recipes" className="td-more-link">
                  +{fleetOverflowCount} more →
                </Link>
              )}
            </>
          )}
        </Pane>

        {/* 3: next (cron countdown) */}
        <Pane
          index={3}
          id="next"
          title="Coming up"
          activePane={activePane}
          setActivePane={setActivePane}
          href="/recipes"
          headerExtra={<span className="td-muted">· cron queue</span>}
        >
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
        <Pane
          index={4}
          id="workers"
          title="Your AI team"
          activePane={activePane}
          setActivePane={setActivePane}
          href="/workers"
          headerExtra={
            promotableCount > 0 || demotedRecentCount > 0 ? (
              <span className="td-muted">
                ·{" "}
                {promotableCount > 0 ? `${promotableCount} ready to promote` : ""}
                {promotableCount > 0 && demotedRecentCount > 0 ? " · " : ""}
                {demotedRecentCount > 0 ? `${demotedRecentCount} slipped back` : ""}
              </span>
            ) : null
          }
        >
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
              // Reversible-only workers show an empty dial + "—" label
              // (mockup's inbox-summ. row) — the autonomy ceiling is
              // meaningless there since reversible actions bypass the
              // gate unconditionally regardless of ceiling.
              const filled = status === "reversible" ? 0 : Math.min(dialLen, Math.max(0, w.autonomyCeiling));
              const dialTitle =
                status === "reversible"
                  ? "reversible-only — no autonomy ceiling applies"
                  : `trust level ${filled} of ${dialLen} (ceiling L${w.autonomyCeiling})${demoted ? " — recently demoted" : ""}`;
              return (
                <div className="td-worker-row" key={w.workerId}>
                  <strong className="mono td-worker-name">{w.name}</strong>
                  {/* Keyed by filled+demoted so the dial remounts (replays
                      the fade-in) when a worker's trust level actually
                      changes between polls — same convention as the tail
                      pane's .td-tail-enter and the fleet bar above. */}
                  <span
                    className="td-worker-bar td-tail-enter"
                    key={`${filled}-${demoted ? 1 : 0}`}
                    title={dialTitle}
                  >
                    {/* Label comes BEFORE the dial (mockup: "L3 ▰▰▰▱"),
                        not after — a real ordering mismatch caught after
                        comparing pixel-for-pixel against the mockup
                        screenshot rather than just the markup. "—" (not
                        "L0") for reversible-only workers, matching the
                        mockup's inbox-summ. row. */}
                    <span className="td-muted" aria-hidden="true">
                      {status === "reversible" ? "—" : `L${w.autonomyCeiling}`}
                    </span>
                    {Array.from({ length: dialLen }, (_, i) => (
                      <span
                        key={i}
                        aria-hidden="true"
                        className={i < filled ? (demoted ? "td-blk-err" : "td-blk-ok") : "td-blk-empty"}
                      >
                        {i < filled ? "▰" : "▱"}
                      </span>
                    ))}
                  </span>
                  <span className={`td-worker-status td-worker-status-${status}`}>
                    {status === "ready" && promo ? (
                      <span title={`ready to promote to L${promo.level} on ${taskName(promo.classKey)}`}>
                        ⚑L{promo.level}{" "}
                      </span>
                    ) : (
                      ""
                    )}
                    {status}
                    {demoted ? (
                      <span title="recently demoted"> ▼</span>
                    ) : (
                      ""
                    )}
                    {status === "ready" && promo ? ` ↑ ${taskName(promo.classKey)}` : ""}
                    {(() => {
                      const pct = workerTrustPct(w);
                      // Mockup's W-A "92% over 38 tries" copy — only for
                      // the states where a rate is actually meaningful.
                      if (pct == null || (status !== "ready" && !demoted)) return null;
                      return (
                        <span className="td-muted"> · {pct}% over {w.compared} tries</span>
                      );
                    })()}
                  </span>
                </div>
              );
            })
          )}

          {/* Review-needed tray (mockup's W-B "Ledger" .wb-review) — the
              worker-verdict confirm queue, surfaced HERE too, not just in
              0:attention. 4:workers previously only showed aggregate
              counts ("N ready to promote · N slipped back"); this is the
              actual "is it real?" queue the counts refer to, reusing the
              exact same workerPending/actOutcome data+handler
              0:attention's identical item already uses — additive, same
              established pattern as the earlier approval item. */}
          {workerPending.length > 0 && (
            <div className="td-worker-review">
              <div className="td-worker-review-head">review needed</div>
              {workerPending.map((p) => (
                <div className="td-worker-review-row" key={p.issueUrl}>
                  <span className="pill muted">issue</span>
                  <span className="td-worker-review-body">
                    <strong>{p.workerName}</strong> filed &ldquo;{p.title ?? "a new issue"}&rdquo;
                    <span className="td-muted"> · {formatAgo(nowMs - p.filedAt)} · {p.classKey}</span>
                  </span>
                  <span className="td-pane-sp" />
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={outcomeBusy === p.issueUrl}
                    onClick={() => void actOutcome(p, "confirmed")}
                  >
                    Looks real
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    disabled={outcomeBusy === p.issueUrl}
                    onClick={() => void actOutcome(p, "junk")}
                  >
                    Not real
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Gate activity — first-ever dashboard surface of the Decision
              Record (GET /gate/decisions, backs `patchwork gate explain`).
              Renders the last ~6 gate decisions. Grouped into a
              collapsible-per-worker accordion (mockup's W-B "Ledger"
              worker-row/task-subrow split) once more than one worker
              shows up in the feed — a single flat list mixing multiple
              workers' decisions together stops being readable fast. */}
          <div className="td-gate-activity">
            <div className="td-gate-activity-title td-muted">gate activity</div>
            {gateDecisionsError ? (
              <div className="td-error-row">gate activity unavailable</div>
            ) : gateDecisions.length === 0 ? (
              <div className="td-empty-line">no gate decisions yet</div>
            ) : gateWorkerIds.length <= 1 ? (
              gateDecisions.slice(0, 6).map((d) => (
                <GateRow
                  key={d.seq}
                  d={d}
                  isOpen={expandedGateSeq === d.seq}
                  onToggle={() => setExpandedGateSeq(expandedGateSeq === d.seq ? null : d.seq)}
                />
              ))
            ) : (
              gateWorkerIds.map((workerId) => {
                const workerDecisions = gateDecisions.filter((d) => d.workerId === workerId);
                const latest = workerDecisions[0];
                const isWorkerOpen = expandedGateWorker === workerId;
                return (
                  <div className="td-gate-worker-group" key={workerId}>
                    <button
                      type="button"
                      className="td-gate-worker-toggle"
                      aria-expanded={isWorkerOpen}
                      onClick={() => setExpandedGateWorker(isWorkerOpen ? null : workerId)}
                    >
                      <span aria-hidden="true">{isWorkerOpen ? "▾" : "▸"}</span>
                      <span className="mono">{workerId}</span>
                      <span className="td-muted">
                        {workerDecisions.length} decision{workerDecisions.length === 1 ? "" : "s"}
                      </span>
                      <span className="td-sp" />
                      <span className="td-muted">{gateLevelPhrase(latest.effectiveLevel)}</span>
                    </button>
                    {isWorkerOpen &&
                      workerDecisions.slice(0, 6).map((d) => (
                        <GateRow
                          key={d.seq}
                          d={d}
                          isOpen={expandedGateSeq === d.seq}
                          onToggle={() => setExpandedGateSeq(expandedGateSeq === d.seq ? null : d.seq)}
                          indent
                        />
                      ))}
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
            <strong>
              {typeof sessionsCount === "number" ? sessionsCount : "—"}
              {sessionsDelta ? (
                <span
                  className={`td-kv-delta ${sessionsDelta > 0 ? "td-ok" : "td-err"}`}
                  title="change since the last poll"
                >
                  {" "}
                  {sessionsDelta > 0 ? "↑" : "↓"}
                  {Math.abs(sessionsDelta)}
                </span>
              ) : null}
            </strong>
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
          {bridgeStatus.toolRateLimit && (
            <div className="td-kv-row td-rate-budget">
              <span className="td-muted">rate budget</span>
              <strong>
                {bridgeStatus.toolRateLimit.remaining}/{bridgeStatus.toolRateLimit.limit} min
              </strong>
              <div className="td-bar2" aria-hidden="true">
                <span
                  style={{
                    width: `${Math.round(
                      (bridgeStatus.toolRateLimit.remaining / Math.max(1, bridgeStatus.toolRateLimit.limit)) * 100,
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}
          {activityHeatmap.cells.some((c) => c.count > 0) && (
            <div className="td-heatmap-block">
              {/* GitHub-contribution-graph styling (rounder cells, tick
                  labels, a Less→More legend) adapted to what's actually
                  true of this data: 24 hours, not 52 weeks, so the ticks
                  read "24h ago…now" instead of month names, and the count
                  line is framed as "events" not "contributions". */}
              <div className="td-heatmap-count td-muted">
                {activityHeatmap.cells.reduce((sum, c) => sum + c.count, 0)} events in the last 24h
              </div>
              <div className="td-heatmap-ticks td-muted" aria-hidden="true">
                <span>24h ago</span>
                <span>18h ago</span>
                <span>12h ago</span>
                <span>6h ago</span>
                <span>now</span>
              </div>
              <div className="td-heatmap" title="activity in the last 24h, one cell per hour, oldest on the left">
                {activityHeatmap.cells.map((cell, i) => {
                  const tier =
                    cell.errors > 0
                      ? "er"
                      : cell.count === 0
                        ? ""
                        : cell.count >= activityHeatmap.maxCount * 0.66
                          ? "l3"
                          : cell.count >= activityHeatmap.maxCount * 0.33
                            ? "l2"
                            : "l1";
                  const hoursAgo = activityHeatmap.cells.length - 1 - i;
                  return (
                    <span
                      key={i}
                      className={`td-heatmap-cell${tier ? ` td-heatmap-${tier}` : ""}`}
                      title={`${cell.count} event${cell.count === 1 ? "" : "s"}${cell.errors > 0 ? `, ${cell.errors} error${cell.errors === 1 ? "" : "s"}` : ""}, ${hoursAgo}h-${hoursAgo + 1}h ago`}
                    />
                  );
                })}
              </div>
              <div className="td-heatmap-legend td-muted" aria-hidden="true">
                <span>Less</span>
                <span className="td-heatmap-cell" />
                <span className="td-heatmap-cell td-heatmap-l1" />
                <span className="td-heatmap-cell td-heatmap-l2" />
                <span className="td-heatmap-cell td-heatmap-l3" />
                <span>More</span>
              </div>
            </div>
          )}
        </Pane>

        {/* 6: inbox */}
        <Pane
          index={6}
          id="inbox"
          title="inbox"
          activePane={activePane}
          setActivePane={setActivePane}
          href="/inbox"
          headerExtra={
            inboxUnreadCount > 0 ? (
              <span className="td-muted">· {inboxUnreadCount} unread</span>
            ) : null
          }
        >
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
                  className={`td-inbox-row${isNew ? " td-inbox-row-unread" : ""}`}
                  key={item.name}
                  onClick={() => markInboxSeen(item.name)}
                >
                  <span className="td-inbox-row-top">
                    {isNew ? (
                      <span className="td-pill td-pill-warn">NEW</span>
                    ) : (
                      <span className="td-muted td-inbox-read">read</span>
                    )}
                    <span className="td-inbox-preview">
                      {previewText(item.preview, 60) || item.name}
                    </span>
                  </span>
                  {item.provenance?.recipe && (
                    <span className="td-inbox-byline">
                      produced by <span className="mono">{item.provenance.recipe}</span>
                      {item.provenance.runSeq != null ? ` · run #${item.provenance.runSeq}` : ""}
                    </span>
                  )}
                </Link>
              );
            })
          )}
        </Pane>
      </div>

      {/* 7:copilot — chat proposes, buttons dispose. Every action card
          calls the same gated hook the rest of the deck already uses
          (toggleRecipeEnabled / runRecipe) — never a raw endpoint POST. */}
      <div className="td-copilot">
        <div className="td-copilot-head">
          <span className="td-pane-tag">7:copilot</span>
          <span className="td-muted">
            · chat proposes, buttons dispose — every action hits the same gate as cron
          </span>
        </div>
        <div
          className="td-copilot-msgs"
          ref={copilotMsgsRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          onScroll={(e) => {
            const el = e.currentTarget;
            copilotNearBottomRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {copilotMessages.length === 0 && (
            <div className="td-copilot-empty">
              ask or act: pause · run · why did X halt…
            </div>
          )}
          {copilotMessages.map((m) => (
            <div
              key={m.id}
              className={`td-copilot-msg td-tail-enter ${m.role === "user" ? "td-copilot-msg-user" : "td-copilot-msg-bot"}`}
            >
              {m.role === "bot" && <span className="td-copilot-who">◆ copilot</span>}
              {m.text}
              {m.action && (
                <div
                  className={`td-copilot-act td-tail-enter${["done", "undoing", "undone"].includes(m.action.status) ? " done" : ""}`}
                >
                  <div className="td-copilot-act-head">
                    <span className={`td-pill${m.action.kind === "run_recipe" ? " td-pill-accent" : ""}`}>
                      {m.action.kind === "run_recipe" ? "run" : "lever"}
                    </span>
                    <strong>{recipeDisplayName(m.action.recipeName)}</strong>
                    {m.action.status === "done" && (
                      <span className="td-pill td-pill-ok">✓ done</span>
                    )}
                    {m.action.status === "undone" && (
                      <span className="td-pill">↺ undone</span>
                    )}
                  </div>
                  {(m.action.status === "pending" || m.action.status === "running") && (
                    <div className="td-copilot-act-actions">
                      <button
                        type="button"
                        className="btn sm primary"
                        disabled={m.action.status === "running"}
                        onClick={() => void confirmCopilotAction(m)}
                      >
                        {m.action.status === "running" ? "working…" : "Confirm"}
                      </button>
                      <button
                        type="button"
                        className="btn sm ghost"
                        disabled={m.action.status === "running"}
                        onClick={() =>
                          setCopilotMessages((prev) =>
                            prev.map((pm) =>
                              pm.id === m.id ? { ...pm, action: undefined } : pm,
                            ),
                          )
                        }
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                  {(m.action.status === "done" || m.action.status === "undoing") &&
                    m.action.kind !== "run_recipe" && (
                      <div className="td-copilot-act-actions">
                        <button
                          type="button"
                          className="btn sm ghost"
                          disabled={m.action.status === "undoing"}
                          onClick={() => void undoCopilotAction(m)}
                        >
                          {m.action.status === "undoing" ? "undoing…" : "Undo"}
                        </button>
                      </div>
                    )}
                </div>
              )}
            </div>
          ))}
          {copilotSending && (
            <div className="td-copilot-msg td-copilot-thinking">
              <span className="td-copilot-who">◆ copilot</span>thinking…
            </div>
          )}
        </div>
        <form
          className="td-copilot-in"
          onSubmit={(e) => {
            e.preventDefault();
            void sendCopilotMessage();
          }}
        >
          <span className="td-copilot-prompt" aria-hidden="true">❯</span>
          <input
            type="text"
            value={copilotInput}
            onChange={(e) => setCopilotInput(e.target.value)}
            placeholder="ask or act: pause · run · why did X halt…"
            aria-label="Copilot chat input"
            disabled={copilotSending}
          />
          <button
            type="submit"
            className="td-copilot-send"
            disabled={copilotSending || !copilotInput.trim()}
            aria-label="Send message"
          >
            ↵
          </button>
        </form>
      </div>

      {/* Phase 4: footer hint — usePaneShortcut (0-6 focus, Enter open)
          had zero on-screen discoverability; a keyboard-only feature with
          no visible hint is undiscoverable UI. */}
      <div className="td-footer" aria-hidden="true">
        <span className="td-muted">0–6 focus a pane · Enter open it · copilot proposes, buttons dispose</span>
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
