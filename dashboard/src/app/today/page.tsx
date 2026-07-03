"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPath } from "@/lib/api";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import {
  BlastBadge,
  EmptyState,
  ErrorState,
} from "@/components/patchwork";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import {
  classifyPendingAction,
  reversibilityRank,
  type ClientActionClass,
} from "@/lib/actionClass";
import {
  readyToAdvance,
  topPromotable,
  lastDemotion,
  taskName,
  type ShadowResponse,
  type WorkerReport,
} from "@/lib/workerTrust";
import { describeNextRun, humanizeSchedule } from "@/lib/humanSchedule";
import { useTodayProgress } from "./_useTodayProgress";

const MessageMarkdown = dynamic(() => import("@/components/MessageMarkdown"), {
  ssr: false,
  loading: () => <div aria-busy="true" />,
});

const API = apiPath("/api/bridge");

// ---------------------------------------------------------------- types

interface InboxProvenance {
  recipe?: string;
  runSeq?: number;
  trigger?: string;
  deliveredAt?: number;
}
interface InboxItem {
  name: string;
  path: string;
  modifiedAt: string;
  preview: string;
  provenance?: InboxProvenance;
}
interface InboxDetail {
  name: string;
  content: string;
  modifiedAt: string;
  provenance?: InboxProvenance;
}

interface RiskSignal {
  kind: string;
  label: string;
  severity: "low" | "medium" | "high";
}
interface Pending {
  callId: string;
  toolName: string;
  tier: "low" | "medium" | "high";
  requestedAt: number;
  summary?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  expiresAt?: number;
  riskSignals?: RiskSignal[];
}

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

interface HaltSummary {
  total: number;
}

interface RecipeDetail {
  name: string;
  schedule?: string;
}

// ---------------------------------------------------------------- read-state
// Today's own "have I read this brief" store — inbox's `seenNames` is
// in-memory only (resets on every page load, confirmed by reading
// app/inbox/page.tsx), so it can't answer "is there an unread brief" from
// outside that page. This is a small, honest, additive localStorage set —
// not a claim about inbox's internal state.

const BRIEF_READ_KEY = "patchwork.today.briefsRead";

function readBriefReadSet(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(BRIEF_READ_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function writeBriefReadSet(s: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    // Cap stored history so this never grows unbounded.
    window.localStorage.setItem(BRIEF_READ_KEY, JSON.stringify([...s].slice(-200)));
  } catch {
    /* private mode */
  }
}

function isBriefItem(name: string): boolean {
  return name.toLowerCase().includes("morning-brief");
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** "6pm yesterday, local" — the documented `halts` CLI window convention
 *  (CLAUDE.md: default window is `overnight`, since 6pm yesterday local). */
function msSinceSixPmYesterday(now: Date = new Date()): number {
  const cutoff = new Date(now);
  cutoff.setHours(18, 0, 0, 0);
  if (cutoff.getTime() > now.getTime()) {
    cutoff.setDate(cutoff.getDate() - 1);
  } else {
    // now IS past 6pm today — yesterday's 6pm is the one 24h before that
    cutoff.setDate(cutoff.getDate() - 1);
  }
  return Math.max(0, now.getTime() - cutoff.getTime());
}

// ---------------------------------------------------------------- hero

function Hero({
  overnightRuns,
  overnightHalts,
  haltsErr,
  decisionCount,
  hasBrief,
  allDone,
  nextBriefPhrase,
}: {
  overnightRuns: number | null;
  overnightHalts: number | null;
  haltsErr: boolean;
  decisionCount: number;
  hasBrief: boolean;
  allDone: boolean;
  nextBriefPhrase: string | null;
}) {
  const weekday = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const eyebrow = haltsErr
    ? `${weekday} · overnight status unavailable`
    : overnightRuns === null
      ? weekday
      : `${weekday} · overnight: ${overnightRuns} run${overnightRuns === 1 ? "" : "s"}, ${overnightHalts ?? 0} halt${(overnightHalts ?? 0) === 1 ? "" : "s"}`;

  const parts: string[] = [];
  if (decisionCount > 0) parts.push(`${decisionCount} decision${decisionCount === 1 ? "" : "s"}`);
  if (hasBrief) parts.push("one brief");
  const headline =
    parts.length === 0
      ? "Morning. Nothing waiting — you're clear."
      : `Morning. ${parts.join(", ")}, and you're clear.`;

  return (
    <header className="ty-hero">
      <div>
        <div className="ty-eyebrow">{eyebrow}</div>
        <h1 className="ty-headline">
          {allDone ? (nextBriefPhrase ?? "You're clear — check back tomorrow.") : headline}
        </h1>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- progress strip

function ProgressStrip({
  done,
  total,
  allDone,
  nextBriefPhrase,
}: {
  done: number;
  total: number;
  allDone: boolean;
  nextBriefPhrase: string | null;
}) {
  return (
    <div className="ty-progress" role="status" aria-live="polite" aria-atomic="true">
      {allDone ? (
        <span className="ty-progress-clear">
          <span aria-hidden="true">✓</span> You&apos;re clear
          {nextBriefPhrase ? ` — next brief ${nextBriefPhrase}` : " — check back tomorrow."}
        </span>
      ) : (
        <span className="ty-progress-count">{done} of {total} done</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- §1 the brief

function BriefSection({
  onDoneChange,
}: {
  onDoneChange: (done: boolean) => void;
}) {
  const { data, error, loading } = useBridgeFetch<{ items: InboxItem[] }>(
    "/api/inbox",
    { intervalMs: 30_000 },
  );
  const toast = useToast();

  const [detail, setDetail] = useState<InboxDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [readSet, setReadSet] = useState<Set<string>>(() => new Set());
  useEffect(() => setReadSet(readBriefReadSet()), []);

  const items = useMemo(() => data?.items ?? [], [data]);
  const briefItems = useMemo(
    () =>
      items
        .filter((i) => isBriefItem(i.name))
        .slice()
        .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)),
    [items],
  );
  const newestBrief = briefItems[0];
  const newestUnread = briefItems.find((i) => !readSet.has(i.name));

  const target = newestUnread ?? null;

  useEffect(() => {
    if (!target) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetailLoading(true);
    setDetailErr(null);
    fetch(apiPath(`/api/inbox/${encodeURIComponent(target.name)}`))
      .then((r) => {
        if (!r.ok) throw new Error(`/api/inbox/${target.name} ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (alive) setDetail(d as InboxDetail);
      })
      .catch((e: unknown) => {
        if (alive) setDetailErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [target]);

  // Report "done" (no unread brief left) whenever the loaded-state settles.
  useEffect(() => {
    if (loading) return;
    onDoneChange(!newestUnread);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, newestUnread?.name]);

  function markRead(name: string) {
    setReadSet((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev).add(name);
      writeBriefReadSet(next);
      return next;
    });
  }

  if (error) {
    return (
      <section aria-labelledby="ty-brief-h">
        <h2 id="ty-brief-h" className="ty-section-h">Read the brief</h2>
        <ErrorState
          title="Couldn't load the inbox"
          description="The bridge isn't answering /api/inbox."
          error={error}
        />
      </section>
    );
  }

  if (loading && items.length === 0) {
    return (
      <section aria-labelledby="ty-brief-h">
        <h2 id="ty-brief-h" className="ty-section-h">Read the brief</h2>
        <SkeletonList rows={1} columns={1} />
      </section>
    );
  }

  if (!newestUnread) {
    return (
      <section aria-labelledby="ty-brief-h" className="ty-card ty-brief-collapsed">
        <h2 id="ty-brief-h" className="ty-section-h">Read the brief</h2>
        {newestBrief ? (
          <p className="ty-collapsed-line">
            No new brief — last one {relTime(Date.parse(newestBrief.modifiedAt))}{" "}
            <Link href={`/inbox?item=${encodeURIComponent(newestBrief.name)}`}>→</Link>
          </p>
        ) : (
          <EmptyState
            title="No briefs yet"
            description="Morning-brief-style recipes will show up here once one runs."
          />
        )}
      </section>
    );
  }

  return (
    <section aria-labelledby="ty-brief-h" className="ty-card">
      <h2 id="ty-brief-h" className="ty-section-h">Read the brief</h2>
      {detailErr && (
        <ErrorState title="Couldn't load this brief" error={detailErr} />
      )}
      {detailLoading && !detail && <SkeletonList rows={1} columns={1} />}
      {detail && (
        <>
          <div className="ty-brief-body">
            <MessageMarkdown content={detail.content} components={{}} />
          </div>
          <div className="ty-brief-toolbar">
            <Link href={`/inbox?item=${encodeURIComponent(newestUnread.name)}`} className="ty-link">
              Open full note →
            </Link>
            <button
              type="button"
              className="btn sm primary"
              onClick={() => {
                markRead(newestUnread.name);
                toast.success("Marked read");
              }}
            >
              Mark read ✓
            </button>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- §2 decisions

function invocationHeading(toolName: string): string {
  return `${toolName}()`;
}

function DecisionsSection({
  onDoneChange,
  onCountChange,
}: {
  onDoneChange: (done: boolean) => void;
  onCountChange: (n: number) => void;
}) {
  const {
    data: approvalsData,
    error: approvalsErr,
    loading: approvalsLoading,
    refetch: refetchApprovals,
  } = useBridgeFetch<Pending[]>("/api/bridge/approvals", { intervalMs: 10_000 });
  const {
    data: pendingOutcomesData,
    status: outcomesStatus,
    error: outcomesErr,
    loading: outcomesLoading,
    refetch: refetchOutcomes,
  } = useBridgeFetch<PendingOutcomesResponse>("/api/bridge/outcomes/pending", {
    intervalMs: 10_000,
  });
  const toast = useToast();

  const approvals = approvalsData ?? [];
  const workerPending = pendingOutcomesData?.pending ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  const sortedApprovals = approvals
    .slice()
    .sort((a, b) => {
      const rankDiff =
        reversibilityRank(classifyPendingAction(a.toolName)?.reversibility) -
        reversibilityRank(classifyPendingAction(b.toolName)?.reversibility);
      if (rankDiff !== 0) return rankDiff;
      return (a.requestedAt ?? 0) - (b.requestedAt ?? 0);
    });
  const reversibleApprovals = sortedApprovals.filter(
    (p) => (classifyPendingAction(p.toolName)?.reversibility ?? "reversible") === "reversible",
  );
  const nonReversibleApprovals = sortedApprovals.filter(
    (p) => (classifyPendingAction(p.toolName)?.reversibility ?? "reversible") !== "reversible",
  );

  const totalDecisions = approvals.length + workerPending.length;

  useEffect(() => {
    if (approvalsLoading || outcomesLoading) return;
    onDoneChange(totalDecisions === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalsLoading, outcomesLoading, totalDecisions]);

  useEffect(() => {
    onCountChange(totalDecisions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalDecisions]);

  async function decide(callId: string, decision: "approve" | "reject") {
    setBusy(callId);
    try {
      const res = await fetch(`${API}/${decision}/${callId}`, { method: "POST" });
      if (!res.ok && res.status !== 409) throw new Error(`${decision} failed (${res.status})`);
      toast.success(decision === "approve" ? "Approved" : "Denied");
      refetchApprovals();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function approveAllReversible() {
    setBatchBusy(true);
    try {
      const ids = reversibleApprovals.map((p) => p.callId);
      await Promise.all(
        ids.map((id) => fetch(`${API}/approve/${id}`, { method: "POST" })),
      );
      toast.success(`Approved ${ids.length} reversible write${ids.length === 1 ? "" : "s"}`);
      refetchApprovals();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBatchBusy(false);
    }
  }

  async function actOutcome(p: PendingConfirmation, disposition: "confirmed" | "junk") {
    setBusy(p.issueUrl);
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
      refetchOutcomes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const anyErr = approvalsErr && outcomesErr;

  if (anyErr) {
    return (
      <section aria-labelledby="ty-decisions-h">
        <h2 id="ty-decisions-h" className="ty-section-h">Clear the decisions</h2>
        <ErrorState
          title="Couldn't load decisions"
          description="The bridge isn't answering /approvals or /outcomes/pending."
          error={approvalsErr}
        />
      </section>
    );
  }

  if ((approvalsLoading && !approvalsData) && (outcomesLoading && !pendingOutcomesData)) {
    return (
      <section aria-labelledby="ty-decisions-h">
        <h2 id="ty-decisions-h" className="ty-section-h">Clear the decisions</h2>
        <SkeletonList rows={2} columns={1} />
      </section>
    );
  }

  if (totalDecisions === 0) {
    return (
      <section aria-labelledby="ty-decisions-h" className="ty-card">
        <h2 id="ty-decisions-h" className="ty-section-h">Clear the decisions</h2>
        <EmptyState title="Nothing needs a decision." />
      </section>
    );
  }

  return (
    <section aria-labelledby="ty-decisions-h" className="ty-card">
      <h2 id="ty-decisions-h" className="ty-section-h">
        Clear the decisions <span className="ty-count">{totalDecisions}</span>
      </h2>

      {approvalsErr && (
        <div className="alert-err" role="alert">Approvals unreachable: {approvalsErr}</div>
      )}
      {outcomesErr && outcomesStatus !== 200 && (
        <div className="alert-err" role="alert">Worker review queue unreachable: {outcomesErr}</div>
      )}

      {reversibleApprovals.length > 0 && (
        <div className="ty-decision-row ty-batch-row">
          <span>
            {reversibleApprovals.length} reversible write{reversibleApprovals.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="btn sm primary"
            disabled={batchBusy}
            onClick={approveAllReversible}
          >
            {batchBusy ? "Approving…" : "Approve all"}
          </button>
        </div>
      )}

      {nonReversibleApprovals.map((p) => {
        const cls: ClientActionClass | null = classifyPendingAction(p.toolName);
        const irreversible = cls?.reversibility === "irreversible";
        return (
          <div className="ty-decision-row" key={p.callId}>
            <BlastBadge cls={cls} />
            <span className="ty-decision-label">{invocationHeading(p.toolName)}</span>
            {irreversible ? (
              <Link href="/approvals" className="ty-link">
                Open evidence →
              </Link>
            ) : (
              <span className="ty-decision-actions">
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={busy === p.callId}
                  onClick={() => decide(p.callId, "approve")}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={busy === p.callId}
                  onClick={() => decide(p.callId, "reject")}
                >
                  Deny
                </button>
              </span>
            )}
          </div>
        );
      })}

      {workerPending.map((p) => (
        <div className="ty-decision-row" key={p.issueUrl}>
          <span className="pill muted">worker verdict</span>
          <span className="ty-decision-label">
            {p.workerName} filed: {p.title ?? "a new issue"}
          </span>
          <span className="ty-decision-actions">
            <button
              type="button"
              className="btn sm primary"
              disabled={busy === p.issueUrl}
              onClick={() => actOutcome(p, "confirmed")}
            >
              Looks real
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy === p.issueUrl}
              onClick={() => actOutcome(p, "junk")}
            >
              Not real
            </button>
          </span>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------- §3 team

function TeamSection({
  teamDone,
  onMarkDone,
}: {
  teamDone: boolean;
  onMarkDone: () => void;
}) {
  const { data, error, loading } = useBridgeFetch<ShadowResponse>(
    "/api/bridge/workers/shadow",
    { intervalMs: 30_000 },
  );
  const workers = data?.workers ?? [];

  const promotable = workers.filter(readyToAdvance);
  const demoted = workers
    .map((w) => ({ w, event: lastDemotion(w) }))
    .filter((x): x is { w: WorkerReport; event: NonNullable<ReturnType<typeof lastDemotion>> } =>
      Boolean(x.event) && Date.now() - (x.event?.at ?? 0) < 7 * 86_400_000,
    );
  const highlighted = new Set([...promotable.map((w) => w.workerId), ...demoted.map((x) => x.w.workerId)]);
  const quietCount = workers.length - highlighted.size;

  if (error) {
    return (
      <section aria-labelledby="ty-team-h">
        <h2 id="ty-team-h" className="ty-section-h">Glance at the team</h2>
        <ErrorState
          title="Couldn't load the team"
          description="The bridge isn't answering /workers/shadow."
          error={error}
        />
      </section>
    );
  }

  if (loading && workers.length === 0) {
    return (
      <section aria-labelledby="ty-team-h">
        <h2 id="ty-team-h" className="ty-section-h">Glance at the team</h2>
        <SkeletonList rows={2} columns={1} />
      </section>
    );
  }

  if (workers.length === 0) {
    return (
      <section aria-labelledby="ty-team-h" className="ty-card">
        <h2 id="ty-team-h" className="ty-section-h">Glance at the team</h2>
        <EmptyState
          title="No workers set up yet"
          description="Add a worker to see its trust journey here."
        />
      </section>
    );
  }

  return (
    <section aria-labelledby="ty-team-h" className="ty-card">
      <h2 id="ty-team-h" className="ty-section-h">Glance at the team</h2>

      {promotable.slice(0, 4).map((w) => {
        const top = topPromotable(w);
        return (
          <div className="ty-team-row" key={`promo-${w.workerId}`}>
            <span className="ty-dot ty-dot-ok" aria-hidden="true" />
            <span className="ty-team-label">
              {w.name} earned more than its current limit
              {top ? ` on ${taskName(top.classKey)}` : ""}.
            </span>
            <Link href="/workers" className="ty-link">Raise limit →</Link>
          </div>
        );
      })}

      {demoted.slice(0, 4).map(({ w, event }) => (
        <div className="ty-team-row" key={`demote-${w.workerId}`}>
          <span className="ty-dot ty-dot-warn" aria-hidden="true" />
          <span className="ty-team-label">
            {w.name} slipped back on {taskName(event.classKey)} ({relTime(event.at)}).
          </span>
          <Link href="/workers" className="ty-link">Review →</Link>
        </div>
      ))}

      {quietCount > 0 && (
        <div className="ty-team-quiet">
          {quietCount} other{quietCount === 1 ? "" : "s"} quiet and healthy ·{" "}
          <Link href="/workers" className="ty-link">full roster →</Link>
        </div>
      )}

      <div className="ty-team-manual">
        <button
          type="button"
          className="btn sm ghost"
          disabled={teamDone}
          onClick={onMarkDone}
        >
          {teamDone ? "✓ Done" : "Mark done ✓"}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- overnight hero data

function useOvernightSummary(): {
  runs: number | null;
  halts: number | null;
  err: boolean;
} {
  const sinceMs = useMemo(() => msSinceSixPmYesterday(), []);
  const [runs, setRuns] = useState<number | null>(null);
  const [halts, setHalts] = useState<number | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch(apiPath(`/api/bridge/runs/halt-summary?sinceMs=${sinceMs}`)).then((r) =>
        r.ok ? (r.json() as Promise<HaltSummary>) : Promise.reject(new Error(String(r.status))),
      ),
      fetch(apiPath("/api/bridge/runs")).then((r) =>
        r.ok
          ? (r.json() as Promise<{ runs?: Array<{ startedAt: number }> }>)
          : Promise.reject(new Error(String(r.status))),
      ),
    ])
      .then(([haltData, runsData]) => {
        if (!alive) return;
        setHalts(haltData.total ?? 0);
        const cutoff = Date.now() - sinceMs;
        const runList = runsData.runs ?? [];
        setRuns(runList.filter((r) => r.startedAt >= cutoff).length);
        setErr(false);
      })
      .catch(() => {
        if (alive) setErr(true);
      });
    return () => {
      alive = false;
    };
  }, [sinceMs]);

  return { runs, halts, err };
}

/** Next brief fire time, if resolvable — fetches the `morning-brief` recipe
 *  (the stable name used across templates/examples) and derives its next
 *  fire time the same way the recipe-detail page does. Fails soft to null
 *  (no recipe installed by that name, or an unschedulable trigger) rather
 *  than fabricating a time. */
function useNextBriefPhrase(): string | null {
  const [phrase, setPhrase] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(apiPath("/api/bridge/recipes/morning-brief"))
      .then((r) => (r.ok ? (r.json() as Promise<RecipeDetail>) : null))
      .then((recipe) => {
        if (!alive || !recipe) return;
        const hs = humanizeSchedule(recipe.schedule);
        const next = describeNextRun(hs.nextRunAt);
        if (next) setPhrase(next);
      })
      .catch(() => {
        /* no such recipe / bridge down — omit the specific time */
      });
    return () => {
      alive = false;
    };
  }, []);
  return phrase;
}

// ---------------------------------------------------------------- page

export default function TodayPage() {
  const { done, markDone } = useTodayProgress();
  const { runs: overnightRuns, halts: overnightHalts, err: haltsErr } = useOvernightSummary();
  const nextBriefPhrase = useNextBriefPhrase();

  const [decisionCount, setDecisionCount] = useState(0);
  const [hasUnreadBrief, setHasUnreadBrief] = useState(false);

  const handleBriefDone = useCallback(
    (isDone: boolean) => {
      setHasUnreadBrief(!isDone);
      markDone("brief", isDone);
    },
    [markDone],
  );
  const handleDecisionsDone = useCallback(
    (isDone: boolean) => {
      markDone("decisions", isDone);
    },
    [markDone],
  );

  const doneCount = [done.brief, done.decisions, done.team].filter(Boolean).length;
  const allDone = doneCount === 3;
  const [showAnyway, setShowAnyway] = useState(false);

  return (
    <section className="ty-wrap">
      <Hero
        overnightRuns={overnightRuns}
        overnightHalts={overnightHalts}
        haltsErr={haltsErr}
        decisionCount={decisionCount}
        hasBrief={hasUnreadBrief}
        allDone={allDone}
        nextBriefPhrase={nextBriefPhrase}
      />

      <ProgressStrip done={doneCount} total={3} allDone={allDone} nextBriefPhrase={nextBriefPhrase} />

      {allDone && !showAnyway && (
        <button
          type="button"
          className="btn sm ghost ty-show-anyway"
          onClick={() => setShowAnyway(true)}
        >
          Show sections anyway
        </button>
      )}

      {/* Sections stay mounted once loaded (rather than unmount/remount on
          allDone) so their independent fetches don't re-fire every time the
          progress strip flips — they're just visually collapsed. */}
      <div hidden={allDone && !showAnyway}>
        <BriefSection onDoneChange={handleBriefDone} />
        <DecisionsSection onDoneChange={handleDecisionsDone} onCountChange={setDecisionCount} />
        <TeamSection teamDone={done.team} onMarkDone={() => markDone("team", true)} />
      </div>
    </section>
  );
}
