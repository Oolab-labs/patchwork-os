"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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

/**
 * Builds a one-line summary of the current run set, used only to detect
 * *meaningful* state transitions (a run finishing, halting, erroring, or
 * a new run starting). The visual strip re-renders on every progress
 * tick (`Step 3/7` → `Step 4/7`); announcing every tick floods screen
 * readers, so the polite live-region carries this stable summary instead
 * and only updates when a run changes lifecycle state.
 */
function transitionKey(
  runs: { recipeName: string; status: string }[],
): string {
  return runs
    .map((r) => `${r.recipeName}:${r.status}`)
    .sort()
    .join("|");
}

export function GlobalLiveRunsStrip() {
  const runs = useActiveRuns();
  // Order: running first, then most recent terminal first.
  const all = Array.from(runs.values()).sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (b.status === "running" && a.status !== "running") return 1;
    return b.startedAt - a.startedAt;
  });

  // Announce only lifecycle transitions, not per-step progress ticks.
  const [announce, setAnnounce] = useState("");
  const lastKeyRef = useRef("");
  useEffect(() => {
    const key = transitionKey(all);
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    const running = all.filter((r) => r.status === "running").length;
    const halted = all.filter((r) => r.status === "halted").length;
    const errored = all.filter(
      (r) => r.status !== "running" && r.status !== "ok" && r.status !== "halted",
    ).length;
    const parts: string[] = [];
    if (running > 0) parts.push(`${running} run${running === 1 ? "" : "s"} in progress`);
    if (halted > 0) parts.push(`${halted} halted`);
    if (errored > 0) parts.push(`${errored} errored`);
    setAnnounce(parts.length > 0 ? parts.join(", ") : "");
  }, [all]);

  if (all.length === 0) return null;

  const visible = all.slice(0, MAX_VISIBLE);
  const overflow = all.length - visible.length;

  return (
    <div className="global-live-runs-strip">
      {/* Polite, atomic live region — carries a stable lifecycle summary
          that only changes on real transitions, so screen readers are
          not flooded by per-step progress updates from the visual rows
          below (which are intentionally not in a live region). */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announce}
      </p>
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
