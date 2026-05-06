"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { fmtDuration } from "@/components/time";
import { SkeletonList } from "@/components/Skeleton";
import { ErrorState } from "@/components/patchwork";
import { ActivityTabs } from "@/components/ActivityTabs";

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
  driver?: string;
  model?: string;
  filesReferenced?: string[];
}

// ----------------------------------------------------------- driver badge

const DRIVER_COLORS: Record<string, { bg: string; fg: string }> = {
  claude: { bg: "rgba(217,119,87,0.14)", fg: "#c0562e" },
  gemini: { bg: "rgba(66,133,244,0.14)", fg: "#2f6fe0" },
  openai: { bg: "rgba(16,163,127,0.14)", fg: "#0d8a5e" },
  grok: { bg: "rgba(120,120,120,0.14)", fg: "#555" },
};

function driverFromTask(t: Task): string {
  if (t.driver) return t.driver.toLowerCase();
  const m = (t.model ?? "").toLowerCase();
  if (m.includes("claude")) return "claude";
  if (m.includes("gemini")) return "gemini";
  if (m.includes("gpt") || m.includes("openai")) return "openai";
  if (m.includes("grok")) return "grok";
  return "claude";
}

function DriverBadge({ name }: { name: string }) {
  const c = DRIVER_COLORS[name] ?? { bg: "var(--recess)", fg: "var(--ink-2)" };
  return (
    <span
      className="pill"
      style={{
        fontSize: "var(--fs-2xs)",
        background: c.bg,
        color: c.fg,
        border: "none",
        textTransform: "capitalize",
        fontWeight: 600,
      }}
    >
      {name}
    </span>
  );
}

// ----------------------------------------------------------- file extraction

function extractFiles(text: string | undefined): string[] {
  if (!text) return [];
  const re = /[\w\-./]+\.(?:tsx?|jsx?|json|md|ya?ml|css|html|py|rs|go|sh)\b/g;
  const found = new Set<string>();
  for (const m of text.match(re) ?? []) {
    const base = m.split("/").pop() ?? m;
    if (base.length <= 40) found.add(base);
    if (found.size >= 6) break;
  }
  return Array.from(found);
}

// ----------------------------------------------------------- detail pane

function TaskDetail({ task, onCancel, cancelling }: {
  task: Task;
  onCancel: (id: string) => void;
  cancelling: Record<string, boolean>;
}) {
  const [copied, setCopied] = useState<"id" | "term" | "replay" | null>(null);
  function flash(kind: "id" | "term" | "replay") {
    setCopied(kind);
    setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1500);
  }
  const isLive = task.status === "running" || task.status === "pending";
  const errText = task.errorMessage ?? task.stderrTail;
  const dur =
    task.startedAt && task.doneAt
      ? fmtDuration(task.doneAt - task.startedAt)
      : task.startedAt
        ? fmtDuration(Date.now() - task.startedAt)
        : "—";
  const model = task.model ?? driverFromTask(task);
  const files = task.filesReferenced ?? extractFiles(task.output ?? errText);

  return (
    <div className="card" style={{ padding: "var(--s-4)" }}>
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 14,
          paddingBottom: 12,
          borderBottom: "1px solid var(--line-3)",
          flexWrap: "wrap",
        }}
      >
        <span className={`pill ${statusClass(task.status)}`} style={{ fontSize: "var(--fs-xs)" }}>
          <span className="pill-dot" />
          {task.status}
        </span>
        <span className="mono" style={{ fontSize: "var(--fs-s)", color: "var(--ink-1)" }}>
          {task.taskId.slice(0, 8)}
        </span>
        <span style={{ fontSize: "var(--fs-s)", color: "var(--ink-2)", marginLeft: "auto" }}>
          <span className="mono">{dur}</span>
          <span style={{ margin: "0 6px", color: "var(--ink-3)" }}>·</span>
          <span className="mono">{model}</span>
        </span>
      </div>

      {/* OUTPUT */}
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            fontSize: "var(--fs-2xs)",
            color: "var(--ink-2)",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            marginBottom: 6,
          }}
        >
          Output
        </div>
        {errText && (
          <pre
            className="task-output"
            style={{ color: "var(--err)", maxHeight: 120, marginBottom: 8 }}
          >
            {errText}
          </pre>
        )}
        {task.output ? (
          <pre
            className="task-output"
            aria-live={task.status === "running" ? "polite" : undefined}
            aria-atomic="false"
            aria-label={`Task ${task.taskId.slice(0, 8)} output`}
            style={{ maxHeight: "calc(100vh - 460px)" }}
          >
            {task.output.slice(0, 8000)}
          </pre>
        ) : (
          !errText && (
            <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-s)", padding: "8px 0" }}>
              No output yet.
            </div>
          )
        )}
      </div>

      {/* FILES REFERENCED */}
      {files.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: "var(--fs-2xs)",
              color: "var(--ink-2)",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              marginBottom: 6,
            }}
          >
            Files Referenced
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {files.map((f) => (
              <span
                key={f}
                className="pill muted mono"
                style={{ fontSize: "var(--fs-xs)" }}
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* bottom buttons */}
      <div
        style={{
          display: "flex",
          gap: 8,
          paddingTop: 12,
          borderTop: "1px solid var(--line-3)",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="btn sm ghost"
          style={{ fontSize: "var(--fs-s)" }}
          onClick={async () => {
            await navigator.clipboard.writeText(`patchwork task resume ${task.taskId}`);
            flash("term");
          }}
        >
          {copied === "term" ? "✓ Copied" : "> Open in terminal"}
        </button>
        <button
          type="button"
          className="btn sm ghost"
          style={{ fontSize: "var(--fs-s)" }}
          onClick={async () => {
            try {
              const res = await fetch(
                apiPath(`/api/bridge/tasks/${task.taskId}/replay`),
                { method: "POST" },
              );
              if (res.ok) flash("replay");
            } catch {
              /* swallow — surfaced via next poll */
            }
          }}
        >
          {copied === "replay" ? "✓ Queued" : "↻ Replay"}
        </button>
        <button
          type="button"
          className="btn sm ghost"
          aria-label="Copy task ID"
          style={{ fontSize: "var(--fs-s)" }}
          onClick={async () => {
            await navigator.clipboard.writeText(task.taskId);
            flash("id");
          }}
        >
          {copied === "id" ? "✓ Copied" : (
            <>
              <span aria-hidden="true">📋 </span>Copy id
            </>
          )}
        </button>
        {isLive && (
          <button
            type="button"
            className="btn sm ghost"
            style={{ fontSize: "var(--fs-s)", color: "var(--red)", marginLeft: "auto" }}
            disabled={!!cancelling[task.taskId]}
            onClick={() => onCancel(task.taskId)}
          >
            {cancelling[task.taskId] ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------- page

async function cancelTask(id: string): Promise<void> {
  await fetch(apiPath(`/api/bridge/tasks/${id}/cancel`), { method: "POST" });
}

function fmtAvg(ms: number): string {
  if (!ms || !isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [err, setErr] = useState<string>();
  const [, setTick] = useState(0);
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "live" | "done" | "error">("all");

  const refetchRef = useRef<() => void>(() => {});

  useEffect(() => {
    let fastId: ReturnType<typeof setInterval> | null = null;
    let slowId: ReturnType<typeof setInterval> | null = null;

    const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

    const tick = async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/tasks"));
        if (!res.ok) throw new Error(`/tasks ${res.status}`);
        const data = (await res.json()) as { tasks: Task[] };
        const fetched = data.tasks ?? [];
        setTasks(fetched);
        setHasLoaded(true);
        setErr(undefined);
        const allTerminal = fetched.length > 0 && fetched.every((t) => TERMINAL.has(t.status));
        if (allTerminal && fastId !== null) {
          clearInterval(fastId);
          fastId = null;
          slowId = setInterval(tick, 10_000);
        } else if (!allTerminal && slowId !== null) {
          clearInterval(slowId);
          slowId = null;
          fastId = setInterval(tick, 2000);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    refetchRef.current = () => void tick();
    tick();
    fastId = setInterval(tick, 2000);
    return () => {
      if (fastId !== null) clearInterval(fastId);
      if (slowId !== null) clearInterval(slowId);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // live-computed subtitle stats
  const { avgMs, driverLabel } = useMemo(() => {
    let total = 0;
    let n = 0;
    const drivers = new Map<string, number>();
    for (const t of tasks) {
      if (t.startedAt && t.doneAt) {
        total += t.doneAt - t.startedAt;
        n++;
      }
      const key = t.model ?? driverFromTask(t);
      drivers.set(key, (drivers.get(key) ?? 0) + 1);
    }
    let topDriver = "claude-3.5-sonnet";
    let topN = -1;
    for (const [k, v] of drivers) {
      if (v > topN) {
        topN = v;
        topDriver = k;
      }
    }
    return {
      avgMs: n > 0 ? total / n : 0,
      driverLabel: topDriver,
    };
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter((t) => {
      if (statusFilter === "live" && t.status !== "running" && t.status !== "pending") return false;
      if (statusFilter === "done" && t.status !== "done") return false;
      if (statusFilter === "error" && t.status !== "error" && t.status !== "interrupted" && t.status !== "cancelled") return false;
      if (!q) return true;
      const hay = [t.taskId, t.sessionId, t.driver, t.model, t.output, t.errorMessage, t.stderrTail]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [tasks, search, statusFilter]);

  const statusCounts = useMemo(() => {
    const c = { all: tasks.length, live: 0, done: 0, error: 0 };
    for (const t of tasks) {
      if (t.status === "running" || t.status === "pending") c.live++;
      else if (t.status === "done") c.done++;
      else c.error++;
    }
    return c;
  }, [tasks]);

  // Derive from the unfiltered list so applying a status filter that hides
  // the selected task doesn't blank the detail pane silently.
  const selectedTask = tasks.find((t) => t.taskId === selectedTaskId) ?? null;

  async function handleCancel(id: string) {
    setCancelling((p) => ({ ...p, [id]: true }));
    try {
      await cancelTask(id);
    } finally {
      setCancelling((p) => ({ ...p, [id]: false }));
    }
  }

  return (
    <section>
      <ActivityTabs />
      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Tasks — <span className="accent">Claude subprocess invocations.</span>
          </h1>
          <div className="editorial-sub">
            {tasks.length} task{tasks.length !== 1 ? "s" : ""} · avg {fmtAvg(avgMs)} · driver: {driverLabel}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => refetchRef.current()}
          >
            Sync
          </button>
          <span className="pill muted">{tasks.length} total</span>
        </div>
      </div>

      {err && tasks.length === 0 && (
        <ErrorState
          title="Couldn't load tasks"
          description="The bridge isn't responding. The next poll will try again automatically."
          error={err}
          onRetry={() => refetchRef.current()}
        />
      )}
      {err && tasks.length > 0 && (
        <div className="alert-err">Refresh failed — {err}</div>
      )}

      {tasks.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: "var(--s-3)",
          }}
        >
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search id, session, driver, output…"
            className="input"
            style={{ flex: "1 1 280px", maxWidth: 360, fontSize: "var(--fs-m)" }}
            aria-label="Filter tasks"
          />
          <div style={{ display: "flex", gap: 4 }} role="group" aria-label="Status filter">
            {([
              ["all", "All", statusCounts.all],
              ["live", "Live", statusCounts.live],
              ["done", "Done", statusCounts.done],
              ["error", "Failed", statusCounts.error],
            ] as const).map(([k, label, n]) => (
              <button
                key={k}
                type="button"
                aria-pressed={statusFilter === k}
                onClick={() => setStatusFilter(k)}
                className={`btn sm ${statusFilter === k ? "primary" : "ghost"}`}
                style={{ fontSize: "var(--fs-s)" }}
              >
                {label} <span style={{ opacity: 0.7, marginLeft: 4 }}>{n}</span>
              </button>
            ))}
          </div>
          {(search || statusFilter !== "all") && (
            <span style={{ fontSize: "var(--fs-s)", color: "var(--ink-3)" }}>
              {filteredTasks.length} of {tasks.length}
            </span>
          )}
        </div>
      )}

      {tasks.length === 0 && !err ? (
        hasLoaded ? (
          <div className="empty-state">
            <h3>No tasks yet</h3>
            <p>
              Run one with <code>runClaudeTask</code> or{" "}
              <code>patchwork start-task "…"</code>.
            </p>
          </div>
        ) : (
          <SkeletonList rows={3} columns={3} />
        )
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "440px minmax(0,1fr)",
            gap: "var(--s-4)",
            alignItems: "start",
          }}
        >
          {/* left: timeline rail + task list */}
          <div style={{ position: "relative" }}>
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 22,
                top: 8,
                bottom: 8,
                width: 1,
                background:
                  "linear-gradient(to bottom, transparent, var(--line-3) 8%, var(--line-3) 92%, transparent)",
                pointerEvents: "none",
              }}
            />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {filteredTasks.length === 0 && (
              <div style={{ padding: "var(--s-4)", color: "var(--ink-3)", fontSize: "var(--fs-m)" }}>
                No tasks match this filter.
              </div>
            )}
            {filteredTasks.map((t) => {
              const dur =
                t.startedAt && t.doneAt
                  ? fmtDuration(t.doneAt - t.startedAt)
                  : t.startedAt
                    ? fmtDuration(Date.now() - t.startedAt)
                    : "—";
              const isLive = t.status === "running" || t.status === "pending";
              const isSelected = selectedTaskId === t.taskId;
              const firstOutputLine = (t.output ?? "").split("\n")[0]?.slice(0, 80) ?? "";
              const driver = driverFromTask(t);

              const durSec =
                t.startedAt && t.doneAt
                  ? (t.doneAt - t.startedAt) / 1000
                  : 0;
              const intensity = Math.min(1, durSec / 35);
              const dotColor =
                t.status === "error"
                  ? "var(--err)"
                  : t.status === "running" || t.status === "pending"
                    ? "var(--blue)"
                    : "var(--ok)";
              return (
                <button
                  key={t.taskId}
                  type="button"
                  onClick={() => setSelectedTaskId(t.taskId)}
                  aria-pressed={isSelected}
                  aria-label={`Task ${t.taskId.slice(0, 8)}, ${t.status}${t.driver ? ` (${t.driver})` : ""}`}
                  style={{
                    position: "relative",
                    textAlign: "left",
                    paddingLeft: 44,
                    paddingRight: 14,
                    paddingTop: 11,
                    paddingBottom: 11,
                    background: isSelected ? "var(--recess)" : "transparent",
                    border: "1px solid",
                    borderColor: isSelected ? "var(--line-3)" : "transparent",
                    borderRadius: 8,
                    cursor: "pointer",
                    display: "block",
                    width: "100%",
                    transition: "background 0.15s, border-color 0.15s",
                  }}
                >
                  {/* Timeline dot */}
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      left: 16,
                      top: 16,
                      width: 13,
                      height: 13,
                      borderRadius: "50%",
                      background: "var(--bg-1)",
                      border: `2px solid ${dotColor}`,
                      boxShadow: isSelected
                        ? `0 0 0 4px color-mix(in oklch, ${dotColor} 25%, transparent)`
                        : "none",
                      transition: "box-shadow 0.2s",
                    }}
                  />
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                    <span className="mono" style={{ fontSize: "var(--fs-xs)", color: "var(--ink-2)", fontWeight: 500 }}>
                      {t.taskId.slice(0, 8)}
                    </span>
                    <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                      {/* Duration intensity bar */}
                      <span
                        style={{
                          width: 32,
                          height: 3,
                          background: "var(--line-3)",
                          borderRadius: 1,
                          position: "relative",
                          overflow: "hidden",
                          display: "inline-block",
                        }}
                      >
                        <span
                          style={{
                            position: "absolute",
                            inset: 0,
                            width: `${intensity * 100}%`,
                            background: intensity > 0.7 ? "var(--orange, var(--accent))" : "var(--ok)",
                          }}
                        />
                      </span>
                      <DriverBadge name={driver} />
                      <span className={`pill ${statusClass(t.status)}`} style={{ fontSize: "var(--fs-2xs)" }}>
                        <span className="pill-dot" />
                        {t.status}
                      </span>
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: "var(--fs-s)",
                      color: isSelected ? "var(--ink-1)" : "var(--ink-2)",
                      lineHeight: 1.5,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {firstOutputLine || <span style={{ color: "var(--ink-3)" }}>(running…)</span>}
                  </div>
                  <div style={{ fontSize: "var(--fs-xs)", color: isLive ? "var(--blue)" : "var(--ink-3)", fontFamily: "var(--font-mono)", marginTop: 4 }}>
                    {dur}
                  </div>
                </button>
              );
            })}
          </div>
          </div>

          {/* right: detail pane */}
          <div style={{ position: "sticky", top: 80 }}>
            {selectedTask ? (
              <TaskDetail
                task={selectedTask}
                onCancel={(id) => void handleCancel(id)}
                cancelling={cancelling}
              />
            ) : (
              <div
                style={{
                  color: "var(--ink-3)",
                  fontSize: "var(--fs-m)",
                  padding: 24,
                  textAlign: "center",
                }}
              >
                Select a task to see its output.
              </div>
            )}
          </div>
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
    case "pending":
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
