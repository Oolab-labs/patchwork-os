"use client";
import { type CSSProperties, useState } from "react";
import { EmptyState, ErrorState, HBarList } from "@/components/patchwork";
import { SkeletonList } from "@/components/Skeleton";
import { DotStrip } from "@/components/DotStrip";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { apiPath } from "@/lib/api";
import {
  DetailsFold,
  ExpertToggle,
  useExpertMode,
} from "@/components/DetailsFold";
import {
  isReversible,
  taskName as sharedTaskName,
  type AuditEvent,
  type BoardRow,
  type Divergence,
  type ShadowResponse,
  type WorkerReport,
} from "@/lib/workerTrust";

export type { AuditEvent, BoardRow, Divergence, ShadowResponse, WorkerReport };

interface LatencyStats {
  count: number;
  medianMs: number;
  p90Ms: number;
}
interface ToolKpi {
  toolName: string;
  decided: number;
  rejected: number;
  rejectRate: number;
  latency: LatencyStats | null;
  channels: Record<string, number>;
}
interface KpiResponse {
  total: number;
  decided: number;
  approved: number;
  rejected: number;
  abandoned: number;
  rejectRate: number;
  latency: LatencyStats | null;
  channels: Record<string, number>;
  byTool: ToolKpi[];
}

// ── Plain-language vocabulary ───────────────────────────────────────────────
// The whole page speaks in the gate's engine terms (levels, ceilings,
// action-classes, Bayesian means). These maps translate them for the owner who
// is deciding how far to trust a worker — the engine terms stay available under
// "Show details". Index = trust level 0–4 → what the worker may do at it.
const LEVEL_LABELS = [
  "L0 suggest",
  "L1 approve-each",
  "L2 act+undo",
  "L3 act+sample",
  "L4 autonomous",
];
/** What the worker may DO at each level, in plain words (verb phrase). */
const PLAIN_LEVELS = [
  "only suggest what to do",
  "ask you before each action",
  "act on its own, and you can undo it",
  "act on its own, with spot-checks",
  "act fully on its own",
];
/** Short chip form of each level. */
const PLAIN_LEVEL_SHORT = [
  "suggests only",
  "asks first",
  "acts + undo",
  "acts + spot-check",
  "on its own",
];
/** The classKey is `domain:reversibility:blastTier` — plain names per part. */
const DOMAIN_LABELS: Record<string, string> = {
  issue: "filing issues",
  "fs-write": "changing files",
  "fs-read": "reading files",
  "vcs-read": "reading code history",
  "vcs-remote": "pushing to GitHub",
  "vcs-merge": "merging code",
  "vcs-local": "local commits",
  messaging: "sending messages",
  ci: "running tests / CI",
  net: "network requests",
  other: "other actions",
};
const STAKES_LABELS: Record<string, string> = {
  low: "low stakes",
  medium: "medium stakes",
  high: "high stakes",
};
function taskName(classKey: string): string {
  const domain = classKey.split(":")[0] ?? classKey;
  return DOMAIN_LABELS[domain] ?? sharedTaskName(classKey);
}
function taskStakes(classKey: string): string {
  const tier = classKey.split(":")[2] ?? "";
  return STAKES_LABELS[tier] ?? "";
}
// isReversible now imported from @/lib/workerTrust (shared with /today).
function levelPhrase(n: number): string {
  return PLAIN_LEVELS[n] ?? `level ${n}`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
const fmtLat = (l: LatencyStats | null): string =>
  l ? `${fmtMs(l.medianMs)} med · ${fmtMs(l.p90Ms)} p90` : "—";
const channelStr = (c: Record<string, number> | undefined): string =>
  Object.entries(c ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
const pct = (x: number): number => Math.round(x * 100);

/**
 * "Are you really reviewing?" — the honesty lens beside the dial. Trust only
 * means something if the approvals behind it were considered; a 0% reject rate
 * over a real sample is the clearest tell of rubber-stamping. Plain by default;
 * the reject-rate / latency / per-tool telemetry lives under "Show details".
 */
/**
 * The rubber-stamp honesty check, collapsed for Band 1. Trust means nothing if
 * the approvals behind it weren't considered; a 0%-reject record over a real
 * sample is the clearest tell. In the default view this is a SINGLE amber
 * sentence, shown ONLY when it triggers; the full reject-rate / latency /
 * per-tool telemetry moves under "Show details".
 */
function ConsideredApproval() {
  const { data } = useBridgeFetch<KpiResponse>("/api/bridge/approvals/kpi", {
    intervalMs: 30000,
  });
  // Render only with real KPI data: `!data.total` catches both the empty case
  // (total 0) and a non-KPI/error payload (total undefined).
  if (!data || !data.total) return null;
  const rubberStamp = data.decided >= 5 && data.rejectRate === 0;
  const rejectPct = pct(data.rejectRate);
  return (
    <>
      {rubberStamp && (
        <div
          className="editorial-sub"
          style={{
            fontFamily: "inherit",
            color: "var(--warn)",
            marginTop: "var(--s-2)",
          }}
        >
          ⚠ Heads up: you’ve approved all {data.decided} requests without ever
          saying no. A perfect record usually means clicking “yes” without really
          checking — so the trust below may be inflated, not earned.
        </div>
      )}
      <DetailsFold>
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <strong>
              Are you really reviewing —{" "}
              <span className="accent">or rubber-stamping?</span>
            </strong>
            <span className="pill muted">{data.decided} you decided</span>
          </div>
          <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
            You’ve reviewed {data.decided} requests and said no {rejectPct}% of
            the time
            {data.abandoned > 0 ? `, and left ${data.abandoned} undecided` : ""}.
            A healthy amount of “no” is a sign you’re really looking.
          </div>
          <div
            style={{
              display: "flex",
              gap: "var(--s-4)",
              flexWrap: "wrap",
              marginTop: "var(--s-3)",
            }}
          >
            <span
              className="pill"
              style={{
                background: rubberStamp ? "var(--warn)" : "var(--surface-2)",
                color: rubberStamp ? "var(--bg)" : "inherit",
              }}
            >
              reject rate {rejectPct}%
            </span>
            <span className="pill muted">latency {fmtLat(data.latency)}</span>
            {data.abandoned > 0 && (
              <span className="pill muted">{data.abandoned} abandoned</span>
            )}
            <span className="pill muted">{channelStr(data.channels)}</span>
          </div>
          {data.latency === null && (
            <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
              Latency captures from the next decision forward (it cannot be
              backfilled).
            </div>
          )}
          {data.byTool.map((t) => (
            <div className="suggestion-row" key={t.toolName}>
              {t.toolName} — decided {t.decided} · reject {pct(t.rejectRate)}% ·{" "}
              {fmtLat(t.latency)} · {channelStr(t.channels)}
            </div>
          ))}
        </div>
      </DetailsFold>
    </>
  );
}

type Disposition = "confirmed" | "junk" | "unknown";
interface OutcomeRecord {
  issueUrl: string;
  disposition: Disposition;
  checkedAt: number;
  recipeName?: string;
  workerClass?: string;
}
interface OutcomesResponse {
  outcomes: OutcomeRecord[];
}

/** Plain label for a disposition (the raw value shows under "Show details"). */
const DISPOSITION_LABEL: Record<Disposition, string> = {
  confirmed: "looks real",
  junk: "not real",
  unknown: "not reviewed",
};
function dispositionStyle(d: Disposition): CSSProperties {
  if (d === "confirmed") return { background: "var(--ok)", color: "var(--bg)" };
  if (d === "junk") return { background: "var(--warn)", color: "var(--bg)" };
  return { background: "var(--surface-2)" };
}

interface PendingConfirmation {
  issueUrl: string;
  recipeName: string;
  workerId: string;
  workerName: string;
  filedAt: number;
  classKey: string;
  /** Human title captured at filing time (bridge #1078+); falls back to URL. */
  title?: string;
}
interface PendingResponse {
  pending: PendingConfirmation[];
}

/** Render a URL as a link only for http(s) — never emit a raw href for a
 *  non-web-scheme URL (defence-in-depth against a javascript: URL, which React
 *  does not sanitise, even though every write path validates http(s)). */
function UrlCell({ url }: { url: string }) {
  const style: CSSProperties = {
    flex: 1,
    minWidth: "12rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
  return /^https?:\/\//i.test(url) ? (
    <a href={url} target="_blank" rel="noreferrer" style={style}>
      {url}
    </a>
  ) : (
    <span style={style}>{url}</span>
  );
}

/**
 * "Needs your review" — the CONFIRM QUEUE. Things a worker created (issue
 * filings) that have no verdict yet: they don't count toward the worker's
 * record until you say whether they're real. Read-only join over the run log +
 * dispositions (GET /outcomes/pending); one-click confirm/reject POSTs to the
 * Bearer-gated /outcomes route (never a recipe step — a worker can't grade its
 * own homework) and the queue refreshes.
 */
function ReviewQueue({
  pending,
  status,
  refetch,
  expert,
  now,
}: {
  pending: PendingConfirmation[];
  status: number | null;
  refetch: () => void;
  expert: boolean;
  now: number;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Empty AND the endpoint answered (200) → the loop exists and is drained; say
  // so, rather than vanishing (which reads as "feature missing"). On a bridge
  // too old to serve /outcomes/pending (404 → status non-200) the panel
  // suppresses entirely, so this never false-signals "clear".
  if (pending.length === 0) {
    if (status !== 200) return null;
    return (
      <div className="card" style={{ marginTop: "var(--s-4)" }}>
        <div className="card-head">
          <strong>
            Needs your review — <span className="accent">all caught up.</span>
          </strong>
          <span
            className="pill"
            style={{ background: "var(--ok)", color: "var(--bg)" }}
          >
            0 waiting
          </span>
        </div>
        <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
          Nothing’s waiting on you — you’ve reviewed everything the workers filed.
        </div>
      </div>
    );
  }

  async function act(p: PendingConfirmation, disposition: "confirmed" | "junk") {
    setBusy(`${p.issueUrl}:${disposition}`);
    setErr(null);
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
      if (!res.ok) {
        setErr(`Update failed (${res.status})`);
        return;
      }
      refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" style={{ marginTop: "var(--s-4)" }}>
      <div className="card-head">
        <strong>
          Needs your review — <span className="accent">is it real?</span>
        </strong>
        <span
          className="pill"
          style={{ background: "var(--warn)", color: "var(--bg)" }}
        >
          {pending.length} waiting
        </span>
      </div>
      <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
        Things the workers created that need your yes/no. Until you decide, they
        don’t count toward a worker’s record — so this queue is the one thing
        holding trust back.
      </div>
      {err && (
        <div
          className="editorial-sub"
          style={{ fontFamily: "inherit", color: "var(--warn)" }}
        >
          {err}
        </div>
      )}
      {pending.map((p) => (
        <div
          className="suggestion-row"
          key={p.issueUrl}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--s-3)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: "16rem" }}>
            <div style={{ fontWeight: 600 }}>
              {p.workerName} filed:{" "}
              <span style={{ fontWeight: 500 }}>
                {p.title ?? "a new issue"}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                gap: "var(--s-2)",
                alignItems: "center",
                marginTop: 2,
              }}
            >
              <UrlCell url={p.issueUrl} />
              <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>
                {relTime(p.filedAt, now)}
                {expert ? ` · ${p.classKey}` : ""}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn sm primary"
            disabled={busy !== null}
            onClick={() => act(p, "confirmed")}
          >
            Looks real
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy !== null}
            onClick={() => act(p, "junk")}
          >
            Not real
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * "Did the workers get it right?" — the record of things a worker created and
 * your verdict on each. A worker only earns trust once YOU confirm its work was
 * real; it can't grade its own homework. POSTs to the Bearer-gated /outcomes
 * route through the generic bridge proxy.
 */
function PastVerdicts({ expert }: { expert: boolean }) {
  const { data, refetch } = useBridgeFetch<OutcomesResponse>(
    "/api/bridge/outcomes",
    { intervalMs: 30000 },
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const outcomes = data?.outcomes ?? [];
  // Nothing filed yet → don't clutter the page (the confirm loop has no queue).
  if (outcomes.length === 0) return null;
  const confirmedCount = outcomes.filter(
    (o) => o.disposition === "confirmed",
  ).length;
  const junkCount = outcomes.filter((o) => o.disposition === "junk").length;

  async function setDisposition(issueUrl: string, disposition: Disposition) {
    setBusy(`${issueUrl}:${disposition}`);
    setErr(null);
    try {
      const res = await fetch(apiPath("/api/bridge/outcomes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueUrl, disposition }),
      });
      if (!res.ok) {
        setErr(`Update failed (${res.status})`);
        return;
      }
      refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // Verdict history is reference material, not daily work — collapse it to one
  // disclosure line under the review queue. "Past verdicts (12 · 10 real, 2 not) ▾"
  return (
    <div style={{ marginTop: "var(--s-3)" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontSize: "var(--fs-s)",
          fontWeight: 500,
          color: "var(--ink-2)",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        Past verdicts ({outcomes.length}
        {confirmedCount > 0 && ` · ${confirmedCount} real`}
        {junkCount > 0 && ` · ${junkCount} not real`})
      </button>
      {!open ? null : (
        <div className="card" style={{ marginTop: "var(--s-3)" }}>
          <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
            A worker only earns trust once you confirm its work was real — it
            can’t grade its own homework. Change your mind anytime; the latest
            verdict wins.
          </div>
      {err && (
        <div
          className="editorial-sub"
          style={{ fontFamily: "inherit", color: "var(--warn)" }}
        >
          {err}
        </div>
      )}
      {outcomes.map((o) => {
        const ctx = expert
          ? [o.recipeName, o.workerClass].filter(Boolean).join(" · ")
          : o.workerClass
            ? taskName(o.workerClass)
            : "";
        return (
          <div
            className="suggestion-row"
            key={o.issueUrl}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-3)",
              flexWrap: "wrap",
            }}
          >
            <span className="pill" style={dispositionStyle(o.disposition)}>
              {expert ? o.disposition : DISPOSITION_LABEL[o.disposition]}
            </span>
            <UrlCell url={o.issueUrl} />
            {ctx && <span className="pill muted">{ctx}</span>}
            <button
              type="button"
              className="btn sm primary"
              disabled={busy !== null || o.disposition === "confirmed"}
              onClick={() => setDisposition(o.issueUrl, "confirmed")}
            >
              Looks real
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy !== null || o.disposition === "junk"}
              onClick={() => setDisposition(o.issueUrl, "junk")}
            >
              Not real
            </button>
          </div>
        );
      })}
        </div>
      )}
    </div>
  );
}

function levelColor(effective: number): string {
  if (effective >= 4) return "var(--ok)";
  if (effective >= 2) return "var(--warn)";
  return "var(--line-3)";
}

// ── The trust journey ───────────────────────────────────────────────────────
// Every worker travels the same 5-stop path from "just watching" to "fully
// trusted". Where it stands (and how it got there) is the story an owner wants.
const JOURNEY_STOPS = [
  "Just watching",
  "Asks first",
  "Acts, you undo",
  "Acts, checked",
  "Fully trusted",
];

const BLAST_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** The worker's "main job": the highest-stakes OWNED, non-reversible task — the
 *  one the leash is really about. Falls back to any owned task. */
function primaryJob(w: WorkerReport): BoardRow | undefined {
  const owned = w.board.filter((b) => b.owned);
  const risky = owned.filter((b) => !isReversible(b.classKey));
  const pool = risky.length ? risky : owned;
  if (pool.length === 0) return undefined;
  return [...pool].sort(
    (a, b) =>
      (BLAST_RANK[b.classKey.split(":")[2] ?? ""] ?? 0) -
        (BLAST_RANK[a.classKey.split(":")[2] ?? ""] ?? 0) || b.level - a.level,
  )[0];
}

function relTime(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * The journey track — 5 stops, filled up to what the worker has EARNED on its
 * main job, with a flag at the leash (the max you allow) and a ring on where it
 * stands right now. One glance says how far along a worker is; stack them and a
 * whole team is scannable.
 */
function JourneyStepper({
  earned,
  ceiling,
}: {
  earned: number;
  ceiling: number;
}) {
  const effective = Math.min(earned, ceiling);
  return (
    <div style={{ display: "flex", marginTop: "var(--s-4)" }}>
      {JOURNEY_STOPS.map((stop, i) => {
        const reached = i <= earned;
        return (
          <div
            key={stop}
            style={{ flex: 1, position: "relative", paddingTop: 14 }}
          >
            {i > 0 && (
              <div
                style={{
                  position: "absolute",
                  top: 14 + 6,
                  left: "-50%",
                  width: "100%",
                  height: 2,
                  background: reached ? "var(--ok)" : "var(--line-3)",
                }}
              />
            )}
            {i === ceiling && (
              <div
                className="muted"
                style={{
                  position: "absolute",
                  top: -2,
                  left: 0,
                  right: 0,
                  textAlign: "center",
                  fontSize: "var(--fs-xs)",
                }}
              >
                ⚑ leash
              </div>
            )}
            <div
              style={{
                position: "relative",
                width: 13,
                height: 13,
                borderRadius: 999,
                margin: "0 auto",
                background: reached ? "var(--ok)" : "var(--surface-2)",
                border: reached ? "none" : "1px solid var(--line-3)",
                boxShadow:
                  i === effective ? "0 0 0 3px var(--accent)" : "none",
              }}
            />
            <div
              style={{
                textAlign: "center",
                marginTop: 6,
                fontSize: "var(--fs-xs)",
                color: reached ? "inherit" : "var(--line-3)",
              }}
            >
              {stop}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * "How it got here" — the worker's promote/demote milestones in plain words,
 * newest first. This is the trust journey's *history*: each step it climbed (or
 * slipped), what it was doing, and how much evidence it took.
 */
function JourneyTimeline({
  events,
  now,
}: {
  events: AuditEvent[];
  now: number;
}) {
  if (events.length === 0) return null;
  const recent = [...events].sort((a, b) => b.at - a.at).slice(0, 6);
  return (
    <div style={{ marginTop: "var(--s-3)" }}>
      <div
        className="editorial-sub"
        style={{ fontFamily: "inherit", marginBottom: "var(--s-2)" }}
      >
        <strong>How it got here</strong>
      </div>
      {recent.map((e, i) => (
        <div
          className="suggestion-row"
          key={`${e.classKey}-${e.to}-${e.at}-${i}`}
        >
          <span style={{ color: e.type === "promote" ? "var(--ok)" : "var(--warn)" }}>
            {e.type === "promote" ? "▲" : "▼"}
          </span>{" "}
          {e.type === "promote" ? "Earned" : "Slipped back to"} “
          {JOURNEY_STOPS[e.to] ?? `level ${e.to}`}” on {taskName(e.classKey)}
          <span className="muted">
            {" "}
            · after {e.evidence} {e.evidence === 1 ? "try" : "tries"} ·{" "}
            {relTime(e.at, now)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Max trust level (index of the last journey stop) — 0-4, i.e. L0..L4. */
const MAX_LEVEL = JOURNEY_STOPS.length - 1;
/** Circumference of the dial ring at r=27: 2·π·27 ≈ 169.6, rounded per mockup. */
const DIAL_CIRCUMFERENCE = 170;

/**
 * The trust dial — an SVG ring replacing the old 5-stop `RosterBar` strip.
 * Arc length is earned/MAX_LEVEL of the full circumference; a tick mark shows
 * the ceiling (the operator's leash) when it's below the max level. A worker
 * with no history yet gets a dashed "new" ring instead of a filled arc.
 */
function TrustDial({
  earned,
  ceiling,
  hasHistory,
}: {
  earned: number;
  ceiling: number;
  hasHistory: boolean;
}) {
  if (!hasHistory) {
    return (
      <div
        className="wa-dial"
        role="img"
        aria-label="No history yet"
      >
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle
            cx="32"
            cy="32"
            r="27"
            fill="none"
            stroke="var(--recess)"
            strokeWidth="7"
            strokeDasharray="2 5"
          />
        </svg>
        <span className="lvl muted">new</span>
      </div>
    );
  }
  const arc = (earned / MAX_LEVEL) * DIAL_CIRCUMFERENCE;
  const color = levelColor(Math.min(earned, ceiling));
  const leashed = ceiling < MAX_LEVEL;
  const angle = (ceiling / MAX_LEVEL) * 360;
  return (
    <div
      className="wa-dial"
      role="img"
      aria-label={`Earned ${JOURNEY_STOPS[earned] ?? `level ${earned}`}; your limit is ${JOURNEY_STOPS[ceiling] ?? `level ${ceiling}`}`}
    >
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="27" fill="none" stroke="var(--recess)" strokeWidth="7" />
        <circle
          cx="32"
          cy="32"
          r="27"
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${arc} ${DIAL_CIRCUMFERENCE}`}
        />
        {leashed && (
          <line
            x1="32"
            y1="1"
            x2="32"
            y2="12"
            stroke="var(--ink-0)"
            strokeWidth="2.5"
            transform={`rotate(${180 + angle} 32 32)`}
          />
        )}
      </svg>
      <span className="lvl">L{earned}</span>
    </div>
  );
}

/**
 * One worker in the roster — a compact clickable row (avatar, name, job,
 * progress bar, status), expandable to a drawer holding the full journey
 * (stepper, "how it got here", per-task record, ramp-vs-gate). Nothing is
 * deleted — the mega-card's content just moves into the drawer.
 */
function WorkerCard({
  w,
  expert,
  now,
}: {
  w: WorkerReport;
  expert: boolean;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const owned = w.board.filter((b) => b.owned);
  // Ready to promote: an OWNED, non-reversible task where the worker earned a
  // higher level than the ceiling you set — it has proven more than you allow on
  // work that actually needs a leash. Reversible tasks bypass the gate, so their
  // earned level never justifies raising the ceiling (it wouldn't change a thing).
  const promotable = owned
    .filter((b) => !isReversible(b.classKey) && b.level > w.autonomyCeiling)
    .sort((a, b) => b.level - a.level);
  const top = promotable[0];
  const primary = primaryJob(w);
  // The journey/leash only matters for gated (non-reversible) work. A worker
  // whose only owned tasks are reversible runs freely — no stepper, no leash.
  const gatedPrimary =
    primary && !isReversible(primary.classKey) ? primary : undefined;

  const status =
    w.board.length === 0
      ? { label: "⚪ New", bg: "var(--surface-2)", fg: "inherit" }
      : top
        ? { label: "★ Ready for a promotion", bg: "var(--ok)", fg: "var(--bg)" }
        : { label: "Proving itself", bg: "var(--surface-2)", fg: "inherit" };

  // One-line job + one contextual standing line for the collapsed row.
  const jobLine =
    gatedPrimary
      ? taskName(gatedPrimary.classKey)
      : owned.length > 0
        ? "Low-risk helper — only does easily-undone work"
        : "Just getting started";
  const standing = top
    ? `Earned more than its current limit on ${taskName(top.classKey)} — you can give it more freedom.`
    : gatedPrimary
      ? gatedPrimary.level === 0
        ? `Just starting out on ${taskName(gatedPrimary.classKey)}.`
        : gatedPrimary.level < w.autonomyCeiling
          ? `Climbing on ${taskName(gatedPrimary.classKey)} — ${pct(gatedPrimary.mean)}% success over ${gatedPrimary.observations} tries.`
          : `At its limit on ${taskName(gatedPrimary.classKey)}, performing well.`
      : owned.length > 0
        ? "Runs freely — its work is all easily undone."
        : "Building a record as it runs.";

  const effectiveItems = w.board.map((b) => {
    const effective = b.owned ? Math.min(b.level, w.autonomyCeiling) : 0;
    const capped =
      b.owned && b.level > w.autonomyCeiling
        ? ` (earned L${b.level}, capped)`
        : "";
    const notOwned = b.owned
      ? ""
      : `  ⚠ NOT OWNED — gate floors to L0 (earned L${b.level})`;
    return {
      label: b.classKey,
      value: effective,
      color: b.owned ? levelColor(effective) : "var(--warn)",
      sub: `${LEVEL_LABELS[effective] ?? `L${effective}`} · ${b.observations} obs · ${pct(b.mean)}% mean${capped}${notOwned}`,
    };
  });

  // 4-segment progress strip: filled up to the earned level, the segment AT
  // the ceiling is hatched (capped) when a leash is active, the rest empty.
  const hasHistory = w.board.length > 0;
  const earnedLevel = gatedPrimary?.level ?? 0;
  const stepClass = (i: number): string => {
    if (i < earnedLevel) return "f";
    if (i === w.autonomyCeiling && w.autonomyCeiling < MAX_LEVEL) return "cap";
    return "";
  };
  // Reversible-only worker: owns work, none of it gated — runs freely, no leash.
  const reversibleOnly = owned.length > 0 && !gatedPrimary;
  // Last-N dots for the footer — reuses the same board stat the standing line
  // already shows (mean/observations); no separate per-run history exists.
  const dotWindow = gatedPrimary
    ? Math.min(gatedPrimary.observations, 7)
    : 0;
  const dotGood = gatedPrimary
    ? Math.round(gatedPrimary.mean * dotWindow)
    : 0;

  return (
    <article
      className="wa-card card"
      style={top ? { borderColor: "rgba(91,138,79,.45)" } : undefined}
    >
      {/* Collapsed roster row — the whole team is scannable at this level. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-3)",
          color: "inherit",
        }}
      >
        <div className="top">
          <TrustDial
            earned={earnedLevel}
            ceiling={w.autonomyCeiling}
            hasHistory={hasHistory}
          />
          <div className="who" style={{ flex: 1 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--s-2)",
                flexWrap: "wrap",
              }}
            >
              <span className="name">{w.name}</span>
              <span
                className="pill"
                style={{ background: status.bg, color: status.fg }}
              >
                {status.label}
              </span>
            </div>
            <div className="role">{jobLine}</div>
          </div>
          <span aria-hidden="true" className="muted" style={{ flexShrink: 0 }}>
            {open ? "▾" : "▸"}
          </span>
        </div>

        {gatedPrimary && (
          <div
            className="wa-steps"
            role="img"
            aria-label={`earned ${earnedLevel} of ${MAX_LEVEL} steps, leash at step ${w.autonomyCeiling}`}
          >
            {Array.from({ length: MAX_LEVEL }, (_, i) => (
              // Fixed-length ordered strip; index is a stable key here.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional steps
              <i key={i} className={stepClass(i)} />
            ))}
          </div>
        )}

        {gatedPrimary ? (
          <div className="wa-leash">
            <span
              className="dot"
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--ok)",
                display: "inline-block",
              }}
            />
            {standing}
          </div>
        ) : reversibleOnly ? (
          <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
            Runs freely without a leash. Nothing to review — its work can
            always be undone.
          </div>
        ) : (
          <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
            {standing}
          </div>
        )}

        {top && (
          <div className="wa-promote">
            <span>
              ✅ Ready for more independence — {pct(top.mean)}% over{" "}
              {top.observations} tries.
            </span>
          </div>
        )}

        <div className="wa-foot">
          {reversibleOnly ? (
            <span className="pill">reversible only</span>
          ) : gatedPrimary && dotWindow > 0 ? (
            <DotStrip good={dotGood} total={gatedPrimary.observations} max={7} />
          ) : (
            <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>
              no history yet
            </span>
          )}
        </div>
      </button>

      {!open ? null : (
      <div style={{ marginTop: "var(--s-3)", borderTop: "1px solid var(--line-1)", paddingTop: "var(--s-3)" }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <span className="pill muted">
          {expert
            ? `ceiling L${w.autonomyCeiling}`
            : `your limit: ${PLAIN_LEVEL_SHORT[w.autonomyCeiling] ?? `L${w.autonomyCeiling}`}`}
        </span>
      </div>

      {/* Where it is on the journey — the hero. */}
      {gatedPrimary ? (
        <JourneyStepper
          earned={gatedPrimary.level}
          ceiling={w.autonomyCeiling}
        />
      ) : owned.length > 0 ? (
        <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
          Low-risk helper — {w.name} only does easily-undone work, so it runs
          freely without needing a leash.
        </div>
      ) : null}

      {/* Ready-to-advance decision, else a plain standing line. */}
      {top ? (
        <div
          style={{
            border: "1px solid var(--ok)",
            borderRadius: "var(--radius-2, 8px)",
            padding: "var(--s-3)",
            marginTop: "var(--s-3)",
          }}
        >
          <strong>✅ Ready for more independence?</strong>
          <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
            {w.name} has proven it can <strong>{levelPhrase(top.level)}</strong>{" "}
            on <strong>{taskName(top.classKey)}</strong> ({pct(top.mean)}% success
            over {top.observations} tries), but you’ve limited it to{" "}
            <strong>{levelPhrase(w.autonomyCeiling)}</strong>. Raise its limit
            when you’re comfortable.
          </div>
          <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
            To do it: set <code>autonomyCeiling: {top.level}</code> in this
            worker’s <code>.worker.yaml</code> file.
          </div>
        </div>
      ) : gatedPrimary ? (
        <div
          className="editorial-sub"
          style={{ fontFamily: "inherit", marginTop: "var(--s-3)" }}
        >
          {gatedPrimary.level === 0
            ? `Just starting out on its main job, ${taskName(gatedPrimary.classKey)}`
            : gatedPrimary.level < w.autonomyCeiling
              ? `Climbing — earned "${levelPhrase(gatedPrimary.level)}" on ${taskName(gatedPrimary.classKey)}, working toward your leash`
              : `At its leash on ${taskName(gatedPrimary.classKey)}, performing well`}{" "}
          · {pct(gatedPrimary.mean)}% success over {gatedPrimary.observations}{" "}
          tries.
        </div>
      ) : null}

      {/* How it got here — the journey's history. */}
      <JourneyTimeline events={w.events ?? []} now={now} />

      {/* Per-task record. */}
      <div
        className="editorial-sub"
        style={{ fontFamily: "inherit", marginTop: "var(--s-3)" }}
      >
        <strong>What it does</strong>
      </div>
      {w.board.length === 0 ? (
        <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
          Hasn’t done anything yet — this fills in as the worker runs.
        </div>
      ) : expert ? (
        <HBarList items={effectiveItems} max={4} />
      ) : (
        <div>
          {w.board.map((b) => {
            const reversible = isReversible(b.classKey);
            const effective = b.owned ? Math.min(b.level, w.autonomyCeiling) : 0;
            const capped = b.owned && !reversible && b.level > w.autonomyCeiling;
            const status = !b.owned
              ? "not one of its jobs, so it can’t act on its own here"
              : reversible
                ? "can do this on its own (it’s easily undone)"
                : `can ${levelPhrase(effective)}`;
            return (
              <div className="suggestion-row" key={b.classKey}>
                <strong>{taskName(b.classKey)}</strong>{" "}
                <span className="muted">({taskStakes(b.classKey)})</span> —{" "}
                {status}
                {" · "}
                {pct(b.mean)}% success over {b.observations} tries
                {capped && (
                  <div
                    className="editorial-sub"
                    style={{ fontFamily: "inherit" }}
                  >
                    It’s earned enough to {levelPhrase(b.level)} — you’ve capped
                    it at {levelPhrase(w.autonomyCeiling)}.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Engine detail: where the trust score and the live safety-check disagree. */}
      {expert && w.compared > 0 && (
        <div style={{ marginTop: "var(--s-3)" }}>
          <span className="pill muted">
            ramp vs gate: {w.agreed}/{w.compared} agree
          </span>
          {w.divergences.slice(0, 5).map((d, i) => (
            <div
              className="suggestion-row"
              key={`${w.workerId}-${d.toolName}-${i}`}
            >
              ⚠ {d.toolName} — {d.note}
            </div>
          ))}
        </div>
      )}
      </div>
      )}
    </article>
  );
}

export default function WorkersPage() {
  const { data, error, loading, refetch } = useBridgeFetch<ShadowResponse>(
    "/api/bridge/workers/shadow",
    { intervalMs: 30000 },
  );
  // Page-level expert mode (persisted, shared with every DetailsFold). Replaces
  // the old local `expert` useState.
  const { expert } = useExpertMode();
  const now = data?.generatedAt ? Date.parse(data.generatedAt) : Date.now();

  // The confirm queue — lifted here so the Band-1 triage sentence and the
  // Band-2 review queue share one fetch (no double poll).
  const {
    data: pendingData,
    status: pendingStatus,
    refetch: refetchPending,
  } = useBridgeFetch<PendingResponse>("/api/bridge/outcomes/pending", {
    intervalMs: 30000,
  });
  const pending = pendingData?.pending ?? [];

  // Past-verdicts count for the triage tile — same endpoint `PastVerdicts`
  // polls; kept as a separate read here so the tile's count doesn't require
  // threading state through that component's own disclosure/fetch lifecycle.
  const { data: outcomesData } = useBridgeFetch<OutcomesResponse>(
    "/api/bridge/outcomes",
    { intervalMs: 30000 },
  );
  const outcomes = outcomesData?.outcomes ?? [];
  const verdictConfirmed = outcomes.filter(
    (o) => o.disposition === "confirmed",
  ).length;
  const verdictJunk = outcomes.filter((o) => o.disposition === "junk").length;

  // Fleet view: a worker "needs attention" when it's earned past its leash
  // (ready to advance). Sort those first so a team of many workers stays
  // scannable — the ones awaiting a decision rise to the top.
  function readyToAdvance(w: WorkerReport): boolean {
    return w.board.some(
      (b) => b.owned && !isReversible(b.classKey) && b.level > w.autonomyCeiling,
    );
  }
  function rank(w: WorkerReport): number {
    if (readyToAdvance(w)) return 0;
    if (w.board.length === 0) return 2;
    return 1;
  }
  const workers = [...(data?.workers ?? [])].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
  );
  const readyCount = workers.filter(readyToAdvance).length;

  // Band 1 triage: one sentence that answers "who needs my decision?" before
  // any card is read. Only claim the review count when the endpoint answered
  // (a bridge too old to serve the queue must not read as "0 to review").
  const pendingKnown = pendingStatus === 200;
  const reviewCount = pending.length;
  const triageParts: string[] = [];
  if (pendingKnown && reviewCount > 0)
    triageParts.push(
      `${reviewCount} thing${reviewCount === 1 ? "" : "s"} need${reviewCount === 1 ? "s" : ""} your review`,
    );
  if (readyCount > 0)
    triageParts.push(
      `${readyCount} worker${readyCount === 1 ? "" : "s"} ready for a promotion`,
    );
  const allClear = pendingKnown && reviewCount === 0 && readyCount === 0;

  return (
    <section>
      <div className="wa-head">
        <div>
          <h2>
            Your AI team
            {data && workers.length > 0 && (
              <em>
                {" "}
                — {workers.length} worker{workers.length === 1 ? "" : "s"}
              </em>
            )}
          </h2>
          {allClear && (
            <div
              className="editorial-sub"
              style={{ fontFamily: "inherit", display: "flex", alignItems: "center", gap: 8 }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: "var(--ok)",
                  flexShrink: 0,
                }}
              />
              All good — nothing needs you today.
            </div>
          )}
          <ConsideredApproval />
        </div>
        <div
          style={{ display: "flex", gap: "var(--s-3)", alignItems: "center" }}
        >
          {data && (
            <span className="pill muted">
              {expert
                ? `${data.runsScanned} runs · ${data.decisionsScanned} gate decisions`
                : `based on ${data.runsScanned} runs`}
            </span>
          )}
          <ExpertToggle />
        </div>
      </div>

      {/* Triage tiles — replace the old single-sentence dot line. Each links
          to the section below that answers it (review queue, ready-to-advance
          workers, past-verdicts disclosure). Counts are the same ones that
          already fed the old triage sentence / ReviewQueue / PastVerdicts. */}
      {!allClear && (
        <div className="wa-triage">
          {pendingKnown && reviewCount > 0 && (
            <a href="#wa-review-queue">
              <span className="warnbar" aria-hidden="true" />
              <span className="big num">{reviewCount}</span>
              <span className="lbl">
                <strong>need your review</strong>
                <br />
                workers filed issues — are they real?
              </span>
            </a>
          )}
          {readyCount > 0 && (
            <a href="#wa-grid">
              <span className="okbar" aria-hidden="true" />
              <span className="big num">{readyCount}</span>
              <span className="lbl">
                <strong>ready for a promotion</strong>
                <br />
                earned more than you allow
              </span>
            </a>
          )}
          {outcomes.length > 0 && (
            <a href="#wa-past-verdicts">
              <span className="accbar" aria-hidden="true" />
              <span className="big num">{outcomes.length}</span>
              <span className="lbl">
                <strong>past verdicts</strong>
                <br />
                {verdictConfirmed} real · {verdictJunk} not real
              </span>
            </a>
          )}
        </div>
      )}

      <div id="wa-review-queue">
        <ReviewQueue
          pending={pending}
          status={pendingStatus}
          refetch={refetchPending}
          expert={expert}
          now={now}
        />
      </div>

      <div id="wa-past-verdicts">
        <PastVerdicts expert={expert} />
      </div>

      {loading && workers.length === 0 && <SkeletonList rows={3} columns={2} />}

      {error && workers.length === 0 && (
        <ErrorState
          title="Couldn't load workers"
          description="The bridge isn't responding to /workers/shadow."
          error={error}
          onRetry={refetch}
        />
      )}

      {!loading && !error && workers.length === 0 && (
        <EmptyState
          title="No workers set up yet"
          description="Add a worker to ~/.patchwork/workers (copy one from templates/workers/ to start)."
        />
      )}

      {workers.length > 0 && (
        <div
          className="editorial-sub"
          style={{ fontFamily: "inherit", marginTop: "var(--s-4)", marginBottom: "var(--s-3)" }}
        >
          <strong>Your team</strong>
          {readyCount > 0
            ? ` — ${readyCount} ready to advance (shown first).`
            : "."}{" "}
          How much independence each worker has earned from its track record —
          looking here never changes what a worker is allowed to do.
        </div>
      )}

      <div className="wa-grid" id="wa-grid">
        {workers.map((w) => (
          <WorkerCard key={w.workerId} w={w} expert={expert} now={now} />
        ))}
      </div>
    </section>
  );
}
