"use client";
import Link from "next/link";
import { useState } from "react";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

type ReplayDecision = "allow" | "deny" | "ask" | "none";
type ChangeKind = "now_allowed" | "now_denied" | "now_asked";

interface ReplayRow {
  timestamp: string;
  toolName: string;
  specifier?: string;
  originalDecision: string;
  replayDecision: ReplayDecision;
  unchanged: boolean;
  changeKind?: ChangeKind;
  incomplete?: boolean;
}

interface ReplayResult {
  rows: ReplayRow[];
  generatedAt: string;
  totalRows: number;
  changedCount: number;
  nowAllowedCount: number;
  nowDeniedCount: number;
  workspace: string;
}

const DECISION_PILL: Record<string, string> = {
  allow: "ok",
  deny: "err",
  ask: "warn",
  none: "muted",
};

const CHANGE_LABEL: Record<ChangeKind, string> = {
  now_allowed: "Now allowed",
  now_denied: "Now denied",
  now_asked: "Now requires approval",
};

const CHANGE_PILL: Record<ChangeKind, string> = {
  now_allowed: "ok",
  now_denied: "err",
  now_asked: "warn",
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function ReplayPage() {
  const [sinceDays, setSinceDays] = useState(7);
  const [showUnchanged, setShowUnchanged] = useState(false);

  const { data, error, loading } = useBridgeFetch<ReplayResult>(
    `/api/bridge/approval-insights/replay?sinceDays=${sinceDays}`,
    { intervalMs: 60000 },
  );

  const rows = data?.rows ?? [];
  const visible = showUnchanged ? rows : rows.filter((r) => !r.unchanged);

  return (
    <section>
      <div className="page-head">
        <div>
          <Link
            href="/insights"
            style={{ fontSize: 12, color: "var(--fg-2)", textDecoration: "none" }}
          >
            ← Approval Insights
          </Link>
          <h1 style={{ marginTop: 4 }}>Decision Replay</h1>
          <div className="page-head-sub">
            What would have happened if your current policy had been active in
            the past? Each row re-evaluates a historical approval against today's
            rules. Read-only — no tools are re-executed.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label htmlFor="since-days" style={{ fontSize: 12, color: "var(--fg-2)" }}>
            Lookback
          </label>
          <select
            id="since-days"
            value={sinceDays}
            onChange={(e) => setSinceDays(Number.parseInt(e.target.value, 10))}
            style={{
              background: "var(--bg-2)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--r-2)",
              color: "var(--fg-0)",
              fontSize: 12,
              padding: "4px 8px",
              outline: "none",
            }}
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          {data && (
            <>
              <span className="pill muted">{data.totalRows} decisions</span>
              {data.changedCount > 0 && (
                <span className="pill warn">{data.changedCount} changed</span>
              )}
              {data.nowAllowedCount > 0 && (
                <span className="pill ok">+{data.nowAllowedCount} now allowed</span>
              )}
              {data.nowDeniedCount > 0 && (
                <span className="pill err">−{data.nowDeniedCount} now denied</span>
              )}
            </>
          )}
        </div>
      </div>

      {loading && rows.length === 0 && (
        <p style={{ color: "var(--fg-2)" }}>Loading…</p>
      )}
      {error && <div className="alert-err">Unreachable: {error}</div>}

      {!loading && !error && data && data.totalRows === 0 && (
        <div className="empty-state">
          <h3>No approval history in this window</h3>
          <p>
            Widen the lookback or come back after the bridge has processed some
            approval decisions. Every allow/deny/ask is recorded automatically.
          </p>
        </div>
      )}

      {data && data.totalRows > 0 && (
        <>
          {data.changedCount === 0 && (
            <div
              style={{
                padding: "12px 16px",
                borderRadius: "var(--r-2)",
                background: "color-mix(in srgb, var(--ok) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--ok) 25%, transparent)",
                fontSize: 13,
                marginBottom: "var(--s-4)",
              }}
            >
              ✓ Your current policy matches all {data.totalRows} historical
              decisions — no divergence detected.
            </div>
          )}

          <div className="card" style={{ marginTop: "var(--s-3)" }}>
            <div className="card-head">
              <h2>
                {showUnchanged
                  ? `All decisions (${rows.length})`
                  : `Changed decisions (${visible.length})`}
              </h2>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--fg-2)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={showUnchanged}
                  onChange={(e) => setShowUnchanged(e.target.checked)}
                />
                Show unchanged
              </label>
            </div>

            {visible.length === 0 && !showUnchanged && (
              <p style={{ fontSize: 13, color: "var(--fg-2)", margin: "12px 0" }}>
                No changed decisions in this window. Toggle "Show unchanged" to
                see all rows.
              </p>
            )}

            {visible.length > 0 && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                    <th style={{ textAlign: "left", padding: "6px 0", fontWeight: 500, color: "var(--fg-2)", fontSize: 11 }}>Tool</th>
                    <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 500, color: "var(--fg-2)", fontSize: 11 }}>Was</th>
                    <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 500, color: "var(--fg-2)", fontSize: 11 }}>Would be</th>
                    <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 500, color: "var(--fg-2)", fontSize: 11 }}>Change</th>
                    <th style={{ textAlign: "right", padding: "6px 0", fontWeight: 500, color: "var(--fg-2)", fontSize: 11 }}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row, idx) => (
                    <tr
                      key={`${row.timestamp}-${row.toolName}-${idx}`}
                      style={{
                        borderBottom: "1px solid var(--border-subtle)",
                        background: !row.unchanged
                          ? "color-mix(in srgb, var(--warn) 5%, transparent)"
                          : undefined,
                      }}
                    >
                      <td style={{ padding: "9px 0", verticalAlign: "middle" }}>
                        <div>
                          <code style={{ fontSize: 12 }}>{row.toolName}</code>
                          {row.specifier && (
                            <div
                              style={{
                                fontSize: 10,
                                color: "var(--fg-3)",
                                marginTop: 2,
                                maxWidth: 260,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={row.specifier}
                            >
                              {row.specifier}
                            </div>
                          )}
                          {row.incomplete && (
                            <span
                              className="pill muted"
                              style={{ fontSize: 9, marginTop: 2 }}
                              title="Row predates specifier capture — matched on tool name only"
                            >
                              name-only
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: "9px 8px", verticalAlign: "middle" }}>
                        <span
                          className={`pill ${DECISION_PILL[row.originalDecision] ?? "muted"}`}
                          style={{ fontSize: 10 }}
                        >
                          {row.originalDecision}
                        </span>
                      </td>
                      <td style={{ padding: "9px 8px", verticalAlign: "middle" }}>
                        <span
                          className={`pill ${DECISION_PILL[row.replayDecision] ?? "muted"}`}
                          style={{ fontSize: 10 }}
                        >
                          {row.replayDecision}
                        </span>
                      </td>
                      <td style={{ padding: "9px 8px", verticalAlign: "middle" }}>
                        {row.changeKind ? (
                          <span
                            className={`pill ${CHANGE_PILL[row.changeKind]}`}
                            style={{ fontSize: 10 }}
                          >
                            {CHANGE_LABEL[row.changeKind]}
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, color: "var(--fg-3)" }}>—</span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "9px 0",
                          textAlign: "right",
                          color: "var(--fg-3)",
                          verticalAlign: "middle",
                          whiteSpace: "nowrap",
                          fontSize: 11,
                        }}
                      >
                        {relativeTime(row.timestamp)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {data.workspace && (
            <p style={{ fontSize: 11, color: "var(--fg-2)", marginTop: "var(--s-5)" }}>
              Rules loaded from workspace:{" "}
              <code style={{ fontSize: 10 }}>{data.workspace}</code>.
              Generated at {new Date(data.generatedAt).toLocaleTimeString()}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
