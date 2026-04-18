"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { relTime } from "@/components/time";

interface ActivityEvent {
  kind: string;
  tool?: string;
  status?: "success" | "error";
  durationMs?: number;
  /** ISO 8601 timestamp from the bridge (both history + live stream). */
  timestamp?: string;
  /** Derived ms epoch, set by parse. */
  at?: number;
  id?: number;
  // approval_decision fields (from metadata spread)
  toolName?: string;
  decision?: string;
  reason?: string;
  permissionMode?: string;
  specifier?: string;
  [k: string]: unknown;
}

const MAX_EVENTS = 200;

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
  const [, setTick] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  // Seed with recent history on mount, then open the live stream.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/bridge/activity?last=100");
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
    const es = new EventSource("/api/bridge/stream");
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
    if (!q) return events;
    return events.filter((e) => {
      const hay =
        `${e.kind} ${e.tool ?? ""} ${e.toolName ?? ""} ${e.status ?? ""} ${e.decision ?? ""} ${e.reason ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [events, filter]);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <div className="page-head-sub">
            Live stream of tool calls and bridge events.
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
                const isApproval = e.kind === "approval_decision";
                const toolLabel = isApproval
                  ? (e.toolName ?? "—")
                  : (e.tool ?? "—");
                const specLabel =
                  isApproval && e.specifier ? ` (${e.specifier})` : "";
                return (
                  <tr key={`${e.at ?? i}-${i}`}>
                    <td
                      className="muted"
                      title={e.at ? new Date(e.at).toISOString() : ""}
                    >
                      {e.at ? relTime(e.at) : "—"}
                    </td>
                    <td>
                      <span
                        className={`pill ${isApproval ? (e.decision === "allow" ? "ok" : "err") : "muted"}`}
                      >
                        {e.kind}
                      </span>
                    </td>
                    <td className="mono">
                      {toolLabel}
                      {specLabel && <span className="muted">{specLabel}</span>}
                    </td>
                    <td className="mono muted">
                      {typeof e.durationMs === "number"
                        ? `${e.durationMs}ms`
                        : isApproval && e.reason
                          ? e.reason
                          : "—"}
                    </td>
                    <td>
                      {isApproval ? (
                        <span
                          className={`status-cell ${e.decision === "allow" ? "ok" : "err"}`}
                        >
                          <span className="pill-dot" />
                          {e.decision ?? "—"}
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
