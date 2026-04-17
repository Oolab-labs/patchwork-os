"use client";
import { useEffect, useState } from "react";

interface Run {
  seq: number;
  taskId: string;
  recipeName: string;
  trigger: "cron" | "webhook" | "recipe";
  status: "done" | "error" | "cancelled" | "interrupted";
  createdAt: number;
  startedAt?: number;
  doneAt: number;
  durationMs: number;
  model?: string;
  outputTail?: string;
  errorMessage?: string;
}

type TriggerFilter = "all" | "cron" | "webhook" | "recipe";
type StatusFilter = "all" | "done" | "error" | "cancelled" | "interrupted";

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleString();
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [err, setErr] = useState<string>();
  const [trigger, setTrigger] = useState<TriggerFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const params = new URLSearchParams({ limit: "100" });
        if (trigger !== "all") params.set("trigger", trigger);
        if (status !== "all") params.set("status", status);
        const res = await fetch(`/api/bridge/runs?${params}`);
        if (!res.ok) throw new Error(`/runs ${res.status}`);
        const data = (await res.json()) as { runs?: Run[] };
        setRuns(data.runs ?? []);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [trigger, status]);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <div className="page-head-sub">
            Audit trail of every recipe execution — cron, webhook, and manual.
          </div>
        </div>
        {runs && <span className="pill muted">{runs.length} shown</span>}
      </div>

      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 16,
          alignItems: "center",
        }}
      >
        <label style={{ fontSize: 12 }}>
          Trigger:&nbsp;
          <select
            value={trigger}
            onChange={(e) => setTrigger(e.target.value as TriggerFilter)}
          >
            <option value="all">all</option>
            <option value="cron">cron</option>
            <option value="webhook">webhook</option>
            <option value="recipe">recipe (manual)</option>
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Status:&nbsp;
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="all">all</option>
            <option value="done">done</option>
            <option value="error">error</option>
            <option value="cancelled">cancelled</option>
            <option value="interrupted">interrupted</option>
          </select>
        </label>
      </div>

      {err && <div className="alert-err">Unreachable: {err}</div>}

      {runs === null && !err ? (
        <div className="empty-state">
          <p>Loading…</p>
        </div>
      ) : !runs || runs.length === 0 ? (
        <div className="empty-state">
          <h3>No runs yet</h3>
          <p>
            Recipe executions (cron, webhook, or{" "}
            <code>patchwork recipe run</code>) will appear here once they
            complete.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 140 }}>When</th>
                <th>Recipe</th>
                <th style={{ width: 90 }}>Trigger</th>
                <th style={{ width: 90 }}>Status</th>
                <th style={{ width: 80 }}>Duration</th>
                <th style={{ width: 80 }}>Task</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const isExpanded = expanded === r.taskId;
                const key = r.taskId;
                return (
                  <>
                    <tr
                      key={key}
                      onClick={() => setExpanded(isExpanded ? null : r.taskId)}
                      style={{ cursor: "pointer" }}
                    >
                      <td className="mono muted">{fmtWhen(r.doneAt)}</td>
                      <td className="mono">{r.recipeName}</td>
                      <td>
                        <span className="pill muted">{r.trigger}</span>
                      </td>
                      <td>
                        <span
                          className={`status-cell ${r.status === "done" ? "ok" : "err"}`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="mono muted">{fmtDur(r.durationMs)}</td>
                      <td className="mono muted">{r.taskId.slice(0, 8)}</td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${key}-detail`}>
                        <td
                          colSpan={6}
                          style={{ background: "rgba(0,0,0,0.02)" }}
                        >
                          <div style={{ padding: 12, fontSize: 12 }}>
                            {r.model && (
                              <div>
                                <strong>Model:</strong>{" "}
                                <span className="mono">{r.model}</span>
                              </div>
                            )}
                            <div>
                              <strong>Created:</strong>{" "}
                              <span className="mono">
                                {new Date(r.createdAt).toISOString()}
                              </span>
                            </div>
                            {r.errorMessage && (
                              <div style={{ marginTop: 8 }}>
                                <strong>Error:</strong>
                                <pre
                                  style={{
                                    whiteSpace: "pre-wrap",
                                    margin: "4px 0 0",
                                  }}
                                >
                                  {r.errorMessage}
                                </pre>
                              </div>
                            )}
                            {r.outputTail && (
                              <div style={{ marginTop: 8 }}>
                                <strong>Output (tail):</strong>
                                <pre
                                  style={{
                                    whiteSpace: "pre-wrap",
                                    margin: "4px 0 0",
                                    maxHeight: 240,
                                    overflow: "auto",
                                  }}
                                >
                                  {r.outputTail}
                                </pre>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
