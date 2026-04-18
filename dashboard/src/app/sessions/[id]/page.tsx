"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

interface SessionSummary {
  id: string;
  connectedAt: string;
  openedFileCount: number;
  pendingApprovals: number;
}

interface LifecycleEntry {
  id: number;
  timestamp: string;
  event: string;
  metadata?: Record<string, unknown>;
}

interface PendingApproval {
  callId: string;
  toolName: string;
  tier: "low" | "medium" | "high";
  requestedAt: number;
  summary?: string;
}

interface DetailResponse {
  summary: SessionSummary | null;
  lifecycle: LifecycleEntry[];
  approvals: PendingApproval[];
}

const NOISE_EVENTS = new Set([
  "claude_connected",
  "claude_disconnected",
  "extension_connected",
  "extension_disconnected",
  "grace_started",
  "grace_expired",
]);

export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data, error, loading, status } = useBridgeFetch<DetailResponse>(
    `/api/bridge/sessions/${id}`,
    { intervalMs: 3000 },
  );

  const summary = data?.summary ?? null;
  const approvals = data?.approvals ?? [];
  const lifecycle = (data?.lifecycle ?? []).slice().reverse(); // newest first

  return (
    <section>
      <div className="page-head">
        <div>
          <div style={{ fontSize: 12, marginBottom: 4 }}>
            <Link href="/sessions" style={{ color: "var(--fg-2)" }}>
              ← Sessions
            </Link>
          </div>
          <h1>
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 20 }}>
              {id.slice(0, 8)}
            </code>
          </h1>
          <div
            className="page-head-sub"
            title={id}
            style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
          >
            {id}
          </div>
        </div>
        {summary && (
          <div style={{ display: "flex", gap: 6 }}>
            <span className="pill muted">
              {summary.openedFileCount} open
            </span>
            {summary.pendingApprovals > 0 && (
              <Link
                href={`/approvals?session=${id}`}
                className="pill err"
                title="Pending approvals"
              >
                {summary.pendingApprovals} pending
              </Link>
            )}
          </div>
        )}
      </div>

      {error && !data && <div className="alert-err">Unreachable: {error}</div>}
      {!loading && !data && status === 404 && (
        <div className="empty-state">
          <h3>Session not found</h3>
          <p>
            No active session with this id. It may have disconnected, or the
            id is wrong.
          </p>
        </div>
      )}

      {summary && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Summary</h2>
            <span
              className="pill muted"
              title={new Date(summary.connectedAt).toLocaleString()}
            >
              connected {relTime(new Date(summary.connectedAt).getTime())}
            </span>
          </div>
        </div>
      )}

      {approvals.length > 0 && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Pending approvals</h2>
            <span className="pill warn">{approvals.length}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {approvals.map((a) => (
              <Link
                key={a.callId}
                href={`/approvals/${a.callId}`}
                style={{
                  display: "flex",
                  gap: "var(--s-3)",
                  alignItems: "center",
                  padding: "8px 10px",
                  background: "var(--bg-0)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--r-2)",
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <span
                  className={`pill ${a.tier === "high" ? "err" : a.tier === "medium" ? "warn" : "ok"}`}
                >
                  {a.tier}
                </span>
                <span className="mono" style={{ fontSize: 13 }}>
                  {a.toolName}
                </span>
                <span
                  style={{
                    flex: 1,
                    color: "var(--fg-2)",
                    fontSize: 13,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {a.summary ?? "—"}
                </span>
                <span style={{ color: "var(--fg-3)", fontSize: 12 }}>
                  {relTime(a.requestedAt)}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {lifecycle.length > 0 && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Event stream</h2>
            <span className="pill muted">{lifecycle.length}</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>Time</th>
                  <th style={{ width: 160 }}>Event</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {lifecycle.map((e) => {
                  const isNoise = NOISE_EVENTS.has(e.event);
                  const isApproval = e.event === "approval_decision";
                  const meta = e.metadata ?? {};
                  const detail = isApproval
                    ? `${meta.decision ?? "?"} ${meta.toolName ?? ""}${meta.reason ? ` — ${meta.reason}` : ""}`
                    : typeof meta.summary === "string"
                      ? meta.summary
                      : "—";
                  return (
                    <tr key={e.id}>
                      <td className="muted" title={e.timestamp}>
                        {relTime(Date.parse(e.timestamp))}
                      </td>
                      <td>
                        <span
                          className={`pill ${
                            isApproval
                              ? meta.decision === "allow"
                                ? "ok"
                                : "err"
                              : isNoise
                                ? "muted"
                                : "ok"
                          }`}
                        >
                          {e.event}
                        </span>
                      </td>
                      <td style={{ fontSize: 13 }}>{detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {summary && lifecycle.length === 0 && approvals.length === 0 && (
        <div className="empty-state" style={{ marginTop: "var(--s-4)" }}>
          <h3>No recorded activity</h3>
          <p>
            This session has connected but hasn&apos;t produced any lifecycle
            events or approvals yet.
          </p>
        </div>
      )}
    </section>
  );
}
