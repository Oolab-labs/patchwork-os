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
import { canonicalRecipeKey } from "@/lib/entityKey";

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
    const name = canonicalRecipeKey(r.recipeName ?? r.recipe ?? "");
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
    <div className="card recipe-leaderboard-card">
      <div className="lbrd-header">
        <h2 className="card-h2">Top recipes</h2>
        <div role="tablist" aria-label="Time window" className="lbrd-tabs">
          {(["1h", "24h", "7d"] as const).map((k) => {
            const active = k === windowKey;
            return (
              <button
                key={k}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => setWindowKey(k)}
                className="lbrd-tab"
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
        <div className="lbrd-empty">
          No runs in the last {windowKey}.{" "}
          <Link href="/recipes" className="lbrd-empty-link">
            Run a recipe →
          </Link>
        </div>
      ) : (
        <div className="lbrd-list">
          {agg.map((a) => {
            const tone = statusTone(a.lastRun.status);
            const isQueueing = Boolean(pending[a.name]);
            return (
              <div
                key={a.name}
                className="leaderboard-row"
              >
                <SuccessRing pct={a.okRate} size={26} stroke={3} />
                <Link
                  href={`/runs?recipe=${encodeURIComponent(a.name)}`}
                  className="lbrd-recipe-link"
                  title={a.isLive ? `${a.name} · running now` : `View ${a.name} runs`}
                >
                  {a.isLive && (
                    <span
                      aria-label="running now"
                      className="leaderboard-live-dot"
                    />
                  )}
                  <span>{a.name}</span>
                </Link>
                <RunSparkBars runs={a.runs.slice(0, 8)} slots={8} width={84} height={16} />
                <span
                  className="mono muted lbrd-count"
                  title={`${a.total} run${a.total === 1 ? "" : "s"}`}
                >
                  {a.total} run{a.total === 1 ? "" : "s"}
                </span>
                {a.halts > 0 && (
                  <span
                    className="pill warn xs"
                    title={`${a.halts} halted run${a.halts === 1 ? "" : "s"}`}
                  >
                    {a.halts} halt{a.halts === 1 ? "" : "s"}
                  </span>
                )}
                <span
                  className={`pill ${tone} xs lbrd-status-pill`}
                  title={`Last run ${relTime(a.lastRun.startedAt)} · ${a.lastRun.status}`}
                >
                  {a.lastRun.status}
                </span>
                <button
                  type="button"
                  onClick={() => void run(a.name)}
                  disabled={isQueueing}
                  className="lbrd-run-btn"
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
