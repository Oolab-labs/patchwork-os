"use client";
import Link from "next/link";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

interface ToolInsight {
  toolName: string;
  approvals: number;
  rejections: number;
  approvalRate: number | null;
  lastDecisionAt: string | null;
  firstDecisionAt: string | null;
  heuristicLabel: string;
  severity: "low" | "medium" | "high";
}

interface InsightsResponse {
  tools: ToolInsight[];
  generatedAt: string;
  totalDecisions: number;
  rejectedToolCount: number;
  trustedToolCount: number;
}

const SEVERITY_PILL: Record<ToolInsight["severity"], string> = {
  low: "ok",
  medium: "warn",
  high: "err",
};

const SEVERITY_LABEL: Record<ToolInsight["severity"], string> = {
  low: "trusted",
  medium: "new",
  high: "rejected",
};

function approvalBar(approvals: number, rejections: number) {
  const total = approvals + rejections;
  if (total === 0) return null;
  const pct = Math.round((approvals / total) * 100);
  return (
    <div
      style={{
        display: "flex",
        height: 6,
        width: 80,
        borderRadius: 3,
        overflow: "hidden",
        background: "var(--bg-3)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          background: pct >= 80 ? "var(--ok, #22c55e)" : pct >= 50 ? "var(--warn, #f59e0b)" : "var(--err, #ef4444)",
          transition: "width 0.2s",
        }}
      />
    </div>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function InsightsPage() {
  const { data, error, loading } = useBridgeFetch<InsightsResponse>(
    "/api/bridge/approval-insights",
    { intervalMs: 30000 },
  );

  const tools = data?.tools ?? [];

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Approval Insights</h1>
          <div className="page-head-sub">
            Your personal approval history — how the bridge interprets your
            past decisions. Same signals surfaced per-call in the approval
            modal, now shown in aggregate. Read-only.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {data && (
            <>
              <span className="pill muted">{data.totalDecisions} decisions</span>
              <span className="pill ok">{data.trustedToolCount} trusted</span>
              {data.rejectedToolCount > 0 && (
                <span className="pill err">{data.rejectedToolCount} rejected</span>
              )}
            </>
          )}
          <Link href="/insights/replay" className="btn sm">
            Replay →
          </Link>
        </div>
      </div>

      {loading && tools.length === 0 && (
        <p style={{ color: "var(--fg-2)" }}>Loading…</p>
      )}
      {error && <div className="alert-err">Unreachable: {error}</div>}

      {!loading && !error && tools.length === 0 && (
        <div className="empty-state">
          <h3>No approval history yet</h3>
          <p>
            Once you start approving or rejecting tool calls in the approval
            queue, this page will show you your patterns — "you approved this
            27 times", "you rejected this tool before", and so on.
          </p>
        </div>
      )}

      {tools.length > 0 && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Tool history</h2>
            <span className="pill muted">{tools.length}</span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                <th style={{ textAlign: "left", padding: "8px 0", fontWeight: 500, color: "var(--fg-2)", fontSize: 11 }}>Tool</th>
                <th style={{ textAlign: "left", padding: "8px 8px", fontWeight: 500, color: "var(--fg-2)", fontSize: 11 }}>Heuristic</th>
                <th style={{ textAlign: "right", padding: "8px 8px", fontWeight: 500, color: "var(--fg-2)", fontSize: 11 }}>✓</th>
                <th style={{ textAlign: "right", padding: "8px 8px", fontWeight: 500, color: "var(--fg-2)", fontSize: 11 }}>✗</th>
                <th style={{ textAlign: "center", padding: "8px 8px", fontWeight: 500, color: "var(--fg-2)", fontSize: 11 }}>Rate</th>
                <th style={{ textAlign: "right", padding: "8px 0", fontWeight: 500, color: "var(--fg-2)", fontSize: 11 }}>Last</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr
                  key={t.toolName}
                  style={{ borderBottom: "1px solid var(--border-subtle)" }}
                >
                  <td style={{ padding: "10px 0", verticalAlign: "middle" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        className={`pill ${SEVERITY_PILL[t.severity]}`}
                        style={{ fontSize: 10 }}
                      >
                        {SEVERITY_LABEL[t.severity]}
                      </span>
                      <code style={{ fontSize: 12 }}>{t.toolName}</code>
                    </div>
                  </td>
                  <td
                    style={{
                      padding: "10px 8px",
                      color: "var(--fg-2)",
                      verticalAlign: "middle",
                      maxWidth: 340,
                    }}
                  >
                    {t.heuristicLabel}
                  </td>
                  <td
                    style={{
                      padding: "10px 8px",
                      textAlign: "right",
                      color: "var(--ok, #22c55e)",
                      verticalAlign: "middle",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {t.approvals}
                  </td>
                  <td
                    style={{
                      padding: "10px 8px",
                      textAlign: "right",
                      color: t.rejections > 0 ? "var(--err, #ef4444)" : "var(--fg-3)",
                      verticalAlign: "middle",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {t.rejections}
                  </td>
                  <td
                    style={{
                      padding: "10px 8px",
                      verticalAlign: "middle",
                      textAlign: "center",
                    }}
                  >
                    {approvalBar(t.approvals, t.rejections)}
                  </td>
                  <td
                    style={{
                      padding: "10px 0",
                      textAlign: "right",
                      color: "var(--fg-3)",
                      verticalAlign: "middle",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {relativeTime(t.lastDecisionAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data?.generatedAt && (
        <p style={{ fontSize: 11, color: "var(--fg-2)", marginTop: "var(--s-5)" }}>
          Generated at {new Date(data.generatedAt).toLocaleTimeString()}.
          Signals computed from your local activity log — nothing leaves your
          machine.
        </p>
      )}
    </section>
  );
}
