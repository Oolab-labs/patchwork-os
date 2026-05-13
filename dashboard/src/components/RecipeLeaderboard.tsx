"use client";

import Link from "next/link";
import { ActionPill, RunSparkBars, SuccessRing } from "@/components/patchwork";
import { relTime } from "@/components/time";

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
  /** Window to consider, in ms. Defaults to 24h. */
  windowMs?: number;
}

interface RecipeAgg {
  name: string;
  runs: LeaderboardRun[];
  total: number;
  halts: number;
  okRate: number;
  lastRun: LeaderboardRun;
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
  windowMs = 24 * 60 * 60 * 1000,
}: RecipeLeaderboardProps) {
  const agg = aggregateByRecipe(runs, windowMs).slice(0, limit);

  return (
    <div className="card" style={{ padding: "18px 20px" }}>
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
          Top recipes · last 24h
        </h2>
        <ActionPill href="/recipes" ariaLabel="View all recipes">
          all →
        </ActionPill>
      </div>

      {agg.length === 0 ? (
        <div style={{ fontSize: "var(--fs-s)", color: "var(--ink-3)", padding: "8px 0" }}>
          No runs in the last 24h.{" "}
          <Link href="/recipes" style={{ color: "var(--accent)" }}>
            Run a recipe →
          </Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {agg.map((a) => {
            const tone = statusTone(a.lastRun.status);
            return (
              <Link
                key={a.name}
                href={`/dashboard/runs?recipe=${encodeURIComponent(a.name)}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 8px",
                  borderRadius: "var(--r-sm)",
                  textDecoration: "none",
                  color: "var(--ink-1)",
                  fontSize: "var(--fs-s)",
                }}
              >
                <SuccessRing pct={a.okRate} size={26} stroke={3} />
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--ink-0)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {a.name}
                </span>
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
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
