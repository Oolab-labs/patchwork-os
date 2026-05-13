"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RunSparkBars, SuccessRing } from "@/components/patchwork";
import { relTime } from "@/components/time";
import { useRunRecipe } from "@/hooks/useRunRecipe";
import type { LeaderboardRun } from "./RecipeLeaderboard";

/**
 * Hero aside slot. The first iteration always read "FEATURED · 24h" no
 * matter what the data said — that's labeling the slot, not earning
 * the pixels. This iteration picks a *mode* from the data and frames
 * the slot around what's actionable right now:
 *
 *   - running     "LIVE NOW · <name> · <elapsed>"   → View live
 *   - needs-retry "NEEDS A RETRY · <name>"           → ↻ Retry
 *   - top         "TOP TODAY · <name>"               → ▶ Run now
 *   - empty       "START HERE"                       → Browse recipes
 *
 * Each mode swaps the eyebrow copy, the primary CTA, and the tone of
 * the action button. The slot becomes a state-aware affordance, not a
 * decorative label.
 */

interface FeaturedRecipeAsideProps {
  runs: LeaderboardRun[];
  /** Window in ms for volume ranking. Defaults to 24h. */
  windowMs?: number;
}

type Mode = "running" | "needs-retry" | "top" | "empty";

interface AsidePick {
  mode: Mode;
  name: string;
  total: number;
  okRate: number;
  lastRun: LeaderboardRun;
  recent: LeaderboardRun[];
  /** Elapsed since startedAt, only meaningful when mode === "running". */
  elapsedMs?: number;
}

const RETRY_WINDOW_MS = 2 * 60 * 60 * 1000;
function isHalted(s: string): boolean {
  return s === "error" || s === "failed" || s === "interrupted" || s === "cancelled";
}
function nameOf(r: LeaderboardRun): string {
  return (r.recipeName ?? r.recipe ?? "").replace(/:agent$/, "");
}

function pickAside(runs: LeaderboardRun[], windowMs: number): AsidePick | null {
  const now = Date.now();
  const cutoff = now - windowMs;
  const byName = new Map<string, LeaderboardRun[]>();
  for (const r of runs) {
    if (r.startedAt < cutoff) continue;
    const name = nameOf(r);
    if (!name) continue;
    const list = byName.get(name) ?? [];
    list.push(r);
    byName.set(name, list);
  }
  if (byName.size === 0) return null;

  let topName: string | null = null;
  let topTotal = 0;
  let liveCandidate: { name: string; run: LeaderboardRun } | null = null;
  let retryCandidate: { name: string; run: LeaderboardRun } | null = null;

  for (const [name, list] of byName) {
    if (list.length > topTotal) {
      topTotal = list.length;
      topName = name;
    }
    for (const r of list) {
      if (r.status === "running") {
        if (!liveCandidate || r.startedAt > liveCandidate.run.startedAt) {
          liveCandidate = { name, run: r };
        }
      }
    }
    const mostRecent = [...list].sort((a, b) => b.startedAt - a.startedAt)[0];
    if (
      mostRecent &&
      isHalted(mostRecent.status) &&
      now - mostRecent.startedAt < RETRY_WINDOW_MS
    ) {
      if (
        !retryCandidate ||
        mostRecent.startedAt > retryCandidate.run.startedAt
      ) {
        retryCandidate = { name, run: mostRecent };
      }
    }
  }

  const build = (mode: Mode, name: string): AsidePick => {
    const list = byName.get(name) ?? [];
    const sorted = [...list].sort((a, b) => b.startedAt - a.startedAt);
    const okCount = sorted.filter((r) => r.status === "done" || r.status === "success").length;
    const decided = sorted.filter((r) => r.status !== "running").length;
    const okRate = decided === 0 ? 0 : (okCount / decided) * 100;
    return {
      mode,
      name,
      total: sorted.length,
      okRate,
      lastRun: sorted[0],
      recent: sorted.slice(0, 10),
      elapsedMs:
        mode === "running" && sorted[0]?.status === "running"
          ? now - sorted[0].startedAt
          : undefined,
    };
  };

  if (liveCandidate) return build("running", liveCandidate.name);
  if (retryCandidate) return build("needs-retry", retryCandidate.name);
  if (topName) return build("top", topName);
  return null;
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function FeaturedRecipeAside({
  runs,
  windowMs = 24 * 60 * 60 * 1000,
}: FeaturedRecipeAsideProps) {
  const pick = pickAside(runs, windowMs);
  const { run, pending } = useRunRecipe();
  // Tick once a second when a run is live so the elapsed counter stays
  // honest without waiting on the parent's 5-second poll.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (pick?.mode !== "running") return;
    const id = setInterval(() => setNow((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [pick?.mode]);

  if (!pick) {
    return (
      <div className="quilt-aside-empty" aria-label="No recipes ready yet">
        <div className="quilt-aside-empty-label">Start here</div>
        <div className="quilt-aside-empty-value">No runs yet</div>
        <div className="quilt-aside-empty-foot">
          <Link
            href="/dashboard/marketplace"
            style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}
          >
            Browse recipes →
          </Link>
        </div>
      </div>
    );
  }

  const isQueueing = Boolean(pending[pick.name]);
  const elapsed = pick.elapsedMs != null ? fmtElapsed(Date.now() - pick.lastRun.startedAt) : null;

  const eyebrow = (() => {
    switch (pick.mode) {
      case "running":
        return (
          <>
            <span className="quilt-aside-eyebrow-dot" data-pulsing="1" />
            Live now · {elapsed}
          </>
        );
      case "needs-retry":
        return (
          <>
            <span className="quilt-aside-eyebrow-dot" data-tone="err" />
            Needs a retry · {relTime(pick.lastRun.startedAt)}
          </>
        );
      default:
        return (
          <>
            <span className="quilt-aside-eyebrow-dot" data-tone="accent" />
            Top today · {pick.total} run{pick.total === 1 ? "" : "s"}
          </>
        );
    }
  })();

  const ctaLabel = (() => {
    if (isQueueing) return "Queueing…";
    if (pick.mode === "running") return "View live →";
    if (pick.mode === "needs-retry") return "↻ Retry";
    return "▶ Run now";
  })();

  const ctaHref =
    pick.mode === "running"
      ? pick.lastRun.startedAt > 0
        ? `/dashboard/runs?recipe=${encodeURIComponent(pick.name)}`
        : "/dashboard/runs"
      : null;

  return (
    <div
      className="quilt-aside-featured"
      data-mode={pick.mode}
      aria-label={`Recipe ${pick.name}`}
    >
      <div className="quilt-aside-eyebrow">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {eyebrow}
        </span>
        <SuccessRing pct={pick.okRate} size={22} stroke={3} />
      </div>
      <Link
        href={`/dashboard/recipes/${encodeURIComponent(pick.name)}/edit`}
        className="quilt-aside-name"
        title={`Edit ${pick.name}`}
      >
        {pick.name}
      </Link>
      <div className="quilt-aside-meta">
        {pick.mode === "running" ? (
          <>Started {relTime(pick.lastRun.startedAt)} · {pick.total - 1} other{pick.total - 1 === 1 ? "" : "s"} today</>
        ) : pick.mode === "needs-retry" ? (
          <>Last run halted · {pick.total} run{pick.total === 1 ? "" : "s"} today</>
        ) : (
          <>Last {relTime(pick.lastRun.startedAt)} · {Math.round(pick.okRate)}% ok</>
        )}
      </div>
      <div className="quilt-aside-spark">
        <RunSparkBars runs={pick.recent} slots={10} width={180} height={20} />
      </div>
      {ctaHref ? (
        <Link
          href={ctaHref}
          className="quilt-aside-run"
          data-mode={pick.mode}
          title={`Open live run of ${pick.name}`}
        >
          {ctaLabel}
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => void run(pick.name)}
          disabled={isQueueing}
          className="quilt-aside-run"
          data-mode={pick.mode}
          title={`Run ${pick.name} now`}
        >
          {ctaLabel}
        </button>
      )}
    </div>
  );
}
