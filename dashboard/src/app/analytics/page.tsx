"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { StatCard } from "@/components/StatCard";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { AreaChart, EmptyState, ErrorState, RelationStrip, ToolChip } from "@/components/patchwork";
import type { AreaChartSeries } from "@/components/patchwork";
import { Skeleton, SkeletonList } from "@/components/Skeleton";
import { isHaltStatus } from "@/lib/runStatus";

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

// Count-up hook: animates from 0 to target over ~600ms on first load
function useCountUp(target: number, active: boolean): number {
  const [display, setDisplay] = useState(0);
  const frameRef = useRef<number | undefined>(undefined);
  const startTimeRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!active || target === 0) { setDisplay(target); return; }
    const duration = 600;
    const startVal = display;
    startTimeRef.current = undefined;
    const animate = (ts: number) => {
      if (startTimeRef.current === undefined) startTimeRef.current = ts;
      const elapsed = ts - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(startVal + (target - startVal) * eased));
      if (progress < 1) frameRef.current = requestAnimationFrame(animate);
    };
    frameRef.current = requestAnimationFrame(animate);
    return () => { if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, active]);
  return display;
}

export default function AnalyticsPage() {
  const windowHours = 24;
  // Always start at 0 so server and client first-render match. Filled in
  // after mount via the effect below — anything that depends on wall-clock
  // time must gate on `clientNow !== 0` to avoid hydration mismatches.
  const [clientNow, setClientNow] = useState(0);
  const [chartVisible, setChartVisible] = useState(false);
  useEffect(() => {
    setClientNow(Date.now());
    // Delay chart entrance for a staggered feel
    const t = setTimeout(() => setChartVisible(true), 150);
    return () => clearTimeout(t);
  }, []);

  const { data, error, loading, refetch } = useBridgeFetch<AnalyticsData>(
    `/api/bridge/analytics?windowHours=${windowHours}`,
    { intervalMs: 30000 },
  );

  const allTools = data?.topTools ?? [];
  const topTools = allTools.slice(0, 15);
  // KPI must reflect the full dataset, not just the visible top-15 — a
  // long tail of error-prone tools below the cutoff used to silently
  // disappear from the headline rate.
  const totalCalls = allTools.reduce((s, t) => s + t.calls, 0);
  const totalErrors = allTools.reduce((s, t) => s + t.errors, 0);
  const errorRate = totalCalls > 0 ? (totalErrors / totalCalls) * 100 : 0;
  const hooksFired = data?.hooksLast24h ?? 0;
  const maxCalls = topTools.length > 0 ? topTools[0].calls : 1;

  const recentTasks = (data?.recentAutomationTasks ?? []).slice(0, 20);

  // Count-up animated values (only animate when data first arrives)
  const dataLoaded = !loading && !!data;
  const animatedCalls = useCountUp(totalCalls, dataLoaded);
  const animatedTools = useCountUp(allTools.length, dataLoaded);
  const animatedHooks = useCountUp(hooksFired, dataLoaded);

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
        if (isHaltStatus(r.status)) errorsPerHour[slot]++;
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
      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Analytics — <span className="accent">what your agents actually do.</span>
          </h1>
          <div className="editorial-sub">
            tool usage · hook activity · recipe history
          </div>
          <RelationStrip
            items={[
              { label: "Recipes", href: "/recipes", title: "Recipes that produced this usage" },
              { label: "Runs", href: "/runs", title: "Recipe runs that drove this usage" },
              { label: "Activity", href: "/activity", title: "Raw activity stream" },
              { label: "Insights", href: "/insights", title: "Per-tool approval signals" },
            ]}
          />
        </div>
      </div>

      {error && !data && (
        <ErrorState
          title="Couldn't load analytics"
          description="The bridge isn't responding. Once it's back, this view will refresh on its own."
          error={error}
          onRetry={refetch}
        />
      )}
      {error && data && <div className="alert-err" role="alert">Refresh failed — {error}</div>}

      {(!error || data) && (
        <>
          <div className="stat-grid">
            <StatCard
              label="Total tool calls"
              value={loading ? <Skeleton width={48} height={26} /> :animatedCalls.toLocaleString()}
              foot="Last 24h"
              icon={
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(var(--orange-rgb), 0.12)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--orange)" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                </div>
              }
            />
            <StatCard
              label="Unique tools"
              value={loading ? <Skeleton width={48} height={26} /> :animatedTools.toLocaleString()}
              foot="Distinct tools invoked"
              icon={
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--purple-soft)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--purple)" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
                </div>
              }
            />
            <StatCard
              label="Hooks fired"
              value={loading ? <Skeleton width={48} height={26} /> :animatedHooks.toLocaleString()}
              foot="Automation hook triggers"
              icon={
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--green-soft)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--green)" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12h4l3-9 4 18 3-9h4"/></svg>
                </div>
              }
            />
            <StatCard
              label="Error rate"
              value={loading ? <Skeleton width={48} height={26} /> :`${errorRate.toFixed(1)}%`}
              foot="Errors / total calls"
              icon={
                <div style={{
                  width: 36, height: 36, borderRadius: 10,
                  background: errorRate > 0 ? "var(--red-soft)" : "var(--green-soft)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: errorRate > 0 ? "var(--red)" : "var(--green)",
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {errorRate > 0 ? (
                      <>
                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                        <line x1="12" y1="9" x2="12" y2="13"/>
                        <line x1="12" y1="17" x2="12.01" y2="17"/>
                      </>
                    ) : (
                      <path d="M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3"/>
                    )}
                  </svg>
                </div>
              }
            />
          </div>

          {/* Area chart — runs per hour */}
          <div
            className={`card${chartVisible ? " anl-chart-enter" : ""}`}
            style={{ padding: "14px 20px 10px", marginTop: "var(--s-4)", marginBottom: "var(--s-4)" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", marginBottom: 8 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-2xs)", fontWeight: 500, color: "var(--ink-3)" }}>
                Calls — last 24 hours
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 3, background: "var(--orange)", borderRadius: 2, display: "inline-block" }} />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-2xs)", color: "var(--ink-2)" }}>runs</span>
                <span style={{ width: 8, height: 3, background: "var(--red)", borderRadius: 2, display: "inline-block", marginLeft: 8 }} />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-2xs)", color: "var(--ink-2)" }}>errors</span>
              </span>
            </div>
            {clientNow === 0 ? (
              <div
                style={{
                  height: 140,
                  background: "linear-gradient(90deg, var(--line-2) 0%, transparent 100%)",
                  borderRadius: 4,
                  opacity: 0.3,
                }}
                aria-hidden="true"
              />
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
            <SkeletonList rows={5} columns={3} />
          ) : topTools.length === 0 ? (
            <EmptyState
              title="No tool calls recorded yet"
              description={
                recentTasks.length > 0
                  ? "Tool-call telemetry appears here once your agents invoke tools — recent recipe tasks are listed below."
                  : "Tool-call telemetry appears here once your agents invoke tools. Run a recipe or make a Claude request to get started."
              }
            />
          ) : (
            <div className="table-wrap">
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--fs-s)" }}>
                <tbody>
                  {topTools.map((t, i) => (
                    // Bridge-supplied list — toolName is not guaranteed
                    // unique (same tool across MCP namespaces / aggregation
                    // dupes). Suffix the index to avoid React key collisions.
                    <tr
                      key={`${t.tool}-${i}`}
                      style={{
                        borderBottom: "1px solid var(--line-3)",
                        animation: `anl-fade-up 0.3s ease both`,
                        animationDelay: `${i * 30}ms`,
                      }}
                    >
                      <td style={{ padding: "7px 8px", fontSize: "var(--fs-xs)", color: "var(--ink-0)", whiteSpace: "nowrap" }}>
                        <ToolChip name={t.tool} variant="link" />
                      </td>
                      <td style={{ padding: "7px 8px", width: "100%" }}>
                        <div style={{ background: "var(--line-3)", borderRadius: 2, height: 5, width: "100%" }}>
                          <div
                            className="anl-bar-animated"
                            style={{
                              background: "var(--orange)",
                              borderRadius: 2,
                              height: 5,
                              width: `${(t.calls / maxCalls) * 100}%`,
                              animationDelay: `${i * 30 + 100}ms`,
                            }}
                          />
                        </div>
                      </td>
                      <td style={{ textAlign: "right", padding: "7px 8px", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)", whiteSpace: "nowrap" }}>{t.calls}</td>
                      <td style={{ textAlign: "right", padding: "7px 8px", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)", color: t.errors > 0 ? "var(--err)" : "var(--ink-3)", whiteSpace: "nowrap" }}>{t.errors} err</td>
                      <td style={{ textAlign: "right", padding: "7px 8px", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)", color: "var(--ink-3)", whiteSpace: "nowrap" }} title="p50 latency">{fmtDuration(t.p50Ms)}</td>
                      <td style={{ textAlign: "right", padding: "7px 8px", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)", color: "var(--ink-3)", whiteSpace: "nowrap" }} title="p95 latency">{fmtDuration(t.p95Ms)}</td>
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
                  <h2>Recent recipe tasks</h2>
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
                          <td className="mono" title={task.id}>
                            {task.name ?? task.id.slice(0, 8)}
                            {task.name && (
                              <span
                                className="muted"
                                style={{ marginLeft: 8, fontSize: "var(--fs-xs)" }}
                              >
                                {task.id.slice(0, 8)}
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
