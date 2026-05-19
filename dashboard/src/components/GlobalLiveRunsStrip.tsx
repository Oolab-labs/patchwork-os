"use client";
import Link from "next/link";
import { useActiveRuns } from "@/hooks/LiveRunsContext";
import { StatusPill } from "@/components/patchwork";

/**
 * Always-on global "what's running now" strip. Mounted in Shell so it
 * follows the user across pages. Reads directly from the LiveRuns
 * store via \`useActiveRuns()\`. Auto-hides when nothing is live —
 * the strip earns its pixels only when there's signal.
 *
 * Different from \`LiveRunsStrip\` (which is fed an externally-fetched
 * \`runs\` array on the Overview page) — this one consumes the
 * cross-page lifecycle store.
 */

function pct(state: { totalSteps: number; doneSteps: number }): number {
  if (state.totalSteps <= 0) return 0;
  return Math.min(100, Math.round((state.doneSteps / state.totalSteps) * 100));
}

function tone(status: string): "ok" | "err" | "warn" | "muted" {
  if (status === "running") return "warn";
  if (status === "ok") return "ok";
  if (status === "halted") return "muted";
  return "err";
}

const MAX_VISIBLE = 4;

export function GlobalLiveRunsStrip() {
  const runs = useActiveRuns();
  // Order: running first, then most recent terminal first.
  const all = Array.from(runs.values()).sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (b.status === "running" && a.status !== "running") return 1;
    return b.startedAt - a.startedAt;
  });
  if (all.length === 0) return null;

  const visible = all.slice(0, MAX_VISIBLE);
  const overflow = all.length - visible.length;

  return (
    <div className="global-live-runs-strip" role="status" aria-live="polite">
      {visible.map((r) => {
        const p = pct(r);
        const label =
          r.status === "running"
            ? r.totalSteps > 0
              ? `Step ${r.doneSteps}/${r.totalSteps}`
              : "Running"
            : r.status === "ok"
              ? "Done"
              : r.status === "halted"
                ? "Halted"
                : "Error";
        const href = r.runSeq > 0 ? `/runs/${r.runSeq}` : null;
        const inner = (
          <>
            <span className="global-live-runs-strip-name">{r.recipeName}</span>
            <StatusPill tone={tone(r.status)}>{label}</StatusPill>
            {r.status === "running" && r.totalSteps > 0 && (
              <span className="global-live-runs-strip-bar" aria-label={`Progress ${p}%`}>
                <span style={{ width: `${p}%` }} />
              </span>
            )}
          </>
        );
        return href ? (
          <Link
            key={r.recipeName}
            href={href}
            className="global-live-runs-strip-row"
            title={`Open run #${r.runSeq}`}
          >
            {inner}
          </Link>
        ) : (
          <span key={r.recipeName} className="global-live-runs-strip-row">
            {inner}
          </span>
        );
      })}
      {overflow > 0 && (
        <Link href="/runs" className="global-live-runs-strip-overflow">
          +{overflow} more
        </Link>
      )}
    </div>
  );
}
