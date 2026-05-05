"use client";
import { useEffect, useMemo, useState } from "react";
import { StatCard } from "@/components/StatCard";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { AreaChart, ErrorState } from "@/components/patchwork";
import { AnalyticsTabs } from "@/components/AnalyticsTabs";
import type { AreaChartSeries } from "@/components/patchwork";

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
  startedAt?: number;
  completedAt?: number;
}

interface AnalyticsData {
  topTools: ToolStat[];
  hooksLast24h: number;
  recentAutomationTasks: AutomationTask[];
}

function relTime(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
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
  // Coalesce NaN / Infinity to em-dash so the percentile cells don't render
  // the literal "NaNs" string. Single-sample tools (one observation, no
  // percentile defined) are the realistic source of NaN here.
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

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
  const windowHours = 24;
  // Always start at 0 so server and client first-render match. Filled in
  // after mount via the effect below — anything that depends on wall-clock
  // time must gate on `clientNow !== 0` to avoid hydration mismatches.
  const [clientNow, setClientNow] = useState(0);
  useEffect(() => { setClientNow(Date.now()); }, []);

  const { data, error, loading } = useBridgeFetch<AnalyticsData>(
    `/api/bridge/analytics?windowHours=${windowHours}`,
    { intervalMs: 30000 },
  );

  const topTools = (data?.topTools ?? []).slice(0, 15);
  const totalCalls = topTools.reduce((s, t) => s + t.calls, 0);
  const totalErrors = topTools.reduce((s, t) => s + t.errors, 0);
  const errorRate = totalCalls > 0 ? (totalErrors / totalCalls) * 100 : 0;
  const hooksFired = data?.hooksLast24h ?? 0;
  const maxCalls = topTools.length > 0 ? topTools[0].calls : 1;

  const recentTasks = (data?.recentAutomationTasks ?? []).slice(0, 20);

  interface RunBrief { createdAt: number; status: string; durationMs: number }
  const { data: runsData } = useBridgeFetch<{ runs?: RunBrief[] }>(
    `/api/bridge/runs?limit=500`,
    { intervalMs: 60000 },
  );

  const { areaSeries, areaLabels } = useMemo<{ areaSeries: AreaChartSeries[]; areaLabels: string[] }>(() => {
    const runs = runsData?.runs ?? [];
    const buckets = windowHours;
    const now = clientNow;
    const slotMs = 3_600_000;
    const callsPerHour = Array<number>(buckets).fill(0);
    const errorsPerHour = Array<number>(buckets).fill(0);
    if (now !== 0) {
      for (const r of runs) {
        const hoursAgo = (now - r.createdAt) / slotMs;
        if (hoursAgo < 0 || hoursAgo >= buckets) continue;
        const slot = buckets - 1 - Math.floor(hoursAgo);
        callsPerHour[slot]++;
        if (r.status === "error") errorsPerHour[slot]++;
      }
    }
    // Anchor the axis at the user's clock: 24h ago on the left, "now" on
    // the right, and 6-hour ticks in between. Labels read as wall-clock
    // time so the user can reconcile peaks with their day, not as relative
    // offsets which mix poorly with the explicit "now" anchor.
    const labels = Array.from({ length: buckets }, (_, i) => {
      if (now === 0) return "";
      if (i === buckets - 1) return "now";
      if (i === 0) {
        const t = new Date(now - (buckets - 1) * slotMs);
        return `${String(t.getHours()).padStart(2, "0")}:00`;
      }
      const t = new Date(now - (buckets - 1 - i) * slotMs);
      const h = t.getHours();
      if (h % 6 === 0) {
        return `${String(h).padStart(2, "0")}:00`;
      }
      return "";
    });
    return {
      areaSeries: [
        { values: callsPerHour, color: "var(--orange)", label: "Runs" },
        { values: errorsPerHour, color: "var(--red)", label: "Errors" },
      ],
      areaLabels: labels,
    };
  }, [runsData, windowHours, clientNow]);

  return (
    <section>
      <AnalyticsTabs />
      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Analytics — <span className="accent">what your agents actually do.</span>
          </h1>
          <div className="editorial-sub">
            tool usage · hook activity · automation history
          </div>
        </div>
      </div>

      {error && !data && (
        <ErrorState
          title="Couldn't load analytics"
          description="The bridge isn't responding. Once it's back, this view will refresh on its own."
          error={error}
          onRetry={() => window.location.reload()}
        />
      )}
      {error && data && <div className="alert-err">Refresh failed — {error}</div>}

      {(!error || data) && (
        <>
          <div className="stat-grid">
            <StatCard
              label="Total tool calls"
              value={loading ? "—" : totalCalls.toLocaleString()}
              foot="Last 24h"
              icon={
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(var(--orange-rgb), 0.12)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--orange)" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                </div>
              }
            />
            <StatCard
              label="Unique tools"
              value={loading ? "—" : topTools.length.toLocaleString()}
              foot="Distinct tools invoked"
              icon={
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--purple-soft)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--purple)" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
                </div>
              }
            />
            <StatCard
              label="Hooks fired"
              value={loading ? "—" : hooksFired.toLocaleString()}
              foot="Automation hook triggers"
              icon={
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--green-soft)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--green)" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12h4l3-9 4 18 3-9h4"/></svg>
                </div>
              }
            />
            <StatCard
              label="Error rate"
              value={loading ? "—" : `${errorRate.toFixed(1)}%`}
              foot="Errors / total calls"
              icon={
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--red-soft)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--red)" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                </div>
              }
            />
          </div>

          {/* Area chart — runs per hour */}
          <div className="card" style={{ padding: "14px 20px 10px", marginTop: "var(--s-4)", marginBottom: "var(--s-4)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", marginBottom: 8 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)" }}>
                Calls — last 24 hours
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 3, background: "var(--orange)", borderRadius: 2, display: "inline-block" }} />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-2)" }}>runs</span>
                <span style={{ width: 8, height: 3, background: "var(--red)", borderRadius: 2, display: "inline-block", marginLeft: 8 }} />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-2)" }}>errors</span>
              </span>
            </div>
            {clientNow === 0 ? (
              <div style={{ height: 140 }} aria-hidden="true" />
            ) : (
              <AreaChart series={areaSeries} xLabels={areaLabels} height={140} yTicks={4} />
            )}
          </div>

          <div className="page-head" style={{ marginTop: "var(--s-2)" }}>
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
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <tbody>
                  {topTools.map((t) => (
                    <tr key={t.tool} style={{ borderBottom: "1px solid var(--line-3)" }}>
                      <td style={{ padding: "7px 8px", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-0)", whiteSpace: "nowrap" }}>{t.tool}</td>
                      <td style={{ padding: "7px 8px", width: "100%" }}>
                        <div style={{ background: "var(--line-3)", borderRadius: 2, height: 5, width: "100%" }}>
                          <div style={{ background: "var(--orange)", borderRadius: 2, height: 5, width: `${(t.calls / maxCalls) * 100}%` }} />
                        </div>
                      </td>
                      <td style={{ textAlign: "right", padding: "7px 8px", fontFamily: "var(--font-mono)", fontSize: 11.5, whiteSpace: "nowrap" }}>{t.calls}</td>
                      <td style={{ textAlign: "right", padding: "7px 8px", fontFamily: "var(--font-mono)", fontSize: 11.5, color: t.errors > 0 ? "var(--err)" : "var(--ink-3)", whiteSpace: "nowrap" }}>{t.errors} err</td>
                      <td style={{ textAlign: "right", padding: "7px 8px", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-3)", whiteSpace: "nowrap" }} title="p50 latency">{fmtDuration(t.p50Ms)}</td>
                      <td style={{ textAlign: "right", padding: "7px 8px", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-3)", whiteSpace: "nowrap" }} title="p95 latency">{fmtDuration(t.p95Ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {recentTasks.length > 0 && (
            <>
              <div
                className="page-head"
                style={{ marginTop: "var(--s-8)", marginBottom: "var(--s-4)" }}
              >
                <div>
                  <h2>Recent automation tasks</h2>
                </div>
              </div>

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
                        task.completedAt != null && task.startedAt != null
                          ? fmtDuration(task.completedAt - task.startedAt)
                          : "—";
                      return (
                        <tr key={task.id}>
                          <td className="muted" style={{ whiteSpace: "nowrap" }}>
                            {clientNow === 0 ? "—" : relTime(task.startedAt)}
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
            </>
          )}
        </>
      )}
    </section>
  );
}
