"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ActionPill,
  RunSparkBars,
  SuccessRing,
} from "@/components/patchwork";
import { relTime } from "@/components/time";
import { useRunRecipe } from "@/hooks/useRunRecipe";

/**
 * Recipe activity leaderboard for the Overview page. Replaces the old
 * "Recent recipes" card, which sorted by lastRun timestamp but rendered
 * only name + relTime — no run shape, no halt signal, no status.
 *
 * Three audits in 2026-05-13 converged: recipes are the unit of work,
 * yet every aggregate surface (tool-calls chart, ActivityThread,
 * tokens-burnt tile) keys on tools or events, not recipes. This card is
 * the "Top recipes — last 24h" answer to "what's actually running, and
 * how healthy?" — at the same screen position as the old card.
 *
 * Each row:
 *   [SuccessRing] recipe-name  ▮▮▮▮▮  N runs · K halts · last <status> Xm ago
 * Click → /runs?recipe=<name>.
 */

export interface LeaderboardRun {
  recipe: string;
  recipeName?: string;
  startedAt: number;
  status: string;
  durationMs?: number;
}

interface RecipeLeaderboardProps {
  /** All runs from /api/bridge/runs (will be filtered + grouped here). */
  runs: LeaderboardRun[];
  /** Maximum rows to display. Defaults to 6. */
  limit?: number;
}

type WindowKey = "1h" | "24h" | "7d";

const WINDOW_MS: Record<WindowKey, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

interface RecipeAgg {
  name: string;
  runs: LeaderboardRun[];
  total: number;
  halts: number;
  okRate: number;
  lastRun: LeaderboardRun;
  isLive: boolean;
}

function aggregateByRecipe(
  runs: LeaderboardRun[],
  windowMs: number,
): RecipeAgg[] {
  const cutoff = Date.now() - windowMs;
  const byName = new Map<string, LeaderboardRun[]>();
  for (const r of runs) {
    if (r.startedAt < cutoff) continue;
    const name = (r.recipeName ?? r.recipe ?? "").replace(/:agent$/, "");
    if (!name) continue;
    const list = byName.get(name) ?? [];
    list.push(r);
    byName.set(name, list);
  }
  const out: RecipeAgg[] = [];
  for (const [name, list] of byName) {
    const sorted = [...list].sort((a, b) => b.startedAt - a.startedAt);
    const halts = sorted.filter(
      (r) => r.status === "error" || r.status === "cancelled" || r.status === "interrupted",
    ).length;
    const okCount = sorted.filter((r) => r.status === "done" || r.status === "success").length;
    const decided = sorted.filter((r) => r.status !== "running").length;
    const okRate = decided === 0 ? 0 : (okCount / decided) * 100;
    out.push({
      name,
      runs: sorted,
      total: sorted.length,
      halts,
      okRate,
      lastRun: sorted[0],
      isLive: sorted.some((r) => r.status === "running"),
    });
  }
  // Sort by total runs desc; ties broken by halt rate asc (fewer halts wins).
  out.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.halts / Math.max(a.total, 1) - b.halts / Math.max(b.total, 1);
  });
  return out;
}

function statusTone(status: string): "ok" | "err" | "warn" | "muted" {
  const s = status.toLowerCase();
  if (s === "done" || s === "success") return "ok";
  if (s === "error" || s === "failed") return "err";
  if (s === "running") return "warn";
  return "muted";
}

export function RecipeLeaderboard({
  runs,
  limit = 6,
}: RecipeLeaderboardProps) {
  const [windowKey, setWindowKey] = useState<WindowKey>("24h");
  const { run, pending } = useRunRecipe();
  const agg = aggregateByRecipe(runs, WINDOW_MS[windowKey]).slice(0, limit);

  return (
    <div className="card recipe-leaderboard-card" style={{ padding: "18px 20px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 14,
        }}
      >
        <h2
          style={{
            fontSize: "var(--fs-m)",
            fontWeight: 700,
            margin: 0,
            color: "var(--ink-0)",
            flex: 1,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Top recipes
        </h2>
        <div
          role="tablist"
          aria-label="Time window"
          style={{
            display: "inline-flex",
            border: "1px solid var(--line-3)",
            borderRadius: "var(--r-2)",
            padding: 2,
            background: "var(--surface)",
          }}
        >
          {(["1h", "24h", "7d"] as const).map((k) => {
            const active = k === windowKey;
            return (
              <button
                key={k}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => setWindowKey(k)}
                style={{
                  fontSize: "var(--fs-xs)",
                  fontFamily: "var(--font-mono)",
                  padding: "2px 9px",
                  border: "none",
                  borderRadius: "var(--r-sm)",
                  cursor: "pointer",
                  background: active ? "color-mix(in srgb, var(--accent) 14%, transparent)" : "transparent",
                  color: active ? "var(--accent)" : "var(--ink-3)",
                  fontWeight: active ? 600 : 500,
                }}
              >
                {k}
              </button>
            );
          })}
        </div>
        <ActionPill href="/recipes" ariaLabel="View all recipes">
          all →
        </ActionPill>
      </div>

      {agg.length === 0 ? (
        <div style={{ fontSize: "var(--fs-s)", color: "var(--ink-3)", padding: "8px 0" }}>
          No runs in the last {windowKey}.{" "}
          <Link href="/recipes" style={{ color: "var(--accent)" }}>
            Run a recipe →
          </Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {agg.map((a) => {
            const tone = statusTone(a.lastRun.status);
            const isQueueing = Boolean(pending[a.name]);
            return (
              <div
                key={a.name}
                className="leaderboard-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 8px",
                  borderRadius: "var(--r-sm)",
                  fontSize: "var(--fs-s)",
                  transition: "background 120ms ease",
                }}
                onMouseEnter={(ev) => {
                  ev.currentTarget.style.background = "var(--recess)";
                }}
                onMouseLeave={(ev) => {
                  ev.currentTarget.style.background = "";
                }}
              >
                <SuccessRing pct={a.okRate} size={26} stroke={3} />
                <Link
                  href={`/runs?recipe=${encodeURIComponent(a.name)}`}
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--ink-0)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    textDecoration: "none",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                  title={a.isLive ? `${a.name} · running now` : `View ${a.name} runs`}
                >
                  {a.isLive && (
                    <span
                      aria-label="running now"
                      className="leaderboard-live-dot"
                    />
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.name}
                  </span>
                </Link>
                <RunSparkBars runs={a.runs.slice(0, 8)} slots={8} width={84} height={16} />
                <span
                  className="mono muted"
                  style={{ fontSize: "var(--fs-xs)", minWidth: 56, textAlign: "right" }}
                  title={`${a.total} run${a.total === 1 ? "" : "s"}`}
                >
                  {a.total} run{a.total === 1 ? "" : "s"}
                </span>
                {a.halts > 0 && (
                  <span
                    className="pill warn"
                    style={{ fontSize: "var(--fs-3xs)", flexShrink: 0 }}
                    title={`${a.halts} halted run${a.halts === 1 ? "" : "s"}`}
                  >
                    {a.halts} halt{a.halts === 1 ? "" : "s"}
                  </span>
                )}
                <span
                  className={`pill ${tone}`}
                  style={{ fontSize: "var(--fs-3xs)", flexShrink: 0, minWidth: 64, textAlign: "center" }}
                  title={`Last run ${relTime(a.lastRun.startedAt)} · ${a.lastRun.status}`}
                >
                  {a.lastRun.status}
                </span>
                <button
                  type="button"
                  onClick={() => void run(a.name)}
                  disabled={isQueueing}
                  style={{
                    fontSize: "var(--fs-xs)",
                    padding: "2px 8px",
                    border: "1px solid var(--line-2)",
                    background: isQueueing ? "var(--recess)" : "var(--surface)",
                    color: "var(--accent)",
                    borderRadius: "var(--r-2)",
                    cursor: isQueueing ? "wait" : "pointer",
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                  title={`Run ${a.name} now`}
                >
                  {isQueueing ? "…" : "▶ Run"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
