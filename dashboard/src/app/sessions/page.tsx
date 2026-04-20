"use client";
import Link from "next/link";
import { relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

interface SessionSummary {
  id: string;
  connectedAt: string;
  openedFileCount: number;
  pendingApprovals: number;
  firstTool?: string;
  remoteAddr?: string;
}

export default function SessionsPage() {
  const { data, error, loading } = useBridgeFetch<SessionSummary[]>(
    "/api/bridge/sessions",
    { intervalMs: 3000 },
  );

  const sessions = data ?? [];

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Sessions</h1>
          <div className="page-head-sub">
            Active Claude Code agent sessions connected to the bridge.
          </div>
        </div>
        <span className="pill muted">
          {sessions.length} session{sessions.length !== 1 ? "s" : ""}
        </span>
      </div>

      {error && <div className="alert-err">Unreachable: {error}</div>}

      {!loading && sessions.length === 0 && !error ? (
        <div className="empty-state">
          <h3>No active sessions</h3>
          <p>No Claude Code agents are currently connected to the bridge.</p>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: "var(--s-4)",
          }}
        >
          {sessions.map((s) => (
            <Link
              key={s.id}
              href={`/sessions/${s.id}`}
              className="card"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div className="card-head">
                <h2 style={{ display: "flex", flexDirection: "column", gap: "var(--s-1)" }}>
                  <span style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 600 }}>
                    {s.firstTool ?? "idle"}
                  </span>
                  <code
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--fg-3)",
                      fontWeight: 400,
                    }}
                  >
                    {s.id.slice(0, 8)}
                    {s.remoteAddr ? ` · ${s.remoteAddr}` : ""}
                  </code>
                </h2>
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--s-2)",
                  fontSize: 13,
                  color: "var(--fg-2)",
                }}
              >
                <div
                  style={{ display: "flex", justifyContent: "space-between" }}
                >
                  <span>Connected</span>
                  <span style={{ color: "var(--fg-1)" }}>
                    {relTime(new Date(s.connectedAt).getTime())}
                  </span>
                </div>
                <div
                  style={{ display: "flex", justifyContent: "space-between" }}
                >
                  <span>Open files</span>
                  <span style={{ color: "var(--fg-1)" }}>
                    {s.openedFileCount}
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span>Pending approvals</span>
                  {s.pendingApprovals > 0 ? (
                    <span className="pill err">{s.pendingApprovals}</span>
                  ) : (
                    <span style={{ color: "var(--fg-3)" }}>none</span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
