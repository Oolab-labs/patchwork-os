"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import { apiPath } from "@/lib/api";
import { fmtDuration } from "@/components/time";
import { useBridgeStatus } from "@/hooks/useBridgeStatus";

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
}

type StatusFilter = "all" | "running" | "done" | "error" | "cancelled";

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
        fontSize: 10,
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

// ----------------------------------------------------------- copy button

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn sm ghost"
      style={{ minHeight: 24, fontSize: 11, padding: "3px 9px" }}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* ignore */
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// ----------------------------------------------------------- hero strip

function HeroStrip({ tasks }: { tasks: Task[] }) {
  const counts = useMemo(() => {
    const c = { running: 0, done: 0, error: 0, cancelled: 0 } as Record<
      string,
      number
    >;
    for (const t of tasks) {
      if (t.status === "running" || t.status === "pending") c.running++;
      else if (t.status === "done") c.done++;
      else if (t.status === "error") c.error++;
      else c.cancelled++;
    }
    return c;
  }, [tasks]);

  const items = [
    { label: "Running", n: counts.running, color: "var(--blue)" },
    { label: "Done", n: counts.done, color: "var(--green)" },
    { label: "Errored", n: counts.error, color: "var(--red)" },
    { label: "Cancelled", n: counts.cancelled, color: "var(--ink-3)" },
  ];

  return (
    <div
      className="card"
      style={{
        padding: "18px 22px",
        marginBottom: "var(--s-5)",
        display: "flex",
        alignItems: "center",
        gap: "var(--s-5)",
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1, minWidth: 180 }}>
        <div
          style={{
            fontSize: 10,
            color: "var(--ink-2)",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            marginBottom: 4,
          }}
        >
          Execution
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ink-0)" }}>
          {tasks.length} task{tasks.length !== 1 ? "s" : ""} in log
        </div>
      </div>
      {items.map((it, i) => (
        <Fragment key={it.label}>
          {i > 0 && (
            <div
              aria-hidden
              style={{ width: 1, height: 32, background: "var(--line-2)" }}
            />
          )}
          <div style={{ textAlign: "center", minWidth: 72 }}>
            <div
              style={{
                fontSize: 22,
                fontWeight: 800,
                fontFamily: "var(--font-mono)",
                color: it.n > 0 ? it.color : "var(--ink-3)",
                lineHeight: 1,
              }}
            >
              {it.n}
            </div>
            <div
              style={{
                fontSize: 10,
                color: "var(--ink-2)",
                marginTop: 4,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              {it.label}
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

// ----------------------------------------------------------- quick-task launcher

interface QuickTaskPreset {
  id: string;
  label: string;
  desc: string;
}

const QUICK_TASK_PRESETS: QuickTaskPreset[] = [
  { id: "fixErrors", label: "Fix all errors", desc: "Inspect diagnostics and fix every error" },
  { id: "refactorFile", label: "Refactor active file", desc: "Refactor the active editor file for clarity" },
  { id: "addTests", label: "Add tests", desc: "Write unit tests for the active file" },
  { id: "explainCode", label: "Explain code", desc: "Explain the active file or last commit" },
  { id: "optimizePerf", label: "Optimize performance", desc: "Find + fix the biggest perf hotspot" },
  { id: "runTests", label: "Run test suite", desc: "Run the full project test suite" },
  { id: "resumeLastCancelled", label: "Resume cancelled", desc: "Resume the last cancelled task" },
];

function QuickTaskLauncher({ onLaunched }: { onLaunched: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  const status = useBridgeStatus();
  const driver = status.patchwork?.driver;
  // While status is still loading (driver undefined) we optimistically allow
  // the panel; the server will reject with a clear error if the driver isn't
  // subprocess. Once we know the driver, gate strictly.
  const driverReady = driver === undefined || driver === "subprocess";

  async function launch(preset: QuickTaskPreset) {
    setBusy(preset.id);
    setMsg(null);
    try {
      const res = await fetch(apiPath("/api/bridge/launch-quick-task"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId: preset.id, source: "dashboard" }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        taskId?: string;
        error?: string;
      };
      if (res.ok && body.ok) {
        setMsg({
          ok: true,
          text: body.taskId
            ? `Launched ${preset.label} → task ${body.taskId.slice(0, 8)}`
            : `Launched ${preset.label}`,
        });
        onLaunched();
      } else {
        setMsg({ ok: false, text: body.error ?? `Error ${res.status}` });
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" style={{ padding: "12px 16px", marginBottom: "var(--s-5)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)" }}>
            Quick-task launcher
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2 }}>
            {driverReady
              ? "Fire a context-aware Claude task using a preset."
              : (
                <>
                  Unavailable — bridge driver is{" "}
                  <code>{driver ?? "none"}</code>. Restart with{" "}
                  <code>--driver subprocess</code> to enable.
                </>
              )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!driverReady}
          aria-expanded={open}
          style={{
            fontSize: 12,
            padding: "6px 12px",
            background: open ? "var(--bg-3)" : "var(--bg-2)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--r-2)",
            cursor: driverReady ? "pointer" : "not-allowed",
            opacity: driverReady ? 1 : 0.6,
            color: "var(--fg-0)",
            whiteSpace: "nowrap",
          }}
        >
          {open ? "Hide presets" : "Show presets"}
        </button>
      </div>
      {open && driverReady && (
      <div
        style={{
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: 8,
        }}
      >
        {QUICK_TASK_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={busy !== null}
            onClick={() => void launch(p)}
            title={p.desc}
            style={{
              textAlign: "left",
              padding: "8px 10px",
              background: "var(--bg-2)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--r-2)",
              cursor: busy !== null ? "not-allowed" : "pointer",
              opacity: busy === p.id ? 0.6 : 1,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>
              {busy === p.id ? "Launching…" : p.label}
            </span>
            <span style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.3 }}>
              {p.desc}
            </span>
          </button>
        ))}
      </div>
      )}
      {msg && open && (
        <p style={{ fontSize: 12, marginTop: 8, color: msg.ok ? "var(--ok)" : "var(--err)" }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------- page

async function cancelTask(id: string): Promise<void> {
  await fetch(apiPath(`/api/bridge/tasks/${id}/cancel`), { method: "POST" });
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [err, setErr] = useState<string>();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [, setTick] = useState(0);
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});

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
        setErr(undefined);
        // All terminal → slow down
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

  const filtered = useMemo(() => {
    if (filter === "all") return tasks;
    if (filter === "running")
      return tasks.filter(
        (t) => t.status === "running" || t.status === "pending",
      );
    if (filter === "cancelled")
      return tasks.filter(
        (t) => t.status === "cancelled" || t.status === "interrupted",
      );
    return tasks.filter((t) => t.status === filter);
  }, [tasks, filter]);

  const chips: { k: StatusFilter; label: string }[] = [
    { k: "all", label: "All" },
    { k: "running", label: "Running" },
    { k: "done", label: "Done" },
    { k: "error", label: "Errored" },
    { k: "cancelled", label: "Cancelled" },
  ];

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

      <HeroStrip tasks={tasks} />

      <QuickTaskLauncher onLaunched={() => setTick((t) => t + 1)} />

      {/* filter chips */}
      <div className="filter-chips" style={{ marginBottom: "var(--s-4)" }}>
        {chips.map((c) => (
          <button
            type="button"
            key={c.k}
            onClick={() => setFilter(c.k)}
            className={`filter-chip${filter === c.k ? " active" : ""}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {err && <div className="alert-err">Unreachable: {err}</div>}

      {filtered.length === 0 && !err ? (
        <div className="empty-state">
          <h3>{tasks.length === 0 ? "No tasks yet" : "No matching tasks"}</h3>
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
                <th style={{ width: 80 }}>Driver</th>
                <th style={{ width: 100 }}>Duration</th>
                <th>Output preview</th>
                <th style={{ width: 40 }} aria-label="expand" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const dur =
                  t.startedAt && t.doneAt
                    ? fmtDuration(t.doneAt - t.startedAt)
                    : t.startedAt
                      ? fmtDuration(Date.now() - t.startedAt)
                      : "—";
                const isLive =
                  t.status === "running" || t.status === "pending";
                const open = !!expanded[t.taskId];
                const errText = t.errorMessage ?? t.stderrTail;
                const hasDetail = !!(t.output || errText);
                const preview = (t.output ?? errText ?? "")
                  .split("\n")[0]
                  .slice(0, 140);
                const driver = driverFromTask(t);
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
                      <td>
                        <DriverBadge name={driver} />
                      </td>
                      <td
                        className="mono"
                        style={{
                          color: isLive ? "var(--blue)" : "var(--ink-3)",
                          fontWeight: isLive ? 600 : 400,
                        }}
                      >
                        {dur}
                      </td>
                      <td
                        style={{
                          maxWidth: 520,
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
                        <td colSpan={6} style={{ padding: 0 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "8px 14px",
                              borderBottom: "1px solid var(--line-3)",
                            }}
                          >
                            <span
                              style={{
                                fontSize: 11,
                                color: "var(--ink-2)",
                                fontWeight: 600,
                                textTransform: "uppercase",
                                letterSpacing: "0.07em",
                              }}
                            >
                              {errText ? "Error + output" : "Output"}
                            </span>
                            <div style={{ display: "flex", gap: 6 }}>
                              {isLive && (
                                <button
                                  type="button"
                                  className="btn sm ghost"
                                  style={{ minHeight: 24, fontSize: 11, padding: "3px 9px", color: "var(--red)" }}
                                  disabled={!!cancelling[t.taskId]}
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    setCancelling((p) => ({ ...p, [t.taskId]: true }));
                                    try {
                                      await cancelTask(t.taskId);
                                    } finally {
                                      setCancelling((p) => ({ ...p, [t.taskId]: false }));
                                    }
                                  }}
                                >
                                  {cancelling[t.taskId] ? "Cancelling…" : "Cancel"}
                                </button>
                              )}
                              <CopyBtn text={(errText ?? "") + (t.output ?? "")} />
                            </div>
                          </div>
                          {errText && (
                            <pre
                              className="task-output"
                              style={{ color: "var(--red)" }}
                            >
                              {errText}
                            </pre>
                          )}
                          {t.output && (
                            <pre className="task-output">
                              {t.output.length > 4000
                                ? `[Output truncated — showing last 4000 chars]\n\n${t.output.slice(-4000)}`
                                : t.output}
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
