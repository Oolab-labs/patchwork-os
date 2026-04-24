"use client";
import React from "react";
import { apiPath } from "@/lib/api";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";

interface AssertionFailure {
  assertion: string;
  message: string;
}

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
  assertionFailures?: AssertionFailure[];
}

type TriggerFilter = "all" | "cron" | "webhook" | "recipe";
type StatusFilter = "all" | "done" | "error" | "cancelled" | "interrupted";

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

function statusPill(r: Run): "ok" | "err" | "warn" | "muted" {
  if (r.assertionFailures && r.assertionFailures.length > 0) return "err";
  if (r.status === "done") return "ok";
  if (r.status === "error") return "err";
  return "warn";
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
  }, [trigger, status]);

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

  const triggerChips: { k: TriggerFilter; label: string }[] = [
    { k: "all", label: "All" },
    { k: "cron", label: "Cron" },
    { k: "webhook", label: "Webhook" },
    { k: "recipe", label: "Manual" },
  ];
  const statusChips: { k: StatusFilter; label: string }[] = [
    { k: "all", label: "Any" },
    { k: "done", label: "Done" },
    { k: "error", label: "Error" },
    { k: "cancelled", label: "Cancelled" },
  ];

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <div className="page-head-sub">
            Every recipe execution — cron, webhook, and manual.
          </div>
        </div>
        {runs && <span className="pill muted">{runs.length} shown</span>}
      </div>

      {/* hero strip */}
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
            Recipe runs
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ink-0)" }}>
            {stats.total} execution{stats.total !== 1 ? "s" : ""} in window
          </div>
        </div>
        {[
          { label: "Passed", n: stats.ok, color: "var(--green)" },
          { label: "Failed", n: stats.err, color: "var(--red)" },
          { label: "Other", n: stats.other, color: "var(--ink-3)" },
          {
            label: "Avg",
            n: stats.avgMs ? fmtDur(stats.avgMs) : "—",
            color: "var(--ink-0)",
          },
        ].map((it, i) => (
          <Fragment key={it.label}>
            <div
              aria-hidden
              style={{ width: 1, height: 32, background: "var(--line-2)" }}
            />
            <div style={{ textAlign: "center", minWidth: 72 }}>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 800,
                  fontFamily: "var(--font-mono)",
                  color:
                    typeof it.n === "number" && it.n === 0
                      ? "var(--ink-3)"
                      : it.color,
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

      {/* filter chips */}
      <div
        style={{
          display: "flex",
          gap: "var(--s-4)",
          marginBottom: "var(--s-4)",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
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
            Trigger
          </div>
          <div className="filter-chips" style={{ marginBottom: 0 }}>
            {triggerChips.map((c) => (
              <button
                type="button"
                key={c.k}
                onClick={() => setTrigger(c.k)}
                className={`filter-chip${trigger === c.k ? " active" : ""}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
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
            Status
          </div>
          <div className="filter-chips" style={{ marginBottom: 0 }}>
            {statusChips.map((c) => (
              <button
                type="button"
                key={c.k}
                onClick={() => setStatus(c.k)}
                className={`filter-chip${status === c.k ? " active" : ""}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
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
                <th style={{ width: 120 }}>When</th>
                <th>Recipe</th>
                <th style={{ width: 90 }}>Trigger</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 200 }}>Duration</th>
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
                      <td className="mono muted">{fmtWhen(r.doneAt)}</td>
                      <td className="mono">
                        <Link
                          href={`/runs/${r.seq}`}
                          onClick={(e) => e.stopPropagation()}
                          style={{ fontWeight: 600 }}
                        >
                          {r.recipeName}
                        </Link>
                      </td>
                      <td>
                        <span className="pill muted">{r.trigger}</span>
                      </td>
                      <td>
                        <span
                          className={`pill ${sClass}`}
                          style={{ fontSize: 11 }}
                        >
                          <span className="pill-dot" />
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
                                width: `${pct}%`,
                                background: barColor,
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
                            {fmtDur(r.durationMs)}
                          </span>
                        </div>
                      </td>
                      <td className="mono muted">
                        <Link href="/tasks">{r.taskId.slice(0, 8)}</Link>
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
        </div>
      )}
    </section>
  );
}
