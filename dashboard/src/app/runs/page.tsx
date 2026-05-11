"use client";
import React from "react";
import { apiPath } from "@/lib/api";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { LivePill } from "@/components/patchwork/LivePill";
import { ErrorState } from "@/components/patchwork";
import { ActivityTabs } from "@/components/ActivityTabs";
import { useDebounced } from "@/hooks/useDebounced";

interface AssertionFailure {
  assertion: string;
  expected?: unknown;
  actual?: unknown;
  message: string;
}

function formatRecipeName(name: string, trigger: string): string {
  // Already has colon variant
  if (name.includes(":")) return name;
  const norm = normaliseTrigger(trigger);
  if (norm === "manual") return name;
  // Map to short variant suffix: webhook→hook, recipe→agent, cron→cron, git_hook→git
  const suffix =
    norm === "webhook"
      ? "hook"
      : norm === "recipe"
        ? "agent"
        : norm === "git_hook"
          ? "git"
          : norm;
  return `${name}:${suffix}`;
}

function normaliseTrigger(t: string): string {
  if (t.startsWith("recipe:")) return "recipe";
  if (t.startsWith("cron") || t.startsWith("@")) return "cron";
  if (t.startsWith("webhook") || t.startsWith("yaml-webhook")) return "webhook";
  if (t.startsWith("git_hook")) return "git_hook";
  return "manual";
}

interface Run {
  seq: number;
  taskId: string;
  recipeName: string;
  trigger: string;
  status: "running" | "done" | "error" | "cancelled" | "interrupted";
  createdAt: number;
  startedAt?: number;
  doneAt: number;
  durationMs: number;
  model?: string;
  outputTail?: string;
  errorMessage?: string;
  assertionFailures?: AssertionFailure[];
  /** PR5c — stable id for one logical retry-attempt; ties resumed runs together. */
  manualRunId?: string;
}

type TriggerFilter = "all" | "cron" | "webhook" | "recipe" | "manual" | "git_hook";
type StatusFilter =
  | "all"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

function fmtWhen(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function statusPill(r: Run): "ok" | "err" | "warn" | "muted" | "running" {
  if (r.status === "running") return "running";
  if (r.assertionFailures && r.assertionFailures.length > 0) return "err";
  if (r.status === "done") return "ok";
  if (r.status === "error") return "err";
  return "warn";
}

const RUNS_PAGE_SIZE = 100;

type HaltCategory =
  | "agent_silent_fail"
  | "agent_narration_only"
  | "agent_threw"
  | "tool_threw"
  | "tool_error"
  | "kill_switch"
  | "run_level"
  | "unknown";

interface HaltSummary {
  total: number;
  byCategory: Partial<Record<HaltCategory, number>>;
  recent: Array<{ reason: string; category: HaltCategory; runSeq: number }>;
}

const HALT_CATEGORY_LABEL: Record<HaltCategory, string> = {
  agent_silent_fail: "agent silent-fail",
  agent_narration_only: "agent narration-only",
  agent_threw: "agent threw",
  tool_threw: "tool threw",
  tool_error: "tool error",
  kill_switch: "kill-switch blocked",
  run_level: "run-level halt",
  unknown: "uncategorised",
};

type TimeWindow = "any" | "1h" | "24h" | "overnight" | "7d";

const TIME_WINDOW_LABEL: Record<TimeWindow, string> = {
  any: "Any time",
  "1h": "Last hour",
  "24h": "Last 24h",
  overnight: "Since 6pm yesterday",
  "7d": "Last 7 days",
};

function windowCutoffMs(w: TimeWindow): number | null {
  if (w === "any") return null;
  if (w === "1h") return 60 * 60 * 1000;
  if (w === "24h") return 24 * 60 * 60 * 1000;
  if (w === "7d") return 7 * 24 * 60 * 60 * 1000;
  // overnight = since 6pm of the previous calendar day in local time.
  const d = new Date();
  d.setHours(18, 0, 0, 0);
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
  return Date.now() - d.getTime();
}

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [err, setErr] = useState<string>();
  const [trigger, setTrigger] = useState<TriggerFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [window, setWindow] = useState<TimeWindow>("any");
  const [haltSummary, setHaltSummary] = useState<HaltSummary | null>(null);
  const [recipeQuery, setRecipeQuery] = useState("");
  const debouncedRecipeQuery = useDebounced(recipeQuery, 250);
  const [limit, setLimit] = useState(RUNS_PAGE_SIZE);
  const [expanded, setExpanded] = useState<string | null>(null);

  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    const load = async () => {
      try {
        const params = new URLSearchParams({ limit: String(limit) });
        if (trigger !== "all") params.set("trigger", trigger);
        if (status !== "all") params.set("status", status);
        if (debouncedRecipeQuery) params.set("recipe", debouncedRecipeQuery);
        const res = await fetch(apiPath(`/api/bridge/runs?${params}`));
        if (!res.ok) throw new Error(`/runs ${res.status}`);
        const data = (await res.json()) as { runs?: Run[] };
        setRuns(data.runs ?? []);
        setErr(undefined);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    reloadRef.current = () => void load();
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [trigger, status, debouncedRecipeQuery, limit]);

  // PR1c: poll halt-summary independently (cheaper payload, fixed cadence).
  // PR4: window selector feeds the same sinceMs into the summary so the
  // pills always reflect the same window as the displayed run list.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const sinceMs = windowCutoffMs(window);
        const qs = sinceMs != null ? `?sinceMs=${sinceMs}` : "";
        const res = await fetch(
          apiPath(`/api/bridge/runs/halt-summary${qs}`),
        );
        if (!res.ok) return;
        const data = (await res.json()) as HaltSummary;
        if (!cancelled) setHaltSummary(data);
      } catch {
        /* halt summary is best-effort; ignore */
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [window]);

  const windowedRuns = useMemo(() => {
    const cutoffMs = windowCutoffMs(window);
    if (cutoffMs == null) return runs;
    if (runs == null) return null;
    const threshold = Date.now() - cutoffMs;
    return runs.filter((r) => r.createdAt >= threshold);
  }, [runs, window]);

  // Reset page size when filters change so we don't accidentally hold a giant fetch.
  useEffect(() => {
    setLimit(RUNS_PAGE_SIZE);
  }, [trigger, status, debouncedRecipeQuery]);

  const stats = useMemo(() => {
    const list = windowedRuns ?? [];
    const s = { ok: 0, err: 0, other: 0, totalMs: 0 };
    for (const r of list) {
      if (r.assertionFailures && r.assertionFailures.length > 0) s.err++;
      else if (r.status === "done") s.ok++;
      else if (r.status === "error") s.err++;
      else s.other++;
      s.totalMs += r.durationMs;
    }
    const avgMs = list.length ? Math.round(s.totalMs / list.length) : 0;
    return { ...s, avgMs, total: list.length };
  }, [windowedRuns]);

  const maxDur = useMemo(() => {
    if (!windowedRuns || windowedRuns.length === 0) return 1;
    return Math.max(...windowedRuns.map((r) => r.durationMs), 1);
  }, [windowedRuns]);

  return (
    <section>
      <ActivityTabs />
      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Runs — <span className="accent">every patch your agents stitched.</span>
          </h1>
          <div className="editorial-sub">
            {runs ? `${runs.length} runs` : "— runs"} · last 24h · avg {fmtDur(stats.avgMs)}
          </div>
        </div>
        <LivePill label="5s" />
      </div>

      {haltSummary && haltSummary.total > 0 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            marginBottom: "var(--s-4)",
            padding: "8px 12px",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            background: "var(--bg-0)",
          }}
          title={
            haltSummary.recent
              .map((r) => `run #${r.runSeq}: ${r.reason}`)
              .join("\n") || undefined
          }
        >
          <span className="mono muted" style={{ fontSize: "var(--fs-xs)" }}>
            halts (7d): {haltSummary.total}
          </span>
          {(
            Object.entries(haltSummary.byCategory) as Array<
              [HaltCategory, number]
            >
          )
            .sort((a, b) => b[1] - a[1])
            .map(([cat, count]) => (
              <span
                key={cat}
                className="pill"
                style={{
                  fontSize: "var(--fs-2xs)",
                  background: cat === "unknown" ? "var(--bg-1)" : undefined,
                  color: cat === "unknown" ? "var(--fg-2)" : "var(--err)",
                  // light-mode visibility: var(--bg-1) on a pill can blend
                  // into the panel, so add a subtle border on the muted variant.
                  ...(cat === "unknown" && {
                    border: "1px solid var(--border-subtle)",
                  }),
                }}
              >
                {HALT_CATEGORY_LABEL[cat]} · {count}
              </span>
            ))}
        </div>
      )}

      {/* filter bar */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: "var(--s-4)",
        }}
      >
        <input
          type="text"
          value={recipeQuery}
          onChange={(e) => setRecipeQuery(e.target.value)}
          placeholder="Filter by recipe…"
          aria-label="Filter by recipe"
          className="input"
          style={{ minWidth: "min(200px, 100%)", width: 240, maxWidth: "100%" }}
        />
        <select
          value={trigger}
          onChange={(e) => setTrigger(e.target.value as TriggerFilter)}
          aria-label="Trigger type"
          className="input"
          style={{ width: "auto", cursor: "pointer" }}
        >
          <option value="all">All triggers</option>
          <option value="cron">Cron</option>
          <option value="webhook">Webhook</option>
          <option value="recipe">Recipe</option>
          <option value="manual">Manual</option>
          <option value="git_hook">Git hook</option>
        </select>
        <select
          value={window}
          onChange={(e) => setWindow(e.target.value as TimeWindow)}
          aria-label="Time window"
          className="input"
          style={{ width: "auto", cursor: "pointer" }}
        >
          {(Object.keys(TIME_WINDOW_LABEL) as TimeWindow[]).map((w) => (
            <option key={w} value={w}>
              {TIME_WINDOW_LABEL[w]}
            </option>
          ))}
        </select>
        {(recipeQuery || trigger !== "all" || window !== "any") && (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setRecipeQuery("");
              setTrigger("all");
              setWindow("any");
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--s-4)", marginBottom: "var(--s-5)" }}>
        <button
          type="button"
          className="card"
          onClick={() => setStatus("all")}
          style={{
            textAlign: "left",
            padding: "20px 24px",
            borderLeft: `3px solid ${status === "all" ? "var(--orange)" : "var(--line-2)"}`,
            cursor: "pointer",
            background: "transparent",
          }}
          aria-pressed={status === "all"}
        >
          <div style={{ fontSize: "var(--fs-xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)", marginBottom: 8 }}>All runs</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 36, fontWeight: 800, color: "var(--ink-0)", lineHeight: 1 }}>{stats.total}</div>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginTop: 4 }}>Last 24h</div>
        </button>
        <button
          type="button"
          className="card"
          onClick={() => setStatus("done")}
          style={{
            textAlign: "left",
            padding: "20px 24px",
            borderLeft: `3px solid ${status === "done" ? "var(--ok)" : "var(--line-2)"}`,
            cursor: "pointer",
            background: "transparent",
          }}
          aria-pressed={status === "done"}
        >
          <div style={{ fontSize: "var(--fs-xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ok)", marginBottom: 8 }}>✓ Successful</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 36, fontWeight: 800, color: "var(--ink-0)", lineHeight: 1 }}>{stats.ok}</div>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginTop: 4 }}>{stats.total > 0 ? Math.round(stats.ok / stats.total * 100) + "%" : "—"} success rate</div>
        </button>
        <button
          type="button"
          className="card"
          onClick={() => setStatus("error")}
          style={{
            textAlign: "left",
            padding: "20px 24px",
            borderLeft: `3px solid ${status === "error" ? "var(--err)" : "var(--line-2)"}`,
            cursor: "pointer",
            background: "transparent",
          }}
          aria-pressed={status === "error"}
        >
          <div style={{ fontSize: "var(--fs-xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--err)", marginBottom: 8 }}>⚠ Errored</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 36, fontWeight: 800, color: stats.err > 0 ? "var(--err)" : "var(--ink-0)", lineHeight: 1 }}>{stats.err}</div>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginTop: 4 }}>{stats.total > 0 ? Math.round(stats.err / stats.total * 100) + "%" : "—"} error rate</div>
        </button>
      </div>

      {err && (!runs || runs.length === 0) && (
        <ErrorState
          title="Couldn't load runs"
          description="The bridge isn't responding to /runs."
          error={err}
          onRetry={() => reloadRef.current()}
        />
      )}
      {err && runs && runs.length > 0 && (
        <div className="alert-err">Refresh failed — {err}</div>
      )}

      {windowedRuns === null && !err ? (
        <div className="empty-state">
          <p>Loading…</p>
        </div>
      ) : !windowedRuns || windowedRuns.length === 0 ? (
        <div className="empty-state">
          <h3>{window === "any" ? "No runs yet" : "No runs in this window"}</h3>
          <p>
            {window === "any" ? (
              <>
                Recipe executions (cron, webhook, or{" "}
                <code>patchwork recipe run</code>) will appear here once they
                complete.
              </>
            ) : (
              <>
                No runs in “{TIME_WINDOW_LABEL[window]}”. Try widening the
                window.
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 120 }}>When</th>
                <th>Recipe</th>
                <th style={{ width: 90 }}>Trigger</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 200, textAlign: "right" }}>Duration</th>
                <th style={{ width: 80 }}>Task</th>
              </tr>
            </thead>
            <tbody>
              {windowedRuns.map((r) => {
                const key = `${r.taskId}-${r.seq}`;
                const isExpanded = expanded === key;
                const pct = Math.max(
                  3,
                  Math.round((r.durationMs / maxDur) * 100),
                );
                const sClass = statusPill(r);
                const barColor =
                  sClass === "ok"
                    ? "var(--green)"
                    : sClass === "err"
                      ? "var(--red)"
                      : "var(--amber)";
                return (
                  <React.Fragment key={key}>
                    <tr
                      onClick={() => setExpanded(isExpanded ? null : key)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setExpanded(isExpanded ? null : key);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-expanded={isExpanded}
                      style={{ cursor: "pointer" }}
                    >
                      <td className="mono muted">
                        {fmtWhen(
                          r.status === "running"
                            ? r.startedAt ?? r.createdAt
                            : r.doneAt,
                        )}
                      </td>
                      <td className="mono">
                        <Link
                          href={`/runs/${r.seq}`}
                          onClick={(e) => e.stopPropagation()}
                          style={{ fontWeight: 600 }}
                        >
                          {formatRecipeName(r.recipeName, r.trigger)}
                        </Link>
                      </td>
                      <td>
                        <span className="pill muted">{normaliseTrigger(r.trigger)}</span>
                        {r.manualRunId && (
                          <span
                            className="pill muted mono"
                            style={{
                              marginLeft: 6,
                              fontSize: "var(--fs-2xs)",
                            }}
                            title={`Attempt id ${r.manualRunId} — same id across runs = a resumed retry`}
                          >
                            attempt:{r.manualRunId.slice(-6)}
                          </span>
                        )}
                      </td>
                      <td>
                        <span
                          className={`pill ${sClass}`}
                          style={{ fontSize: "var(--fs-xs)" }}
                        >
                          {sClass !== "running" && (
                            <span className="pill-dot" />
                          )}
                          {r.status}
                          {r.assertionFailures &&
                            r.assertionFailures.length > 0 &&
                            ` · ${r.assertionFailures.length} fail`}
                        </span>
                      </td>
                      <td>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <div
                            className="progress"
                            style={{ flex: 1, height: 6 }}
                          >
                            <div
                              className="progress-fill"
                              style={{
                                width: r.status === "running" ? "100%" : `${pct}%`,
                                background: barColor,
                                opacity: r.status === "running" ? 0.4 : 1,
                              }}
                            />
                          </div>
                          <span
                            className="mono"
                            style={{
                              fontSize: "var(--fs-xs)",
                              color: "var(--ink-2)",
                              minWidth: 42,
                              textAlign: "right",
                            }}
                          >
                            {r.status === "running"
                              ? fmtDur(Date.now() - (r.startedAt ?? r.createdAt))
                              : fmtDur(r.durationMs)}
                          </span>
                        </div>
                      </td>
                      <td className="mono muted" title={r.taskId ?? undefined}>
                        {r.taskId?.slice(0, 8) ?? "—"}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${key}-detail`} className="task-row-expand">
                        <td colSpan={6}>
                          <div
                            style={{
                              padding: "12px 14px",
                              fontSize: "var(--fs-s)",
                              display: "flex",
                              flexDirection: "column",
                              gap: 8,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                gap: 16,
                                flexWrap: "wrap",
                                color: "var(--ink-2)",
                              }}
                            >
                              {r.model && (
                                <span>
                                  Model{" "}
                                  <span className="mono" style={{ color: "var(--ink-0)" }}>
                                    {r.model}
                                  </span>
                                </span>
                              )}
                              <span>
                                Created{" "}
                                <span
                                  className="mono"
                                  style={{ color: "var(--ink-0)" }}
                                >
                                  {new Date(r.createdAt).toISOString()}
                                </span>
                              </span>
                            </div>
                            {r.errorMessage && (
                              <div>
                                <div
                                  style={{
                                    fontSize: "var(--fs-2xs)",
                                    color: "var(--red)",
                                    fontWeight: 600,
                                    textTransform: "uppercase",
                                    letterSpacing: "0.06em",
                                    marginBottom: 4,
                                  }}
                                >
                                  Error
                                </div>
                                <pre
                                  className="task-output"
                                  style={{ color: "var(--red)" }}
                                >
                                  {r.errorMessage}
                                </pre>
                              </div>
                            )}
                            {r.assertionFailures &&
                              r.assertionFailures.length > 0 && (
                                <div>
                                  <div
                                    style={{
                                      fontSize: "var(--fs-2xs)",
                                      color: "var(--red)",
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                      letterSpacing: "0.06em",
                                      marginBottom: 4,
                                    }}
                                  >
                                    {r.assertionFailures.length} assertion
                                    failure
                                    {r.assertionFailures.length !== 1 ? "s" : ""}
                                  </div>
                                  <ul
                                    style={{
                                      margin: 0,
                                      paddingLeft: 20,
                                      display: "flex",
                                      flexDirection: "column",
                                      gap: 3,
                                    }}
                                  >
                                    {r.assertionFailures.map((f, i) => (
                                      <li
                                        key={i}
                                        style={{
                                          fontSize: "var(--fs-s)",
                                          color: "var(--red)",
                                        }}
                                      >
                                        <span
                                          className="mono"
                                          style={{ fontWeight: 600 }}
                                        >
                                          {f.assertion}
                                        </span>
                                        {" — "}
                                        {f.message}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            {r.outputTail && (
                              <div>
                                <div
                                  style={{
                                    fontSize: "var(--fs-2xs)",
                                    color: "var(--ink-2)",
                                    fontWeight: 600,
                                    textTransform: "uppercase",
                                    letterSpacing: "0.06em",
                                    marginBottom: 4,
                                  }}
                                >
                                  Output tail
                                </div>
                                <pre className="task-output">{r.outputTail}</pre>
                              </div>
                            )}
                            <div>
                              <Link
                                href={`/runs/${r.seq}`}
                                className="btn sm ghost"
                                style={{ textDecoration: "none" }}
                              >
                                Open full run →
                              </Link>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {runs != null &&
            runs.length >= limit &&
            // When the time-window selector trims the unfiltered fetch, the
            // user has already paged past the binding constraint — fetching
            // more from the server only returns runs older than the window,
            // which are then filtered out. Hide the button to avoid a no-op
            // network request.
            (windowedRuns == null || windowedRuns.length === runs.length) && (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                padding: "var(--s-4) 0",
              }}
            >
              <button
                type="button"
                className="btn ghost"
                onClick={() => setLimit((n) => n + RUNS_PAGE_SIZE)}
              >
                Load more (+{RUNS_PAGE_SIZE})
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
