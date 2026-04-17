"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { fmtDuration } from "@/components/time";

interface Overview {
  pendingApprovals: number;
  runningTasks: number;
  recentActivity: number;
  uptimeMs: number | null;
  bridgeOk: boolean;
}

export default function HomePage() {
  const [data, setData] = useState<Overview>({
    pendingApprovals: 0,
    runningTasks: 0,
    recentActivity: 0,
    uptimeMs: null,
    bridgeOk: false,
  });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const [approvals, tasks, metrics] = await Promise.all([
        fetch("/api/bridge/approvals").then((r) => (r.ok ? r.json() : [])).catch(() => []),
        fetch("/api/bridge/tasks").then((r) => (r.ok ? r.json() : { tasks: [] })).catch(() => ({ tasks: [] })),
        fetch("/api/bridge/metrics").then((r) => (r.ok ? r.text() : "")).catch(() => ""),
      ]);
      if (!alive) return;
      const metricsText = metrics as string;
      const uptime = parseUptimeMs(metricsText);
      const toolCalls = parseToolCallTotal(metricsText);
      setData({
        pendingApprovals: Array.isArray(approvals) ? approvals.length : 0,
        runningTasks: (tasks.tasks ?? []).filter(
          (t: { status: string }) => t.status === "running" || t.status === "pending",
        ).length,
        recentActivity: toolCalls,
        uptimeMs: uptime,
        bridgeOk: true,
      });
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <div className="page-head-sub">
            Real-time snapshot of your Patchwork OS bridge.
          </div>
        </div>
      </div>

      <div className="stat-grid">
        <Link className="stat-card" href="/approvals">
          <div className="stat-card-label">Pending approvals</div>
          <div className="stat-card-value">{data.pendingApprovals}</div>
          <div className="stat-card-foot">
            {data.pendingApprovals === 0 ? "All clear" : "Awaiting decision"}
          </div>
        </Link>
        <Link className="stat-card" href="/tasks">
          <div className="stat-card-label">Running tasks</div>
          <div className="stat-card-value">{data.runningTasks}</div>
          <div className="stat-card-foot">Claude subprocess orchestration</div>
        </Link>
        <Link className="stat-card" href="/activity">
          <div className="stat-card-label">Tool calls</div>
          <div className="stat-card-value">{data.recentActivity}</div>
          <div className="stat-card-foot">Total this session</div>
        </Link>
        <Link className="stat-card" href="/metrics">
          <div className="stat-card-label">Bridge uptime</div>
          <div className="stat-card-value">
            {data.uptimeMs != null ? fmtDuration(data.uptimeMs) : "—"}
          </div>
          <div className="stat-card-foot">Since last restart</div>
        </Link>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Quick actions</h2>
        </div>
        <p style={{ color: "var(--fg-2)", fontSize: 13 }}>
          Jump to a page from the sidebar, or open a terminal and run{" "}
          <code>patchwork recipe install &lt;file&gt;</code> to add a new
          automation recipe.
        </p>
      </div>
    </section>
  );
}

function parseUptimeMs(text: string): number | null {
  if (!text) return null;
  const m = text.match(/^bridge_uptime_seconds\s+(\d+(?:\.\d+)?)/m);
  if (m) return Math.round(Number.parseFloat(m[1]) * 1000);
  return null;
}

function parseToolCallTotal(text: string): number {
  if (!text) return 0;
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^bridge_tool_calls_total(?:\{[^}]*\})?\s+(\d+(?:\.\d+)?)/);
    if (m) total += Number.parseFloat(m[1]);
  }
  return Math.round(total);
}
