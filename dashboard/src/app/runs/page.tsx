"use client";
import React from "react";
import { apiPath } from "@/lib/api";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { LivePill } from "@/components/patchwork/LivePill";
import { ErrorState } from "@/components/patchwork";
import { ActivityTabs } from "@/components/ActivityTabs";

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

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [err, setErr] = useState<string>();
  const [trigger] = useState<TriggerFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [recipeQuery] = useState("");
  const [limit, setLimit] = useState(RUNS_PAGE_SIZE);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const params = new URLSearchParams({ limit: String(limit) });
        if (trigger !== "all") params.set("trigger", trigger);
        if (status !== "all") params.set("status", status);
        if (recipeQuery) params.set("recipe", recipeQuery);
        const res = await fetch(apiPath(`/api/bridge/runs?${params}`));
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
  }, [trigger, status, recipeQuery, limit]);

  // Reset page size when filters change so we don't accidentally hold a giant fetch.
  useEffect(() => {
    setLimit(RUNS_PAGE_SIZE);
  }, [trigger, status, recipeQuery]);

  const stats = useMemo(() => {
    const list = runs ?? [];
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
  }, [runs]);

  const maxDur = useMemo(() => {
    if (!runs || runs.length === 0) return 1;
    return Math.max(...runs.map((r) => r.durationMs), 1);
  }, [runs]);

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

      {/* stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--s-4)", marginBottom: "var(--s-5)" }}>
        <button
          type="button"
          className="card"
          onClick={() => setStatus("all")}
          style={{
            textAlign: "left",
            padding: "20px 24px",
            borderLeft: "3px solid var(--orange)",
            cursor: "pointer",
            borderColor: status === "all" ? "var(--orange)" : undefined,
            background: "transparent",
          }}
          aria-pressed={status === "all"}
        >
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)", marginBottom: 8 }}>All runs</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 36, fontWeight: 800, color: "var(--ink-0)", lineHeight: 1 }}>{stats.total}</div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>Last 24h</div>
        </button>
        <button
          type="button"
          className="card"
          onClick={() => setStatus("done")}
          style={{
            textAlign: "left",
            padding: "20px 24px",
            borderLeft: "3px solid var(--ok)",
            cursor: "pointer",
            borderColor: status === "done" ? "var(--ok)" : undefined,
            background: "transparent",
          }}
          aria-pressed={status === "done"}
        >
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ok)", marginBottom: 8 }}>✓ Successful</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 36, fontWeight: 800, color: "var(--ink-0)", lineHeight: 1 }}>{stats.ok}</div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>{stats.total > 0 ? Math.round(stats.ok / stats.total * 100) + "%" : "—"} success rate</div>
        </button>
        <button
          type="button"
          className="card"
          onClick={() => setStatus("error")}
          style={{
            textAlign: "left",
            padding: "20px 24px",
            borderLeft: "3px solid var(--err)",
            cursor: "pointer",
            borderColor: status === "error" ? "var(--err)" : undefined,
            background: "transparent",
          }}
          aria-pressed={status === "error"}
        >
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--err)", marginBottom: 8 }}>⚠ Errored</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 36, fontWeight: 800, color: stats.err > 0 ? "var(--err)" : "var(--ink-0)", lineHeight: 1 }}>{stats.err}</div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>{stats.total > 0 ? Math.round(stats.err / stats.total * 100) + "%" : "—"} error rate</div>
        </button>
      </div>

      {err && (!runs || runs.length === 0) && (
        <ErrorState
          title="Couldn't load runs"
          description="The bridge isn't responding to /runs."
          error={err}
          onRetry={() => window.location.reload()}
        />
      )}
      {err && runs && runs.length > 0 && (
        <div className="alert-err">Refresh failed — {err}</div>
      )}

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
                <th style={{ width: 120 }}>When</th>
                <th>Recipe</th>
                <th style={{ width: 90 }}>Trigger</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 200, textAlign: "right" }}>Duration</th>
                <th style={{ width: 80 }}>Task</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r, idx) => {
                const isExpanded = expanded === String(r.seq);
                const key = `${r.seq}-${idx}`;
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
                      onClick={() =>
                        setExpanded(isExpanded ? null : String(r.seq))
                      }
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
                      </td>
                      <td>
                        <span
                          className={`pill ${sClass}`}
                          style={{ fontSize: 11 }}
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
                              fontSize: 11,
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
                              fontSize: 12,
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
                                    fontSize: 10,
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
                                      fontSize: 10,
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
                                          fontSize: 12,
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
                                    fontSize: 10,
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
          {runs.length >= limit && (
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
