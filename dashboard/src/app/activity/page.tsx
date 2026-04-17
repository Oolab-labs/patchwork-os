"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { relTime } from "@/components/time";

interface ActivityEvent {
  kind: string;
  tool?: string;
  status?: "success" | "error";
  durationMs?: number;
  at?: number;
  [k: string]: unknown;
}

const MAX_EVENTS = 200;

export default function ActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [err, setErr] = useState<string>();
  const [filter, setFilter] = useState("");
  const [, setTick] = useState(0);
  const esRef = useRef<EventSource | null>(null);

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
        const entry = JSON.parse(msg.data) as ActivityEvent;
        setEvents((prev) => [entry, ...prev].slice(0, MAX_EVENTS));
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
      const hay = `${e.kind} ${e.tool ?? ""} ${e.status ?? ""}`.toLowerCase();
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
          <h3>Waiting for events…</h3>
          <p>Tool calls will appear here as they happen.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 140 }}>Time</th>
                <th style={{ width: 110 }}>Kind</th>
                <th>Tool</th>
                <th style={{ width: 110 }}>Duration</th>
                <th style={{ width: 110 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => (
                <tr key={`${e.at ?? i}-${i}`}>
                  <td className="muted" title={e.at ? new Date(e.at).toISOString() : ""}>
                    {e.at ? relTime(e.at) : "—"}
                  </td>
                  <td>
                    <span className="pill muted">{e.kind}</span>
                  </td>
                  <td className="mono">{e.tool ?? "—"}</td>
                  <td className="mono muted">
                    {typeof e.durationMs === "number" ? `${e.durationMs}ms` : "—"}
                  </td>
                  <td>
                    {e.status ? (
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
