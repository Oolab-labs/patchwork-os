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
interface WorkerReport {
  workerId: string;
  name: string;
  autonomyCeiling: number;
  board: BoardRow[];
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

const LEVEL_LABELS = [
  "L0 suggest",
  "L1 approve-each",
  "L2 act+undo",
  "L3 act+sample",
  "L4 autonomous",
];

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

/**
 * Considered-approval KPI — the honesty lens beside the dial. The dial says how
 * high trust climbed; this says whether the approvals behind it were considered.
 * A 0% reject rate over a real sample is the clearest tell of a rubber-stamp.
 */
function ConsideredApprovalPanel() {
  const { data } = useBridgeFetch<KpiResponse>("/api/bridge/approvals/kpi", {
    intervalMs: 30000,
  });
  // Render only with real KPI data: `!data.total` catches both the empty case
  // (total 0) and a non-KPI/error payload (total undefined), so the panel never
  // crashes on an unexpected shape.
  if (!data || !data.total) return null;
  const rubberStamp = data.decided >= 5 && data.rejectRate === 0;
  return (
    <div className="card" style={{ marginTop: "var(--s-4)" }}>
      <div className="card-head">
        <strong>
          Considered approvals — <span className="accent">is it earned?</span>
        </strong>
        <span className="pill muted">{data.decided} decided</span>
      </div>
      <div style={{ display: "flex", gap: "var(--s-4)", flexWrap: "wrap" }}>
        <span
          className="pill"
          style={{
            background: rubberStamp ? "var(--warn)" : "var(--surface-2)",
            color: rubberStamp ? "var(--bg)" : "inherit",
          }}
        >
          reject rate {Math.round(data.rejectRate * 100)}%
        </span>
        <span className="pill muted">latency {fmtLat(data.latency)}</span>
        {data.abandoned > 0 && (
          <span className="pill muted">{data.abandoned} abandoned</span>
        )}
        <span className="pill muted">{channelStr(data.channels)}</span>
      </div>
      {rubberStamp && (
        <div
          className="editorial-sub"
          style={{ fontFamily: "inherit", color: "var(--warn)" }}
        >
          ⚠ Every one of {data.decided} prompts approved with no rejections — the
          dial may be climbing on rubber-stamps, not earned trust.
        </div>
      )}
      {data.latency === null && (
        <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
          Latency captures from the next decision forward (it cannot be
          backfilled).
        </div>
      )}
      {data.byTool.map((t) => (
        <div className="suggestion-row" key={t.toolName}>
          {t.toolName} — decided {t.decided} · reject{" "}
          {Math.round(t.rejectRate * 100)}% · {fmtLat(t.latency)} ·{" "}
          {channelStr(t.channels)}
        </div>
      ))}
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

/**
 * Awaiting confirmation — the CONFIRM QUEUE. Worker issue filings with NO
 * operator disposition yet: their trust is WITHHELD until a human acts. This
 * is the queue the confirm loop exists to drain, and the age of this queue IS
 * the evidence-latency moat metric. One-click Confirm/Reject POSTs to the same
 * Bearer-gated /outcomes route (never a recipe step — no self-confirm) and the
 * queue refreshes. Sourced from GET /outcomes/pending (a read-only join over the
 * run log + dispositions). Suppressed when the queue is empty.
 */
function AwaitingConfirmationPanel() {
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
            Awaiting confirmation — <span className="accent">all clear.</span>
          </strong>
          <span
            className="pill"
            style={{ background: "var(--ok)", color: "var(--bg)" }}
          >
            0 pending
          </span>
        </div>
        <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
          Every worker filing has an operator disposition — the confirm queue is
          drained (evidence latency at zero).
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
          Awaiting confirmation — <span className="accent">needs your call.</span>
        </strong>
        <span
          className="pill"
          style={{ background: "var(--warn)", color: "var(--bg)" }}
        >
          {pending.length} pending
        </span>
      </div>
      <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
        Filings whose trust is withheld until you confirm or reject them — the
        age of this queue is the evidence latency the trust ramp exists to shrink.
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
          {/^https?:\/\//i.test(p.issueUrl) ? (
            <a
              href={p.issueUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                flex: 1,
                minWidth: "12rem",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {p.issueUrl}
            </a>
          ) : (
            <span style={{ flex: 1, minWidth: "12rem" }}>{p.issueUrl}</span>
          )}
          <span className="pill muted">
            {p.workerName} · {p.classKey}
          </span>
          <button
            type="button"
            className="btn sm primary"
            disabled={busy !== null}
            onClick={() => act(p, "confirmed")}
          >
            Confirm
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy !== null}
            onClick={() => act(p, "junk")}
          >
            Reject
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Filed outcomes — the operator's one-click confirm/reject queue. A worker's
 * `issue` dial only moves once a HUMAN confirms the filing was real (or rejects
 * it as junk) — a worker cannot self-confirm. This is the dashboard twin of
 * `patchwork outcomes confirm|reject`, POSTing to the Bearer-gated /outcomes
 * route through the generic bridge proxy. Converts approvals into *considered*
 * approvals and slashes evidence latency (the declared moat KPI).
 */
function FiledOutcomesPanel() {
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
          Filed outcomes — <span className="accent">confirm or reject.</span>
        </strong>
        <span className="pill muted">
          {outcomes.length} recorded
          {confirmedCount > 0 && ` · ${confirmedCount} confirmed`}
          {junkCount > 0 && ` · ${junkCount} junk`}
        </span>
      </div>
      <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
        A worker&apos;s <code>issue</code> dial only moves once a human confirms
        the filing was real — a worker can&apos;t self-confirm its own filings.
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
        const ctx = [o.recipeName, o.workerClass].filter(Boolean).join(" · ");
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
              {o.disposition}
            </span>
            {/* Render as a link only for http(s) — never emit a raw href for a
                non-web-scheme URL (defence-in-depth against a javascript: URL,
                which React does not sanitise, even though every write path
                already validates http(s)). */}
            {/^https?:\/\//i.test(o.issueUrl) ? (
              <a
                href={o.issueUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  flex: 1,
                  minWidth: "12rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {o.issueUrl}
              </a>
            ) : (
              <span style={{ flex: 1, minWidth: "12rem" }}>{o.issueUrl}</span>
            )}
            {ctx && <span className="pill muted">{ctx}</span>}
            <button
              type="button"
              className="btn sm primary"
              disabled={busy !== null || o.disposition === "confirmed"}
              onClick={() => setDisposition(o.issueUrl, "confirmed")}
            >
              Confirm
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy !== null || o.disposition === "junk"}
              onClick={() => setDisposition(o.issueUrl, "junk")}
            >
              Reject
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

export default function WorkersPage() {
  const { data, error, loading, refetch } = useBridgeFetch<ShadowResponse>(
    "/api/bridge/workers/shadow",
    { intervalMs: 30000 },
  );
  const workers = data?.workers ?? [];

  return (
    <section>
      <div className="page-head">
        <div>
          <h1 className="editorial-h1" style={{ margin: 0 }}>
            Workers — <span className="accent">trust dial (shadow).</span>
          </h1>
          <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
            Earned autonomy per worker × action-class, replayed read-only from
            the run + gate logs. No live decision is changed.
          </div>
        </div>
        {data && (
          <span className="pill muted">
            {data.runsScanned} runs · {data.decisionsScanned} gate decisions
          </span>
        )}
      </div>

      <ConsideredApprovalPanel />

      <AwaitingConfirmationPanel />

      <FiledOutcomesPanel />

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
          title="No workers yet"
          description="Add *.worker.yaml to ~/.patchwork/workers (e.g. copy templates/workers/)."
        />
      )}

      {workers.map((w) => {
        const effectiveItems = w.board.map((b) => {
          const effective = b.owned
            ? Math.min(b.level, w.autonomyCeiling)
            : 0;
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
            sub: `${LEVEL_LABELS[effective] ?? `L${effective}`} · ${b.observations} obs · ${Math.round(b.mean * 100)}% mean${capped}${notOwned}`,
          };
        });
        return (
          <div className="card" key={w.workerId} style={{ marginTop: "var(--s-4)" }}>
            <div className="card-head">
              <strong>{w.name}</strong>
              <span className="pill muted">ceiling L{w.autonomyCeiling}</span>
            </div>
            {w.board.length === 0 ? (
              <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
                No attributed activity yet — the dial fills as this worker runs.
              </div>
            ) : (
              <HBarList items={effectiveItems} max={4} />
            )}
            {w.compared > 0 && (
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
      })}
    </section>
  );
}
