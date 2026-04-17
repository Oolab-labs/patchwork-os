"use client";
import { useState } from "react";
import { StatCard } from "@/components/StatCard";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

interface ToolStat {
  tool: string;
  calls: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
}

interface AutomationTask {
  id: string;
  name?: string;
  status: string;
  startedAt: number;
  completedAt?: number;
}

interface AnalyticsData {
  topTools: ToolStat[];
  hooksLast24h: number;
  recentAutomationTasks: AutomationTask[];
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const WINDOWS: { label: string; value: number }[] = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
];

function taskStatusPill(status: string) {
  if (status === "done" || status === "completed") {
    return <span className="pill ok">{status}</span>;
  }
  if (status === "error" || status === "failed") {
    return <span className="pill err">{status}</span>;
  }
  return <span className="pill muted">{status}</span>;
}

export default function AnalyticsPage() {
  const [windowHours, setWindowHours] = useState(24);

  const { data, error, loading } = useBridgeFetch<AnalyticsData>(
    `/api/bridge/analytics?windowHours=${windowHours}`,
    { intervalMs: 30000 },
  );

  const topTools = (data?.topTools ?? []).slice(0, 15);
  const totalCalls = topTools.reduce((s, t) => s + t.calls, 0);
  const totalErrors = topTools.reduce((s, t) => s + t.errors, 0);
  const maxCalls = topTools.length > 0 ? topTools[0].calls : 1;
  const errorRate =
    totalCalls > 0 ? `${((totalErrors / totalCalls) * 100).toFixed(1)}%` : "—";

  const recentTasks = (data?.recentAutomationTasks ?? []).slice(0, 20);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <div className="page-head-sub">
            Tool usage, hook activity, and automation task history.
          </div>
        </div>
        <div style={{ display: "flex", gap: "var(--s-1)" }}>
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              type="button"
              className="btn sm"
              onClick={() => setWindowHours(w.value)}
              style={
                windowHours === w.value
                  ? {
                      borderColor: "var(--accent)",
                      color: "var(--accent)",
                      background: "var(--accent-soft)",
                    }
                  : undefined
              }
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <div className="alert-err">Bridge offline — {error}</div> : null}

      {!error && (
        <>
          <div className="stat-grid">
            <StatCard
              label="Total tool calls"
              value={loading ? "—" : totalCalls.toLocaleString()}
              foot={`Last ${windowHours >= 168 ? "7 days" : `${windowHours}h`}`}
            />
            <StatCard
              label="Hooks last 24h"
              value={loading ? "—" : (data?.hooksLast24h ?? 0).toLocaleString()}
              foot="Automation hook triggers"
            />
            <StatCard
              label="Error rate"
              value={loading ? "—" : errorRate}
              foot="Errors / total calls"
            />
          </div>

          <div className="page-head" style={{ marginTop: "var(--s-4)" }}>
            <div>
              <h2>Top tools</h2>
            </div>
          </div>

          {loading ? (
            <div
              className="card"
              style={{ color: "var(--fg-3)", fontSize: 13 }}
            >
              Loading…
            </div>
          ) : topTools.length === 0 ? (
            <div className="empty-state">
              <h3>No tool call data yet</h3>
              <p style={{ marginTop: "var(--s-2)", fontSize: 13 }}>
                Analytics data accumulates over time. Make a few tool calls and
                refresh.
              </p>
            </div>
          ) : (
            <div className="card" style={{ padding: "var(--s-5)" }}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--s-3)",
                }}
              >
                {topTools.map((t) => {
                  const fillPct = (t.calls / maxCalls) * 100;
                  const errPct = t.calls > 0 ? (t.errors / t.calls) * 100 : 0;
                  return (
                    <div
                      key={t.tool}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "200px 1fr auto",
                        alignItems: "center",
                        gap: "var(--s-3)",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 12,
                          color: "var(--fg-1)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={t.tool}
                      >
                        {t.tool}
                      </span>
                      <div
                        style={{
                          position: "relative",
                          height: 10,
                          background: "var(--bg-3)",
                          borderRadius: "var(--r-full)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            position: "absolute",
                            inset: 0,
                            width: `${fillPct}%`,
                            background: "var(--accent)",
                            borderRadius: "var(--r-full)",
                          }}
                        />
                        {errPct > 0 && (
                          <div
                            style={{
                              position: "absolute",
                              top: 0,
                              left: 0,
                              height: "100%",
                              width: `${(errPct / 100) * fillPct}%`,
                              background: "var(--err)",
                              borderRadius: "var(--r-full)",
                            }}
                          />
                        )}
                      </div>
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 12,
                          color: "var(--fg-3)",
                          whiteSpace: "nowrap",
                          minWidth: 80,
                          textAlign: "right",
                        }}
                      >
                        {t.calls.toLocaleString()} calls
                        {t.errors > 0 && (
                          <span style={{ color: "var(--err)", marginLeft: 6 }}>
                            {t.errors} err
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div
                style={{
                  marginTop: "var(--s-4)",
                  paddingTop: "var(--s-3)",
                  borderTop: "1px solid var(--border-subtle)",
                  display: "flex",
                  gap: "var(--s-6)",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontSize: 12, color: "var(--fg-3)" }}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      background: "var(--accent)",
                      borderRadius: 2,
                      marginRight: 6,
                      verticalAlign: "middle",
                    }}
                  />
                  Success
                </span>
                <span style={{ fontSize: 12, color: "var(--fg-3)" }}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      background: "var(--err)",
                      borderRadius: 2,
                      marginRight: 6,
                      verticalAlign: "middle",
                    }}
                  />
                  Errors
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--fg-3)",
                    marginLeft: "auto",
                  }}
                >
                  p50 / p95 latency shown below
                </span>
              </div>

              <table
                className="table"
                style={{ marginTop: "var(--s-4)", fontSize: 12 }}
              >
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Calls</th>
                    <th>Errors</th>
                    <th>p50</th>
                    <th>p95</th>
                  </tr>
                </thead>
                <tbody>
                  {topTools.map((t) => (
                    <tr key={t.tool}>
                      <td className="mono">{t.tool}</td>
                      <td className="mono">{t.calls.toLocaleString()}</td>
                      <td
                        className="mono"
                        style={
                          t.errors > 0 ? { color: "var(--err)" } : undefined
                        }
                      >
                        {t.errors}
                      </td>
                      <td className="mono">{fmtDuration(t.p50Ms)}</td>
                      <td className="mono">{fmtDuration(t.p95Ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div
            className="page-head"
            style={{ marginTop: "var(--s-8)", marginBottom: "var(--s-4)" }}
          >
            <div>
              <h2>Recent automation tasks</h2>
            </div>
          </div>

          {loading ? (
            <div
              className="card"
              style={{ color: "var(--fg-3)", fontSize: 13 }}
            >
              Loading…
            </div>
          ) : recentTasks.length === 0 ? (
            <div className="empty-state">
              <h3>No automation tasks yet</h3>
              <p style={{ marginTop: "var(--s-2)", fontSize: 13 }}>
                Automation task history accumulates over time as hooks trigger
                recipes.
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Name / ID</th>
                    <th>Status</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTasks.map((task) => {
                    const duration =
                      task.completedAt != null
                        ? fmtDuration(task.completedAt - task.startedAt)
                        : "—";
                    return (
                      <tr key={task.id}>
                        <td className="muted" style={{ whiteSpace: "nowrap" }}>
                          {relTime(task.startedAt)}
                        </td>
                        <td className="mono">
                          {task.name ?? task.id}
                          {task.name && (
                            <span
                              className="muted"
                              style={{ marginLeft: 8, fontSize: 11 }}
                            >
                              {task.id}
                            </span>
                          )}
                        </td>
                        <td>{taskStatusPill(task.status)}</td>
                        <td className="mono">{duration}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
