"use client";
import { type CSSProperties, useState } from "react";
import { EmptyState, ErrorState, HBarList } from "@/components/patchwork";
import { SkeletonList } from "@/components/Skeleton";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { apiPath } from "@/lib/api";

interface BoardRow {
  classKey: string;
  level: number;
  observations: number;
  mean: number;
  /** False = the worker performed this class but does not own it — the live
   *  gate floors it to L0 regardless of accrued evidence (mirrors the CLI's
   *  `workers shadow` "⚠ NOT OWNED" flag). */
  owned: boolean;
}
interface Divergence {
  classKey: string;
  toolName: string;
  ramp: string;
  gate: string;
  at: number;
  note: string;
}
/** A promote/demote milestone in a worker's trust journey. */
interface AuditEvent {
  type: "promote" | "demote";
  classKey: string;
  from: number;
  to: number;
  at: number;
  evidence: number;
  reason: string;
  workerId: string;
}
interface WorkerReport {
  workerId: string;
  name: string;
  autonomyCeiling: number;
  board: BoardRow[];
  events: AuditEvent[];
  compared: number;
  agreed: number;
  divergences: Divergence[];
}
interface ShadowResponse {
  workers: WorkerReport[];
  runsScanned: number;
  decisionsScanned: number;
  generatedAt?: string;
}

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
  return DOMAIN_LABELS[domain] ?? domain;
}
function taskStakes(classKey: string): string {
  const tier = classKey.split(":")[2] ?? "";
  return STAKES_LABELS[tier] ?? "";
}
/** The reversibility segment of the classKey. Reversible actions bypass the
 *  gate unconditionally (they're easily undone), so the autonomy ceiling never
 *  restricts them — "capped" and "ready to promote" are meaningless there. */
function isReversible(classKey: string): boolean {
  return classKey.split(":")[1] === "reversible";
}
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
function ConsideredApprovalPanel({ expert }: { expert: boolean }) {
  const { data } = useBridgeFetch<KpiResponse>("/api/bridge/approvals/kpi", {
    intervalMs: 30000,
  });
  // Render only with real KPI data: `!data.total` catches both the empty case
  // (total 0) and a non-KPI/error payload (total undefined), so the panel never
  // crashes on an unexpected shape.
  if (!data || !data.total) return null;
  const rubberStamp = data.decided >= 5 && data.rejectRate === 0;
  const rejectPct = pct(data.rejectRate);
  return (
    <div className="card" style={{ marginTop: "var(--s-4)" }}>
      <div className="card-head">
        <strong>
          Are you really reviewing —{" "}
          <span className="accent">or rubber-stamping?</span>
        </strong>
        <span className="pill muted">{data.decided} you decided</span>
      </div>
      {rubberStamp ? (
        <div
          className="editorial-sub"
          style={{ fontFamily: "inherit", color: "var(--warn)" }}
        >
          ⚠ You approved all {data.decided} requests with no rejections. A perfect
          record like that usually means clicking “yes” without really checking —
          so the trust below may be inflated, not earned.
        </div>
      ) : (
        <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
          You’ve reviewed {data.decided} requests and said no {rejectPct}% of the
          time
          {data.abandoned > 0 ? `, and left ${data.abandoned} undecided` : ""}. A
          healthy amount of “no” is a sign you’re really looking.
        </div>
      )}
      {expert && (
        <>
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
        </>
      )}
    </div>
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
function AwaitingConfirmationPanel({ expert }: { expert: boolean }) {
  const { data, status, refetch } = useBridgeFetch<PendingResponse>(
    "/api/bridge/outcomes/pending",
    { intervalMs: 30000 },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pending = data?.pending ?? [];

  // Empty AND the endpoint answered (200) → the loop exists and is drained; say
  // so, rather than vanishing (which reads as "feature missing"). On a bridge
  // too old to serve /outcomes/pending (404 → status stays null / non-200) the
  // panel suppresses entirely, so this never false-signals "clear".
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
          <UrlCell url={p.issueUrl} />
          <span className="pill muted">
            {p.workerName} · {expert ? p.classKey : taskName(p.classKey)}
          </span>
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
function FiledOutcomesPanel({ expert }: { expert: boolean }) {
  const { data, refetch } = useBridgeFetch<OutcomesResponse>(
    "/api/bridge/outcomes",
    { intervalMs: 30000 },
  );
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

  return (
    <div className="card" style={{ marginTop: "var(--s-4)" }}>
      <div className="card-head">
        <strong>
          Did the workers get it right? —{" "}
          <span className="accent">your verdicts.</span>
        </strong>
        <span className="pill muted">
          {outcomes.length} reviewed
          {confirmedCount > 0 && ` · ${confirmedCount} real`}
          {junkCount > 0 && ` · ${junkCount} not real`}
        </span>
      </div>
      <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
        A worker only earns trust once you confirm its work was real — it can’t
        grade its own homework. Change your mind anytime; the latest verdict wins.
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
                  fontSize: 11,
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
                fontSize: 11,
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

/**
 * One worker — led by the DECISION an owner cares about ("can I give it more
 * independence yet?"), then a plain per-task record. The engine view (the L0–L4
 * dial bars, action-class keys, ramp-vs-gate) lives under "Show details".
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
      ? { label: "New", bg: "var(--surface-2)", fg: "inherit" }
      : top
        ? { label: "Ready to advance", bg: "var(--ok)", fg: "var(--bg)" }
        : { label: "Proving itself", bg: "var(--surface-2)", fg: "inherit" };

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

  return (
    <div className="card" style={{ marginTop: "var(--s-4)" }}>
      <div className="card-head">
        <strong>{w.name}</strong>
        <span style={{ display: "flex", gap: "var(--s-2)" }}>
          <span
            className="pill"
            style={{ background: status.bg, color: status.fg }}
          >
            {status.label}
          </span>
          <span className="pill muted">
            {expert
              ? `ceiling L${w.autonomyCeiling}`
              : `max: ${PLAIN_LEVEL_SHORT[w.autonomyCeiling] ?? `L${w.autonomyCeiling}`}`}
          </span>
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
  );
}

export default function WorkersPage() {
  const { data, error, loading, refetch } = useBridgeFetch<ShadowResponse>(
    "/api/bridge/workers/shadow",
    { intervalMs: 30000 },
  );
  const [expert, setExpert] = useState(false);
  const now = data?.generatedAt ? Date.parse(data.generatedAt) : Date.now();

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

  return (
    <section>
      <div className="page-head">
        <div>
          <h1 className="editorial-h1" style={{ margin: 0 }}>
            Workers —{" "}
            <span className="accent">how far you can trust each one.</span>
          </h1>
          <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
            How much independence each AI worker has earned from its track record.
            Looking here never changes what a worker is allowed to do.
          </div>
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
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => setExpert((e) => !e)}
          >
            {expert ? "Plain view" : "Show details"}
          </button>
        </div>
      </div>

      <ConsideredApprovalPanel expert={expert} />

      <AwaitingConfirmationPanel expert={expert} />

      <FiledOutcomesPanel expert={expert} />

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
          style={{ fontFamily: "inherit", marginTop: "var(--s-4)" }}
        >
          <strong>
            Your team — {workers.length} worker
            {workers.length === 1 ? "" : "s"}
          </strong>
          {readyCount > 0 &&
            ` · ${readyCount} ready to advance (shown first)`}
          . As you add workers that hand off to each other, this is where you’ll
          watch the whole team’s trust grow together.
        </div>
      )}

      {workers.map((w) => (
        <WorkerCard key={w.workerId} w={w} expert={expert} now={now} />
      ))}
    </section>
  );
}
