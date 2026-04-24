"use client";
import { Fragment, useEffect, useState } from "react";
import { apiPath } from "@/lib/api";
import { fmtDuration } from "@/components/time";

interface Task {
  taskId: string;
  sessionId?: string;
  status:
    | "pending"
    | "running"
    | "done"
    | "error"
    | "cancelled"
    | "interrupted";
  createdAt?: number;
  startedAt?: number;
  doneAt?: number;
  output?: string;
  errorMessage?: string;
  stderrTail?: string;
  startupMs?: number;
  timeoutMs?: number;
  cancelReason?: string;
  wasAborted?: boolean;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [err, setErr] = useState<string>();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [, setTick] = useState(0);

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/tasks"));
        if (!res.ok) throw new Error(`/tasks ${res.status}`);
        const data = (await res.json()) as { tasks: Task[] };
        setTasks(data.tasks ?? []);
        setErr(undefined);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Claude tasks</h1>
          <div className="page-head-sub">
            Claude subprocess tasks running in the background.
          </div>
        </div>
        <span className="pill muted">{tasks.length} total</span>
      </div>

      {err && <div className="alert-err">Unreachable: {err}</div>}

      {tasks.length === 0 && !err ? (
        <div className="empty-state">
          <h3>No tasks yet</h3>
          <p>
            Run one with <code>runClaudeTask</code> or{" "}
            <code>patchwork start-task "…"</code>.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 100 }}>ID</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 100 }}>Duration</th>
                <th>Output preview</th>
                <th style={{ width: 40 }} aria-label="expand" />
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const dur =
                  t.startedAt && t.doneAt
                    ? fmtDuration(t.doneAt - t.startedAt)
                    : t.startedAt
                      ? fmtDuration(Date.now() - t.startedAt)
                      : "—";
                const open = !!expanded[t.taskId];
                const errText = t.errorMessage ?? t.stderrTail;
                const hasDetail = !!(t.output || errText);
                const preview = (t.output ?? errText ?? "")
                  .split("\n")[0]
                  .slice(0, 140);
                return (
                  <Fragment key={t.taskId}>
                    <tr
                      onClick={() =>
                        hasDetail &&
                        setExpanded((p) => ({
                          ...p,
                          [t.taskId]: !p[t.taskId],
                        }))
                      }
                      style={{ cursor: hasDetail ? "pointer" : "default" }}
                    >
                      <td className="mono">{t.taskId.slice(0, 8)}</td>
                      <td>
                        <span className={`pill ${statusClass(t.status)}`}>
                          <span className="pill-dot" />
                          {t.status}
                        </span>
                      </td>
                      <td className="mono muted">{dur}</td>
                      <td
                        style={{
                          maxWidth: 560,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {preview || <span className="muted">—</span>}
                      </td>
                      <td className="muted">
                        {hasDetail ? (open ? "▾" : "▸") : ""}
                      </td>
                    </tr>
                    {open && hasDetail && (
                      <tr className="task-row-expand">
                        <td colSpan={5} style={{ padding: 0 }}>
                          {errText && (
                            <pre
                              className="task-output"
                              style={{ color: "var(--err)" }}
                            >
                              {errText}
                            </pre>
                          )}
                          {t.output && (
                            <pre className="task-output">
                              {t.output.slice(-4000)}
                            </pre>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function statusClass(s: Task["status"]): string {
  switch (s) {
    case "done":
      return "ok";
    case "running":
      return "info";
    case "error":
      return "err";
    case "cancelled":
    case "interrupted":
      return "warn";
    default:
      return "muted";
  }
}
