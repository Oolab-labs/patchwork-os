"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiPath } from "@/lib/api";
import { fmtDuration } from "@/components/time";
import { SkeletonList } from "@/components/Skeleton";
import { EmptyState, ErrorState, RelationStrip } from "@/components/patchwork";
import { ActivityTabs } from "@/components/ActivityTabs";
import { useToast } from "@/components/Toast";
import { useSearchHotkey } from "@/hooks/useSearchHotkey";

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
  const toast = useToast();
  const [copied, setCopied] = useState<"id" | "term" | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(copyTimerRef.current); }, []);
  function flash(kind: "id" | "term") {
    setCopied(kind);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1500);
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
            fontWeight: 500,
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
              fontWeight: 500,
              marginBottom: 6,
            }}
          >
            Files referenced
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
        {/* Replay button removed 2026-05-17 (#600 BLOCKER #2): targeted
            POST /api/bridge/tasks/:id/replay which the bridge never
            implemented (only POST /runs/:seq/replay exists, for recipe
            runs). Every click 404'd with a confusing "Couldn't replay"
            toast. Restore once the bridge ships a tasks replay route. */}
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
            className="btn sm danger tasks-cancel-btn"
            style={{ fontSize: "var(--fs-s)", marginLeft: "auto" }}
            disabled={!!cancelling[task.taskId]}
            onClick={() => onCancel(task.taskId)}
            title="Cancel this running task"
          >
            {cancelling[task.taskId] ? (
              <>
                <span className="tasks-running-spinner" style={{ borderColor: "currentColor", borderTopColor: "transparent" }} />
                Cancelling…
              </>
            ) : "Cancel"}
          </button>
        )}
      </div>
    </div>
  );
}

// CSS for this page has been moved to globals.css (tasks/* namespace).

// ----------------------------------------------------------- page

async function cancelTask(id: string): Promise<void> {
  const res = await fetch(apiPath(`/api/bridge/tasks/${id}/cancel`), { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Server returned ${res.status}`);
  }
}

function fmtAvg(ms: number): string {
  if (!ms || !isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function TasksPage() {
  return (
    <Suspense fallback={null}>
      <TasksContent />
    </Suspense>
  );
}

function TasksContent() {
  const searchParams = useSearchParams();
  const idFromUrl = searchParams?.get("id") ?? "";
  const toast = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [err, setErr] = useState<string>();
  const [, setTick] = useState(0);
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(idFromUrl || null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "live" | "done" | "error">("all");
  // Cap rendered rows. /tasks is an audit log that can hit 500+ entries;
  // rendering the full list re-reconciles a lot of DOM on every poll
  // tick. 100 rows ≈ a phone-screenful × a few; "Show more" reveals the
  // rest in 200-row chunks. Filter/search resets the window.
  const ROW_PAGE = 100;
  const [visibleCount, setVisibleCount] = useState(ROW_PAGE);
  useEffect(() => {
    setVisibleCount(ROW_PAGE);
  }, [search, statusFilter]);
  const searchInputRef = useSearchHotkey();

  // Scroll the pre-selected row into view after initial load.
  const idScrolledRef = useRef(false);
  useEffect(() => {
    if (!idFromUrl || idScrolledRef.current || !hasLoaded) return;
    const row = document.querySelector<HTMLElement>(
      `[data-task-row="${CSS.escape(idFromUrl)}"]`,
    );
    if (row) {
      idScrolledRef.current = true;
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [idFromUrl, hasLoaded]);

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
    const onVisible = () => {
      if (document.hidden) {
        if (fastId !== null) { clearInterval(fastId); fastId = null; }
        if (slowId !== null) { clearInterval(slowId); slowId = null; }
      } else if (fastId === null && slowId === null) {
        void tick();
        fastId = setInterval(tick, 2000);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (fastId !== null) clearInterval(fastId);
      if (slowId !== null) clearInterval(slowId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Tick only when there's at least one running/pending task — relative
  // timestamps for terminal tasks ("3m ago") move at human scale, so we
  // don't need a 1Hz re-render of all 485 rows. Without this guard the
  // entire table re-rendered every second purely to refresh the live
  // duration counter on running rows (perf audit 2026-05-19).
  const hasLiveTask = useMemo(
    () => tasks.some((t) => t.status === "running" || t.status === "pending"),
    [tasks],
  );
  useEffect(() => {
    if (!hasLiveTask) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasLiveTask]);

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

  // j/k row navigation through filteredTasks — mirror /recipes, /runs.
  // j → next, k → prev, wraps. Skipped while typing in an input or
  // when no rows are visible. Sets `selectedTaskId` so the detail
  // panel reveals (same as clicking the row).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "j" && e.key !== "k") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      }
      // Scope j/k to the rendered window so we never select a hidden
      // row. If a press lands on the last visible row, reveal more.
      const visible = filteredTasks.slice(0, visibleCount);
      if (visible.length === 0) return;
      e.preventDefault();
      const idx = selectedTaskId
        ? visible.findIndex((task) => task.taskId === selectedTaskId)
        : -1;
      const delta = e.key === "j" ? 1 : -1;
      const wantsMore =
        e.key === "j" && idx === visible.length - 1 && filteredTasks.length > visibleCount;
      if (wantsMore) {
        setVisibleCount((n) => n + ROW_PAGE * 2);
        return;
      }
      const next =
        idx === -1
          ? e.key === "j"
            ? 0
            : visible.length - 1
          : (idx + delta + visible.length) % visible.length;
      const nextId = visible[next].taskId;
      setSelectedTaskId(nextId);
      requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>(
          `[data-task-row="${CSS.escape(nextId)}"]`,
        );
        row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        // Move real DOM focus, not just visual selection — otherwise
        // keyboard + screen-reader users get no feedback from j/k.
        row?.focus();
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filteredTasks, selectedTaskId]);

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
      toast.success("Task cancelled");
    } catch (e) {
      toast.error(
        `Couldn't cancel — ${e instanceof Error ? e.message : String(e)}`,
      );
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
          <RelationStrip
            items={[
              { label: "Sessions", href: "/sessions", title: "Clients that spawned these tasks" },
              { label: "Runs", href: "/runs", title: "Recipe runs that enqueued tasks" },
              { label: "Activity", href: "/activity", title: "Tool calls emitted by tasks" },
              { label: "Approvals", href: "/approvals", title: "Tasks waiting on a human nod" },
            ]}
          />
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
            ref={searchInputRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search id, session, driver, output… ( / )"
            className="input"
            style={{ flex: "1 1 min(280px, 100%)", maxWidth: 360, fontSize: "var(--fs-m)" }}
            aria-label="Filter tasks (shortcut: /)"
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
          <EmptyState
            title="No tasks yet"
            description={
              <>
                Tasks are background Claude runs triggered by recipes or automation.
                Enable a recipe with automation to see tasks appear here automatically,
                or run <code>patchwork start-task &quot;…&quot;</code> to start one manually.
              </>
            }
            action={
              <Link href="/recipes" className="btn sm">
                Browse recipes
              </Link>
            }
          />
        ) : (
          <SkeletonList rows={3} columns={3} />
        )
      ) : (
        // Tasks two-pane layout: 440 px left rail + flex right detail
        // on desktop, single column on mobile (the inline 440 px was
        // wider than a 390 px iPhone viewport, causing 148 px of
        // horizontal overflow on the whole `app-content`). The
        // `.tasks-layout` class collapses to one column at ≤768 px.
        <div className="tasks-layout" style={{ alignItems: "start" }}>
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
          {/* Tasks render as a button list (not a <table>); advertise the
              j/k row-navigation shortcut on the group container so screen
              readers announce it. Each task button already carries an
              aria-label. `role="group"` (not `list`) keeps the existing
              focusable <button> children valid as group members. */}
          <div
            role="group"
            aria-label="Tasks — press j or k to move between tasks"
            aria-keyshortcuts="j k"
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            {filteredTasks.length === 0 && (
              <div
                style={{
                  padding: "var(--s-4) var(--s-6, 24px)",
                  color: "var(--ink-3)",
                  fontSize: "var(--fs-m)",
                  textAlign: "center",
                  background: "var(--card-bg)",
                  borderRadius: "var(--radius)",
                  border: "1px dashed var(--line-2)",
                  margin: "8px 0",
                }}
              >
                {statusFilter === "live"
                  ? "No running or pending tasks right now."
                  : statusFilter === "done"
                    ? "No completed tasks match this search."
                    : statusFilter === "error"
                      ? "No failed tasks — great news."
                      : "No tasks match this filter."}
              </div>
            )}
            {filteredTasks.slice(0, visibleCount).map((t, taskRowIdx) => {
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
                    ? "var(--accent)"
                    : t.status === "cancelled" || t.status === "interrupted"
                      ? "var(--warn)"
                      : "var(--ok)";
              const borderColor =
                t.status === "error"
                  ? "var(--err)"
                  : t.status === "running" || t.status === "pending"
                    ? "var(--accent)"
                    : t.status === "done"
                      ? "var(--ok)"
                      : t.status === "cancelled" || t.status === "interrupted"
                        ? "var(--warn)"
                        : "var(--ink-3)";

              return (
                <button
                  key={t.taskId}
                  type="button"
                  data-task-row={t.taskId}
                  onClick={() => setSelectedTaskId(t.taskId)}
                  aria-pressed={isSelected}
                  aria-label={`Task ${t.taskId.slice(0, 8)}, ${t.status}${t.driver ? ` (${t.driver})` : ""}`}
                  className={`tasks-row-btn tasks-row-stagger${isLive ? " tasks-row-btn--running" : ""}`}
                  style={{
                    position: "relative",
                    textAlign: "left",
                    paddingLeft: 44,
                    paddingRight: 14,
                    paddingTop: 11,
                    paddingBottom: 11,
                    background: isSelected ? "var(--recess)" : "transparent",
                    border: "1px solid",
                    borderLeft: `3px solid ${borderColor}`,
                    borderColor: isSelected ? "var(--line-3)" : "transparent",
                    borderRadius: 8,
                    cursor: "pointer",
                    display: "block",
                    width: "100%",
                    animationDelay: `${Math.min(taskRowIdx * 25, 500)}ms`,
                  }}
                >
                  {/* Timeline dot */}
                  <span
                    aria-hidden="true"
                    className="tasks-timeline-dot"
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
                        className="tasks-progress-bar-track"
                        style={{
                          width: 32,
                          height: 3,
                          display: "inline-block",
                        }}
                      >
                        {isLive ? (
                          <span className="tasks-progress-bar-indeterminate" />
                        ) : (
                          <span
                            style={{
                              position: "absolute",
                              inset: 0,
                              width: `${intensity * 100}%`,
                              background: intensity > 0.7 ? "var(--orange, var(--accent))" : "var(--ok)",
                              borderRadius: 2,
                            }}
                          />
                        )}
                      </span>
                      <DriverBadge name={driver} />
                      <span className={`pill ${statusClass(t.status)}`} style={{ fontSize: "var(--fs-2xs)", display: "inline-flex", alignItems: "center", gap: 3 }}>
                        {isLive ? (
                          <span className="tasks-running-spinner" />
                        ) : (
                          <span className="pill-dot" />
                        )}
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
            {filteredTasks.length > visibleCount && (
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => setVisibleCount((n) => n + ROW_PAGE * 2)}
                style={{ marginTop: 8, alignSelf: "center", fontSize: "var(--fs-s)" }}
              >
                Show {Math.min(ROW_PAGE * 2, filteredTasks.length - visibleCount)} more
                <span style={{ marginLeft: 6, color: "var(--ink-3)" }}>
                  ({filteredTasks.length - visibleCount} hidden)
                </span>
              </button>
            )}
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
