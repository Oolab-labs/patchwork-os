"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { relTime } from "@/components/time";

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
  const [filter, setFilter] = useState("");
  const [showNoise, setShowNoise] = useState(false);
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
      setErr("Disconnected — reconnecting…");
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
    const q = filter.trim().toLowerCase();
    let out = events;
    if (!showNoise) {
      out = out.filter(
        (e) => !(e.kind === "lifecycle" && NOISE_EVENTS.has(e.event ?? "")),
      );
    }
    if (!q) return out;
    return out.filter((e) => {
      const m = getLifecycleMeta(e);
      const hay =
        `${e.kind} ${e.event ?? ""} ${e.tool ?? ""} ${m.toolName ?? ""} ${e.status ?? ""} ${m.decision ?? ""} ${m.reason ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [events, filter, showNoise]);

  const hiddenCount = useMemo(
    () =>
      showNoise
        ? 0
        : events.filter(
            (e) => e.kind === "lifecycle" && NOISE_EVENTS.has(e.event ?? ""),
          ).length,
    [events, showNoise],
  );

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <div className="page-head-sub">
            Real-time tool calls and bridge events.
          </div>
        </div>
        <span className={`pill ${connected ? "ok" : "err"}`}>
          <span className="pill-dot" />
          {connected ? "Live" : "Offline"}
        </span>
      </div>

      <div className="activity-toolbar">
        <input
          className="input"
          placeholder="Filter by tool, kind, or status…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter events"
        />
        <button
          type="button"
          onClick={() => setShowNoise((v) => !v)}
          className={showNoise ? "pill" : "pill muted"}
          style={{ cursor: "pointer" }}
          title="Show connect/disconnect/grace lifecycle events — noisy, not actionable"
        >
          {showNoise ? "Hide" : "Show"} connection events
          {!showNoise && hiddenCount > 0 ? ` (${hiddenCount})` : ""}
        </button>
        <span className="pill muted">
          {filtered.length} / {events.length} events
        </span>
      </div>

      {err && !connected && <div className="alert-err">{err}</div>}

      {events.length === 0 ? (
        <div className="empty-state">
          <h3>{seeded ? "No activity yet" : "Loading history…"}</h3>
          <p>
            {seeded
              ? "Tool calls and bridge events will appear here — most recent first."
              : "Fetching recent events from the bridge."}
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <h3>
            {filter
              ? "No events match that filter"
              : `${hiddenCount} connection event${hiddenCount === 1 ? "" : "s"} hidden`}
          </h3>
          <p>
            {filter
              ? "Try a different search term, or clear the filter."
              : "Connection and grace events are hidden by default. Click \"Show connection events\" to see them."}
          </p>
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

                // Kind badge: "tool" | event name for lifecycle
                const kindLabel = isTool ? "tool" : (e.event ?? e.kind);
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
                  <tr key={`${e.kind}-${e.id ?? i}-${i}`}>
                    <td
                      className="muted"
                      title={e.at ? new Date(e.at).toISOString() : ""}
                    >
                      {e.at ? relTime(e.at) : "—"}
                    </td>
                    <td>
                      <span className={`pill ${kindClass}`}>{kindLabel}</span>
                    </td>
                    <td className="mono">
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
