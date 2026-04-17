"use client";
import Link from "next/link";
import { relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

interface SessionSummary {
  id: string;
  connectedAt: string;
  openedFileCount: number;
  pendingApprovals: number;
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
            <div key={s.id} className="card">
              <div className="card-head">
                <h2>
                  <code
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 14,
                      color: "var(--fg-0)",
                    }}
                  >
                    {s.id.slice(0, 8)}
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
                    <Link
                      href={`/approvals?session=${s.id}`}
                      className="pill err"
                    >
                      {s.pendingApprovals}
                    </Link>
                  ) : (
                    <span style={{ color: "var(--fg-3)" }}>none</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
