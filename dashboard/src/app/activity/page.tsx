"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { relTime } from "@/components/time";
import { isDemoMode } from "@/lib/demoMode";
import { EventsHistogram, HBarList } from "@/components/patchwork";
import { SkeletonList } from "@/components/Skeleton";
import { ActivityTabs } from "@/components/ActivityTabs";

type Tab = "all" | "tools" | "recipe_start" | "recipe_end";

interface ActivityEvent {
  /** "tool" | "lifecycle" */
  kind: string;
  /** Tool name (only on kind="tool"). */
  tool?: string;
  status?: "success" | "error";
  durationMs?: number;
  errorMessage?: string;
  /** ISO 8601 timestamp from the bridge (both history + live stream). */
  timestamp?: string;
  /** Derived ms epoch, set by parse. */
  at?: number;
  id?: number;
  /** Lifecycle-only: the event name (extension_connected, approval_decision, …). */
  event?: string;
  /** Lifecycle-only: free-form metadata bag. */
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

function getLifecycleMeta(e: ActivityEvent) {
  const m = e.metadata ?? {};
  return {
    toolName: typeof m.toolName === "string" ? m.toolName : undefined,
    decision: typeof m.decision === "string" ? m.decision : undefined,
    reason: typeof m.reason === "string" ? m.reason : undefined,
    specifier: typeof m.specifier === "string" ? m.specifier : undefined,
    sessionId:
      typeof m.sessionId === "string" ? m.sessionId.slice(0, 8) : undefined,
    summary: typeof m.summary === "string" ? m.summary : undefined,
  };
}

const MAX_EVENTS = 200;

const RECIPE_START_EVENTS = new Set(["recipe_step_start", "TaskCreated", "InstructionsLoaded", "session_start"]);
const RECIPE_END_EVENTS = new Set(["recipe_step_done", "recipe_done", "PostCompact", "session_end", "recipe_end"]);

/** Connection-churn events that dominate the log but aren't actionable. */
const NOISE_EVENTS = new Set([
  "claude_connected",
  "claude_disconnected",
  "extension_connected",
  "extension_disconnected",
  "grace_started",
  "grace_expired",
]);

function withAt(e: ActivityEvent): ActivityEvent {
  if (typeof e.at === "number") return e;
  if (e.timestamp) {
    const ms = Date.parse(e.timestamp);
    if (Number.isFinite(ms)) return { ...e, at: ms };
  }
  return e;
}


export default function ActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [err, setErr] = useState<string>();
  const [tab, setTab] = useState<Tab>("all");
  const [, setTick] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  // Seed with recent history on mount, then open the live stream.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/activity?last=100"));
        if (res.ok) {
          const data = (await res.json()) as { events?: ActivityEvent[] };
          if (!cancelled) {
            // Bridge returns oldest-first; dashboard renders newest-first.
            const hist = (data.events ?? []).map(withAt).reverse();
            setEvents(hist.slice(0, MAX_EVENTS));
          }
        }
      } catch {
        // history fetch failed — live stream still opens below
      }
      if (!cancelled) setSeeded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const es = new EventSource(apiPath("/api/bridge/stream"));
    esRef.current = es;
    es.onopen = () => {
      setConnected(true);
      setErr(undefined);
    };
    es.onerror = () => {
      setConnected(false);
      if (!isDemoMode()) setErr("Disconnected — reconnecting…");
    };
    es.onmessage = (msg) => {
      try {
        const entry = withAt(JSON.parse(msg.data) as ActivityEvent);
        setEvents((prev) => {
          // Dedup by (id, kind) so the first live event doesn't duplicate
          // the most recent history row.
          if (
            entry.id !== undefined &&
            prev.some((p) => p.id === entry.id && p.kind === entry.kind)
          ) {
            return prev;
          }
          return [entry, ...prev].slice(0, MAX_EVENTS);
        });
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, []);

  // tick for relative timestamps
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    let out = events;
    if (tab === "tools") {
      out = out.filter((e) => e.kind === "tool");
    } else if (tab === "recipe_start") {
      out = out.filter(
        (e) => RECIPE_START_EVENTS.has(e.kind ?? "") || RECIPE_START_EVENTS.has(e.event ?? ""),
      );
    } else if (tab === "recipe_end") {
      out = out.filter(
        (e) => RECIPE_END_EVENTS.has(e.kind ?? "") || RECIPE_END_EVENTS.has(e.event ?? ""),
      );
    } else {
      out = out.filter(
        (e) => !(e.kind === "lifecycle" && NOISE_EVENTS.has(e.event ?? "")),
      );
    }
    return out;
  }, [events, tab]);

  const stats = useMemo(() => {
    let tools = 0;
    let errors = 0;
    let approvals = 0;
    const toolCounts: Record<string, number> = {};
    for (const e of events) {
      if (e.kind === "tool") {
        tools++;
        if (e.status === "error") errors++;
        if (e.tool) toolCounts[e.tool] = (toolCounts[e.tool] ?? 0) + 1;
      } else if (e.kind === "lifecycle" && e.event === "approval_decision") {
        approvals++;
      }
    }
    const topTools = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, value]) => ({ label, value }));
    return { tools, errors, approvals, topTools };
  }, [events]);

  return (
    <section>
      <ActivityTabs />
      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Activity — <span className="accent">every tool, every event, in real time.</span>
          </h1>
          <div className="editorial-sub">
            {events.length === 0
              ? "No events yet"
              : `${events.length} events · last 24h · ${stats.errors} errored`}
          </div>
        </div>
        <span className={`pill ${connected ? "ok" : "err"}`}>
          <span className="pill-dot" />
          {connected ? "Live" : "Offline"}
        </span>
      </div>

      {/* Charts row: histogram + top tools */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr minmax(0, 340px)",
          gap: "var(--s-4)",
          marginBottom: "var(--s-4)",
        }}
      >
        <div className="card" style={{ padding: "14px 18px 10px" }}>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-2xs)",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--ink-3)",
              marginBottom: 10,
            }}
          >
            Events / minute (last 24h)
          </div>
          <EventsHistogram events={events} hours={24} height={52} granularity="minute" />
        </div>
        {(
          <div className="card" style={{ padding: "14px 18px" }}>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-2xs)",
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
                marginBottom: 10,
              }}
            >
              Top tools
            </div>
            <HBarList items={stats.topTools} height={5} />
          </div>
        )}
      </div>

      {/* Tabs (toggle-button group, not ARIA tabs — there's no associated tabpanel
          since the table below is shared and just filters). */}
      <div
        role="group"
        aria-label="Filter events by type"
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "1px solid var(--border-subtle)",
          marginBottom: 12,
        }}
      >
        {(["all", "tools", "recipe_start", "recipe_end"] as Tab[]).map((t) => {
          const labels: Record<Tab, string> = {
            all: "All",
            tools: "Tool calls",
            recipe_start: "Recipe starts",
            recipe_end: "Recipe ends",
          };
          const count =
            t === "tools"
              ? stats.tools
              : t === "recipe_start"
                ? events.filter(
                    (e) => RECIPE_START_EVENTS.has(e.kind ?? "") || RECIPE_START_EVENTS.has(e.event ?? ""),
                  ).length
                : t === "recipe_end"
                  ? events.filter(
                      (e) => RECIPE_END_EVENTS.has(e.kind ?? "") || RECIPE_END_EVENTS.has(e.event ?? ""),
                    ).length
                  : events.length;
          return (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
              style={{
                padding: "6px 16px",
                fontSize: "var(--fs-s)",
                fontWeight: 500,
                cursor: "pointer",
                color: tab === t ? "var(--fg-0)" : "var(--fg-2)",
                background: "none",
                border: "none",
                borderBottom:
                  tab === t
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
              }}
            >
              {labels[t]}{" "}
              <span
                style={{
                  fontSize: "var(--fs-xs)",
                  color: tab === t ? "var(--accent)" : "var(--fg-3)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {err && !connected && <div className="alert-err">{err}</div>}

      {events.length === 0 ? (
        seeded ? (
          <div className="empty-state">
            <h3>No activity yet</h3>
            <p>Tool calls and bridge events will appear here — most recent first.</p>
          </div>
        ) : (
          <SkeletonList rows={5} columns={4} />
        )
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <h3>No events in this view</h3>
          <p>Try a different tab.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 140 }}>Time</th>
                <th style={{ width: 110 }}>Kind</th>
                <th>Tool / Event</th>
                <th style={{ width: 110 }}>Duration</th>
                <th style={{ width: 130 }}>Status / Decision</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => {
                const isTool = e.kind === "tool";
                const isLifecycle = e.kind === "lifecycle";
                const meta = getLifecycleMeta(e);
                const isApproval =
                  isLifecycle && e.event === "approval_decision";

                // Kind badge: specific event name (e.g. tool_call, recipe_step_start, recipe_step_done)
                const kindLabel = isTool ? "tool_call" : (e.event ?? e.kind);
                const kindClass = isApproval
                  ? meta.decision === "allow"
                    ? "ok"
                    : "err"
                  : isTool
                    ? e.status === "error"
                      ? "err"
                      : "ok"
                    : "muted";

                // Tool / Event cell — for lifecycle rows with just a
                // session id, show the session id alone instead of "— (…)".
                const mainLabel = isTool
                  ? (e.tool ?? "—")
                  : isApproval
                    ? (meta.toolName ?? "—")
                    : isLifecycle && meta.sessionId
                      ? `session ${meta.sessionId}`
                      : "—";
                const subLabel =
                  isApproval && meta.specifier ? ` (${meta.specifier})` : "";

                // Duration / reason cell
                const durationCell =
                  typeof e.durationMs === "number"
                    ? `${e.durationMs}ms`
                    : isApproval && meta.reason
                      ? meta.reason
                      : meta.summary
                        ? meta.summary
                        : "—";

                return (
                  <tr key={`${e.kind}-${e.id ?? i}-${i}`} style={{ cursor: "pointer" }}>
                    <td
                      className="muted"
                      title={e.at ? new Date(e.at).toISOString() : ""}
                    >
                      {e.at ? relTime(e.at) : "—"}
                    </td>
                    <td>
                      <span className={`pill ${kindClass}`}>{kindLabel}</span>
                    </td>
                    <td className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 300 }}>
                      {mainLabel}
                      {subLabel && <span className="muted">{subLabel}</span>}
                    </td>
                    <td className="mono muted">{durationCell}</td>
                    <td>
                      {isApproval ? (
                        <span
                          className={`status-cell ${meta.decision === "allow" ? "ok" : "err"}`}
                        >
                          <span className="pill-dot" />
                          {meta.decision ?? "—"}
                        </span>
                      ) : e.status ? (
                        <span
                          className={`status-cell ${e.status === "error" ? "err" : "ok"}`}
                        >
                          <span className="pill-dot" />
                          {e.status}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
