"use client";
import { useState } from "react";
import { relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { apiPath } from "@/lib/api";
import { Spinner } from "@/components/patchwork/Spinner";
import { ErrorState } from "@/components/patchwork";
import { SkeletonList } from "@/components/Skeleton";
import { ActivityTabs } from "@/components/ActivityTabs";

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

function recipeFor(s: SessionSummary): string {
  return s.firstTool ?? "session";
}

function descriptionFor(recipe: string, hasRealRecipe: boolean): string {
  if (!hasRealRecipe) return "no recipe metadata reported";
  return `${recipe} — running …`;
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

// ----------------------------------------------------------- log panel

function SessionLogPanel({
  shortId,
  recipe,
  toolCount,
}: {
  shortId: string;
  recipe: string;
  toolCount: number;
}) {
  const lines = [
    `$ patchwork run ${recipe}`,
    `→ resolving recipe templates/recipes/${recipe}.yaml`,
    `→ session ${shortId} streaming · live tail not yet wired`,
  ];

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--line-3)",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          color: "var(--ink-0)",
          fontWeight: 600,
        }}
      >
        <span>
          <span style={{ color: "var(--ink-2)" }}>&gt;_</span> {shortId} ·{" "}
          <span style={{ color: "var(--orange)" }}>{recipe}</span>
        </span>
        <span
          className="chip chip-accent"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.07em",
          }}
        >
          <span className="dot-live" aria-hidden />
          streaming
        </span>
      </div>

      {/* terminal body */}
      <div
        style={{
          background: "var(--terminal-bg)",
          color: "var(--terminal-fg)",
          fontFamily: "var(--font-mono)",
          fontSize: 12.5,
          lineHeight: 1.65,
          padding: "16px 18px",
          minHeight: 260,
          maxHeight: "calc(100vh - 280px)",
          overflowY: "auto",
        }}
      >
        {lines.map((l, i) => (
          <div
            key={i}
            style={{
              color: l.startsWith("$")
                ? "var(--terminal-prompt)"
                : "var(--terminal-comment)",
              whiteSpace: "pre-wrap",
            }}
          >
            {l}
          </div>
        ))}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 14,
            color: "var(--terminal-fg)",
          }}
        >
          <Spinner size={12} />
          <span>
            composing brief… ( {toolCount} tools called)
          </span>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------- page

export default function SessionsPage() {
  const { data, error, loading } = useBridgeFetch<SessionSummary[]>(
    "/api/bridge/sessions",
    { intervalMs: 3000 },
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sessions = data ?? [];

  const liveCount = sessions.filter((s) => {
    const lastMs =
      typeof s.lastActivityAt === "number"
        ? s.lastActivityAt
        : s.lastActivityAt
          ? Date.parse(s.lastActivityAt)
          : undefined;
    return activityState(lastMs).label === "live";
  }).length;
  const idleCount = sessions.length - liveCount;

  const selectedIndex = selectedId
    ? sessions.findIndex((s) => s.id === selectedId)
    : -1;
  const selectedSession = selectedIndex >= 0 ? sessions[selectedIndex] : null;

  return (
    <section>
      <ActivityTabs />
      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Live sessions —{" "}
            <span className="accent">see what your agents are doing right now.</span>
          </h1>
          <div className="editorial-sub">
            {liveCount} live · {idleCount} idle
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            className="btn sm ghost"
            disabled={sessions.length === 0}
            style={sessions.length === 0 ? { opacity: 0.4, cursor: "default" } : undefined}
            onClick={() => {
              if (sessions.length === 0) return;
              void fetch(apiPath("/api/bridge/sessions/pause-all"), { method: "POST" });
            }}
          >
            <span aria-hidden style={{ marginRight: 6 }}>❚❚</span>
            Pause all
          </button>
        </div>
      </div>

      {error && sessions.length === 0 && (
        <ErrorState
          title="Couldn't load sessions"
          description="The bridge isn't responding to /sessions."
          error={error}
          onRetry={() => window.location.reload()}
        />
      )}
      {error && sessions.length > 0 && (
        <div className="alert-err">Refresh failed — {error}</div>
      )}

      {loading && sessions.length === 0 && (
        <SkeletonList rows={4} columns={3} />
      )}

      {!loading && sessions.length === 0 && !error ? (
        <div className="empty">
          <h3 style={{ color: "var(--ink-1)", marginBottom: 8 }}>No active sessions</h3>
          <p style={{ color: "var(--ink-2)", fontSize: 13, maxWidth: 420, margin: "0 auto 12px" }}>
            No Claude Code agents are currently connected to the bridge.
          </p>
          <p style={{ color: "var(--ink-3)", fontSize: 13, maxWidth: 420, margin: "0 auto 16px" }}>
            Connect a Claude Code session to the bridge to see live activity here.{" "}
            <a href="https://docs.anthropic.com/claude-code" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              Learn more →
            </a>
          </p>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              void fetch(apiPath("/api/bridge/sessions")).then(() => window.location.reload());
            }}
          >
            Refresh
          </button>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: sessions.length > 0 ? "340px minmax(0,1fr)" : "1fr",
            gap: "var(--s-4)",
            alignItems: "start",
          }}
        >
          {/* left: session card list */}
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
            {sessions.map((s, idx) => {
              const lastMs =
                typeof s.lastActivityAt === "number"
                  ? s.lastActivityAt
                  : s.lastActivityAt
                    ? Date.parse(s.lastActivityAt)
                    : undefined;
              const act = activityState(lastMs);
              const toolCount = s.toolCount ?? 0;
              const isSelected = selectedId === s.id;
              const recipe = recipeFor(s);
              const description = descriptionFor(recipe, Boolean(s.firstTool));

              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedId(isSelected ? null : s.id)}
                  className="glass-card glass-card--hover"
                  style={{
                    textAlign: "left",
                    textDecoration: "none",
                    color: "inherit",
                    padding: "16px 18px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--s-3)",
                    borderLeft: isSelected
                      ? "3px solid var(--orange)"
                      : "3px solid transparent",
                    cursor: "pointer",
                    background: isSelected ? "var(--recess)" : undefined,
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
                          fontFamily: "var(--font-mono)",
                          fontSize: 14,
                          fontWeight: 700,
                          color: "var(--ink-0)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        s{idx + 1} · {recipe}
                      </div>
                    </div>
                    <span
                      className={`chip ${
                        act.label === "live"
                          ? "chip-accent"
                          : act.label === "recent"
                            ? "chip-amber"
                            : "chip-muted"
                      }`}
                      style={{
                        flexShrink: 0,
                        textTransform: "uppercase",
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        letterSpacing: "0.06em",
                      }}
                    >
                      {act.label === "live" && <span className="dot-live" aria-hidden />}
                      {act.label}
                    </span>
                  </div>

                  {/* description */}
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--ink-2)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {description}
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
                            s.pendingApprovals > 0 ? "var(--amber)" : "var(--ink-0)",
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
                    <span>connected {relTime(new Date(s.connectedAt).getTime())}</span>
                    {s.remoteAddr && (
                      <span className="mono">{s.remoteAddr}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* right: log panel */}
          <div style={{ position: "sticky", top: 80 }}>
            {selectedId && selectedSession ? (
              <SessionLogPanel
                shortId={`s${selectedIndex + 1}`}
                recipe={recipeFor(selectedSession)}
                toolCount={selectedSession.toolCount ?? 0}
              />
            ) : (
              <div
                style={{
                  color: "var(--ink-3)",
                  fontSize: 13,
                  padding: 24,
                  textAlign: "center",
                }}
              >
                Select a session to see its log.
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
