"use client";

import Link from "next/link";
import { LivePill, StatusPill } from "@/components/patchwork";
import { relTime } from "@/components/time";
import { useRunRecipe } from "@/hooks/useRunRecipe";

/**
 * Horizontal "what's running now" strip for the Overview page. Renders
 * runs in flight + runs that finished in the last 10 minutes, so a user
 * landing on /dashboard can immediately see "is anything alive, did
 * anything just halt?" without clicking through to /runs.
 *
 * Auto-hides when there's nothing to show. The empty state on Overview
 * is silence, not an empty card — this surface earns its pixels only
 * when there's signal.
 */

export interface LiveRun {
  seq?: number;
  recipe: string;
  recipeName?: string;
  startedAt: number;
  doneAt?: number;
  status: string;
  durationMs?: number;
  haltReason?: string;
  /** Run finished `done` but ≥1 step ended in error — "completed with
   *  errors". Set by the bridge run log (see runLog.hadStepErrors). */
  hadStepErrors?: boolean;
}

interface LiveRunsStripProps {
  runs: LiveRun[];
  /** Window in ms for "recently finished". Defaults to 10 min. */
  recentWindowMs?: number;
  /** Maximum cards. Defaults to 5. */
  limit?: number;
}

function recipeNameOf(r: LiveRun): string {
  return (r.recipeName ?? r.recipe ?? "").replace(/:agent$/, "");
}

function statusTone(status: string): "ok" | "err" | "warn" | "muted" {
  const s = status.toLowerCase();
  if (s === "running") return "warn";
  if (s === "done" || s === "success") return "ok";
  if (s === "error" || s === "failed" || s === "interrupted") return "err";
  return "muted";
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

export function LiveRunsStrip({
  runs,
  recentWindowMs = 10 * 60 * 1000,
  limit = 5,
}: LiveRunsStripProps) {
  const { run, pending } = useRunRecipe();
  const now = Date.now();
  const visible = runs
    .filter((r) => {
      if (r.status === "running") return true;
      const endedAt = r.doneAt ?? r.startedAt + (r.durationMs ?? 0);
      return now - endedAt < recentWindowMs;
    })
    .sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return b.startedAt - a.startedAt;
    })
    .slice(0, limit);

  if (visible.length === 0) return null;

  return (
    <section aria-label="Live and recent recipe runs" className="live-runs-strip">
      {visible.map((r, i) => {
        const name = recipeNameOf(r);
        const tone = statusTone(r.status);
        const isLive = r.status === "running";
        const elapsed = isLive
          ? fmtElapsed(now - r.startedAt)
          : r.durationMs
            ? fmtElapsed(r.durationMs)
            : "—";
        const href = r.seq != null
          ? `/runs/${r.seq}`
          : `/runs?recipe=${encodeURIComponent(name)}`;
        const showRerun = !isLive && name.length > 0 && !pending[name];
        const isQueueing = Boolean(pending[name]);
        return (
          <div
            key={r.seq ?? `${name}-${r.startedAt}-${i}`}
            className="live-run-card"
            data-live={isLive ? "1" : "0"}
            data-tone={tone}
            title={
              r.haltReason
                ? `Halt: ${r.haltReason}`
                : `${name} · ${r.status} · ${isLive ? "started" : "finished"} ${relTime(isLive ? r.startedAt : r.doneAt ?? r.startedAt)}`
            }
          >
            <Link href={href} className="lrc-link">
              <div className="lrc-status-row">
                {isLive ? (
                  <LivePill label={elapsed} tone="accent" />
                ) : (
                  <StatusPill tone={tone}>{r.status}</StatusPill>
                )}
                <span className="lrc-name">{name}</span>
              </div>
              <div className="lrc-meta">
                {isLive ? (
                  <span>running · {elapsed}</span>
                ) : (
                  <span>{relTime(r.doneAt ?? r.startedAt)} · {elapsed}</span>
                )}
                {r.haltReason && (
                  <span className="lrc-halt-reason">· {r.haltReason}</span>
                )}
              </div>
            </Link>
            {showRerun && (
              <button
                type="button"
                onClick={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  void run(name);
                }}
                disabled={isQueueing}
                className="live-run-rerun-btn"
                data-tone={tone}
                title={`Run ${name} again`}
              >
                {isQueueing ? "queueing…" : tone === "err" ? "↻ Retry" : "↻ Run again"}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
