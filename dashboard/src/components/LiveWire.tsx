"use client";

import Link from "next/link";
import { relTime } from "@/components/time";
import type { LiveRun } from "./LiveRunsStrip";

/**
 * Slim always-present heartbeat line above the telemetry tiles. The
 * LiveRunsStrip auto-hides when there's nothing in flight, which is
 * great signal hygiene but leaves the Overview feeling static during
 * quiet stretches. This always-on 1-row strip gives the page a
 * constant pulse:
 *
 *   ● 2 running · last finished 4m ago
 *   ◌ quiet · last run 3h ago
 *   ◌ bridge offline
 *
 * Pairs with LiveRunsStrip — when runningCount > 0 this row stays
 * subtle and the cards below carry the detail; when runningCount is
 * 0 this is the only "live" surface and the cards-strip is hidden.
 */
interface LiveWireProps {
  runs: LiveRun[];
  bridgeOk: boolean;
}

function nameOf(r: LiveRun): string {
  return (r.recipeName ?? r.recipe ?? "").replace(/:agent$/, "");
}

export function LiveWire({ runs, bridgeOk }: LiveWireProps) {
  const running = runs.filter((r) => r.status === "running");
  const finished = runs
    .filter((r) => r.status !== "running")
    .sort((a, b) => (b.doneAt ?? b.startedAt) - (a.doneAt ?? a.startedAt));
  const lastFinished = finished[0];

  const isLive = running.length > 0;
  const isQuiet = !isLive && !!lastFinished;
  const isOffline = !bridgeOk;

  const dotClass = isOffline
    ? "live-wire-dot live-wire-dot-off"
    : isLive
      ? "live-wire-dot live-wire-dot-on"
      : "live-wire-dot live-wire-dot-idle";

  return (
    <div className="live-wire" data-state={isOffline ? "offline" : isLive ? "live" : "quiet"}>
      <span className={dotClass} aria-hidden="true" />
      <span className="live-wire-text">
        {isOffline ? (
          <>
            Bridge offline ·{" "}
            <Link href="/connections" className="live-wire-link">
              check connections →
            </Link>
          </>
        ) : isLive ? (
          <>
            <b style={{ color: "var(--ok)" }}>{running.length} running</b>
            {running.length <= 2 && (
              <span style={{ color: "var(--ink-3)" }}>
                {" · "}
                {running.map(nameOf).filter(Boolean).join(", ")}
              </span>
            )}
            {lastFinished && (
              <span style={{ color: "var(--ink-3)" }}>
                {" · last finished "}
                {relTime(lastFinished.doneAt ?? lastFinished.startedAt)}
              </span>
            )}
          </>
        ) : isQuiet ? (
          <>
            <span style={{ color: "var(--ink-3)" }}>Quiet · last run </span>
            <Link
              href={`/runs?recipe=${encodeURIComponent(nameOf(lastFinished))}`}
              className="live-wire-link"
            >
              {nameOf(lastFinished)}
            </Link>
            <span style={{ color: "var(--ink-3)" }}>
              {" "}
              {relTime(lastFinished.doneAt ?? lastFinished.startedAt)}
            </span>
          </>
        ) : (
          <span style={{ color: "var(--ink-3)" }}>
            Idle ·{" "}
            <Link href="/recipes" className="live-wire-link">
              run a recipe to begin →
            </Link>
          </span>
        )}
      </span>
    </div>
  );
}
