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
    <section
      aria-label="Live and recent recipe runs"
      className="live-runs-strip"
      style={{
        marginBottom: "var(--s-4)",
        display: "flex",
        gap: 10,
        overflowX: "auto",
        // Scroll-snap carousel: each card snaps to the start edge so a
        // phone user can flick through them without a card half-clipped.
        scrollSnapType: "x proximity",
        // Right padding + scroll-padding keep the last card fully visible
        // and reachable instead of bleeding past the viewport edge.
        paddingRight: 12,
        scrollPaddingInline: 4,
        paddingBottom: 4,
        WebkitOverflowScrolling: "touch",
      }}
    >
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
            style={{
              // Cap at 260px but allow the card to shrink on narrow phones
              // so it never bleeds past the viewport edge with no scroll cue.
              flex: "0 0 clamp(220px, 78vw, 260px)",
              scrollSnapAlign: "start",
              padding: "10px 12px",
              borderRadius: "var(--r-2)",
              border: "1px solid var(--line-3)",
              background: isLive
                ? "color-mix(in srgb, var(--warn) 6%, var(--surface))"
                : tone === "err"
                  ? "color-mix(in srgb, var(--err) 5%, var(--surface))"
                  : "var(--surface)",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              minWidth: 0,
              transition: "transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease",
            }}
            onMouseEnter={(ev) => {
              const t = ev.currentTarget;
              t.style.transform = "translateY(-1px)";
              t.style.boxShadow = "0 4px 14px -8px rgba(0,0,0,0.18)";
              t.style.borderColor = "var(--line-2)";
            }}
            onMouseLeave={(ev) => {
              const t = ev.currentTarget;
              t.style.transform = "";
              t.style.boxShadow = "";
              t.style.borderColor = "var(--line-3)";
            }}
            title={
              r.haltReason
                ? `Halt: ${r.haltReason}`
                : `${name} · ${r.status} · ${isLive ? "started" : "finished"} ${relTime(isLive ? r.startedAt : r.doneAt ?? r.startedAt)}`
            }
          >
            <Link
              href={href}
              style={{
                textDecoration: "none",
                color: "var(--ink-1)",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                minWidth: 0,
              }}
            >
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              {isLive ? (
                <LivePill label={elapsed} tone="accent" />
              ) : (
                <StatusPill tone={tone}>{r.status}</StatusPill>
              )}
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--ink-0)",
                  fontSize: "var(--fs-s)",
                  fontWeight: 600,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {name}
              </span>
            </div>
            <div
              style={{
                fontSize: "var(--fs-xs)",
                color: "var(--ink-3)",
                display: "flex",
                gap: 6,
              }}
            >
              {isLive ? (
                <span>running · {elapsed}</span>
              ) : (
                <span>{relTime(r.doneAt ?? r.startedAt)} · {elapsed}</span>
              )}
              {r.haltReason && (
                <span
                  style={{
                    color: "var(--err)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  · {r.haltReason}
                </span>
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
                style={{
                  alignSelf: "flex-start",
                  fontSize: "var(--fs-xs)",
                  padding: "3px 9px",
                  borderRadius: "var(--r-2)",
                  border: "1px solid var(--line-2)",
                  background: "var(--surface)",
                  color: tone === "err" ? "var(--err)" : "var(--accent)",
                  cursor: isQueueing ? "wait" : "pointer",
                  fontWeight: 600,
                }}
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
