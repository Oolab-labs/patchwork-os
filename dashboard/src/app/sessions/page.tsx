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
  toolCount?: number;
  lastActivityAt?: string | number;
  clientType?: string;
}

function inferClientType(s: SessionSummary): string {
  if (s.clientType) return s.clientType;
  if (s.remoteAddr && s.remoteAddr !== "127.0.0.1" && s.remoteAddr !== "::1") {
    return "remote";
  }
  return "local";
}

function activityState(
  lastAt: number | undefined,
): { color: string; label: string } {
  if (!lastAt) return { color: "var(--ink-3)", label: "idle" };
  const diff = Date.now() - lastAt;
  if (diff < 30_000) return { color: "var(--green)", label: "live" };
  if (diff < 5 * 60_000) return { color: "var(--amber)", label: "recent" };
  return { color: "var(--ink-3)", label: "idle" };
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
            Active Claude Code sessions connected to the bridge.
          </div>
        </div>
        <span className="pill muted">
          {sessions.length} session{sessions.length !== 1 ? "s" : ""}
        </span>
      </div>

      {error && <div className="alert-err">Unreachable: {error}</div>}

      {loading && sessions.length === 0 && (
        <p style={{ color: "var(--fg-2)" }}>Loading…</p>
      )}

      {!loading && sessions.length === 0 && !error ? (
        <div className="empty-state">
          <h3>No active sessions</h3>
          <p>No Claude Code agents are currently connected to the bridge.</p>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: "var(--s-4)",
          }}
        >
          {sessions.map((s) => {
            const lastMs =
              typeof s.lastActivityAt === "number"
                ? s.lastActivityAt
                : s.lastActivityAt
                  ? Date.parse(s.lastActivityAt)
                  : undefined;
            const act = activityState(lastMs);
            const clientType = inferClientType(s);
            const toolCount = s.toolCount ?? 0;

            return (
              <Link
                key={s.id}
                href={`/sessions/${s.id}`}
                className="glass-card glass-card--hover"
                style={{
                  textDecoration: "none",
                  color: "inherit",
                  padding: "16px 18px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--s-3)",
                }}
              >
                {/* header */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "var(--s-2)",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 10,
                        color: "var(--ink-2)",
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.07em",
                        marginBottom: 2,
                      }}
                    >
                      {clientType}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 14,
                        fontWeight: 700,
                        color: "var(--ink-0)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.id.slice(0, 12)}
                    </div>
                  </div>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 10,
                      color: act.color,
                      fontWeight: 600,
                      flexShrink: 0,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: act.color,
                        boxShadow:
                          act.label === "live"
                            ? `0 0 0 3px ${act.color}22`
                            : "none",
                      }}
                    />
                    {act.label}
                  </span>
                </div>

                {/* first tool */}
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--ink-2)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  first tool:{" "}
                  <span
                    className="mono"
                    style={{ color: "var(--ink-0)", fontSize: 12 }}
                  >
                    {s.firstTool ?? "—"}
                  </span>
                </div>

                {/* metrics row */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: 8,
                    paddingTop: "var(--s-2)",
                    borderTop: "1px solid var(--line-3)",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 17,
                        fontWeight: 700,
                        fontFamily: "var(--font-mono)",
                        color: "var(--ink-0)",
                        lineHeight: 1,
                      }}
                    >
                      {toolCount}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "var(--ink-2)",
                        marginTop: 3,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                      }}
                    >
                      Tools
                    </div>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 17,
                        fontWeight: 700,
                        fontFamily: "var(--font-mono)",
                        color: "var(--ink-0)",
                        lineHeight: 1,
                      }}
                    >
                      {s.openedFileCount}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "var(--ink-2)",
                        marginTop: 3,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                      }}
                    >
                      Files
                    </div>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 17,
                        fontWeight: 700,
                        fontFamily: "var(--font-mono)",
                        color:
                          s.pendingApprovals > 0
                            ? "var(--amber)"
                            : "var(--ink-0)",
                        lineHeight: 1,
                      }}
                    >
                      {s.pendingApprovals}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "var(--ink-2)",
                        marginTop: 3,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                      }}
                    >
                      Pending
                    </div>
                  </div>
                </div>

                {/* footer */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 11,
                    color: "var(--ink-3)",
                  }}
                >
                  <span>
                    connected {relTime(new Date(s.connectedAt).getTime())}
                  </span>
                  {s.remoteAddr && (
                    <span className="mono">{s.remoteAddr}</span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
