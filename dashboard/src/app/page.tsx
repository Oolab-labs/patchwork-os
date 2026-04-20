"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { StatCard } from "@/components/StatCard";
import { fmtDuration, relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

interface BridgeHealth {
  status: string;
  uptimeMs: number;
  connections: number;
  extensionConnected: boolean;
  extensionVersion: string;
  activeSessions: number;
}

interface Overview {
  pendingApprovals: number;
  runningTasks: number;
  recentActivity: number;
  uptimeMs: number | null;
  bridgeOk: boolean;
}

interface DecisionTrace {
  traceType: "decision";
  ts: number;
  key: string;
  summary: string;
  body: {
    ref?: string;
    problem?: string;
    solution?: string;
    tags?: string[];
  };
}

interface TracesResponse {
  traces: DecisionTrace[];
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
        fetch("/api/bridge/approvals")
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
        fetch("/api/bridge/tasks")
          .then((r) => (r.ok ? r.json() : { tasks: [] }))
          .catch(() => ({ tasks: [] })),
        fetch("/api/bridge/metrics")
          .then((r) => (r.ok ? r.text() : ""))
          .catch(() => ""),
      ]);
      if (!alive) return;
      const metricsText = metrics as string;
      const uptime = parseUptimeMs(metricsText);
      const toolCalls = parseToolCallTotal(metricsText);
      setData({
        pendingApprovals: Array.isArray(approvals) ? approvals.length : 0,
        runningTasks: (tasks.tasks ?? []).filter(
          (t: { status: string }) =>
            t.status === "running" || t.status === "pending",
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

  const {
    data: health,
    error: healthError,
    loading: healthLoading,
  } = useBridgeFetch<BridgeHealth>("/api/bridge/health", { intervalMs: 5000 });

  const { data: tracesData } = useBridgeFetch<TracesResponse>(
    "/api/bridge/traces?traceType=decision&limit=5",
    { intervalMs: 10000 },
  );
  const recentDecisions = tracesData?.traces ?? [];

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

      <div className="page-head" style={{ marginTop: "var(--s-4)" }}>
        <div>
          <h2>Bridge Status</h2>
        </div>
      </div>

      {!healthLoading && healthError ? (
        <p
          style={{
            color: "var(--fg-3)",
            fontSize: 13,
            marginBottom: "var(--s-8)",
          }}
        >
          Bridge offline
        </p>
      ) : !healthLoading && health ? (
        <div className="stat-grid">
          <StatCard
            label="Uptime"
            value={fmtDuration(health.uptimeMs)}
            foot="Bridge uptime"
          />
          <StatCard
            label="Sessions"
            value={health.activeSessions}
            foot="Active Claude Code sessions"
          />
          <StatCard
            label="Extension"
            value={
              <span
                className={`pill ${health.extensionConnected ? "ok" : "err"}`}
                title={
                  health.extensionConnected
                    ? undefined
                    : "VS Code extension not connected — install claude-ide-bridge extension in VS Code or check Settings"
                }
              >
                <span className="pill-dot" />
                {health.extensionConnected ? "Connected" : "Disconnected"}
              </span>
            }
            foot={
              health.extensionConnected
                ? (health.extensionVersion ?? "—")
                : "Not connected — see Settings"
            }
          />
          <StatCard
            label="Connections"
            value={health.connections}
            foot="WebSocket clients"
          />
        </div>
      ) : null}

      {recentDecisions.length > 0 && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Recent decisions</h2>
            <Link
              href="/decisions"
              className="pill muted"
              style={{ textDecoration: "none" }}
            >
              View all →
            </Link>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--s-2)",
            }}
          >
            {recentDecisions.map((t) => {
              const b = t.body;
              const ref = b.ref ?? t.key;
              const tags = Array.isArray(b.tags) ? b.tags.slice(0, 3) : [];
              const colorClass = decisionRowColor(ref, tags);
              return (
                <Link
                  key={`${t.ts}:${t.key}`}
                  href="/decisions"
                  className={`decision-row ${colorClass}`}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--fg-0)",
                      flexShrink: 0,
                      paddingLeft: "var(--s-3)",
                    }}
                  >
                    {ref}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 12,
                      color: "var(--fg-2)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {b.solution ?? t.summary}
                  </span>
                  {tags.length > 0 && (
                    <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      {tags.map((tag) => (
                        <span
                          key={tag}
                          className="pill muted"
                          style={{ fontSize: 10, padding: "1px 6px" }}
                        >
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--fg-3)",
                      flexShrink: 0,
                    }}
                  >
                    {relTime(t.ts)}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

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

function decisionRowColor(ref: string, tags: string[]): string {
  if (ref.startsWith("PR-") || ref.startsWith("#")) return "decision-row-info";
  const allTags = tags.join(" ").toLowerCase();
  if (allTags.includes("gemini") || allTags.includes("driver")) return "decision-row-warn";
  if (allTags.includes("bug") || allTags.includes("fix") || allTags.includes("err")) return "decision-row-err";
  return "decision-row-accent";
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
    const m = line.match(
      /^bridge_tool_calls_total(?:\{[^}]*\})?\s+(\d+(?:\.\d+)?)/,
    );
    if (m) total += Number.parseFloat(m[1]);
  }
  return Math.round(total);
}
