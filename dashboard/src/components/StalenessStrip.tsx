"use client";

import { useEffect, useState } from "react";
import {
  getStaleFetchSummary,
  subscribeStaleFetchRegistry,
} from "@/lib/staleFetchRegistry";

/**
 * One global slim strip, rendered by Shell, that surfaces "the data
 * you're looking at may be frozen" — the aggregate of every
 * `useBridgeFetch({ trackStaleness: true })` instance across the app.
 *
 * Deliberately NOT a per-page banner: individual poll hooks fail
 * independently and at different cadences, so a banner-per-hook would
 * either spam the page or require every page to duplicate this wiring.
 * A single strip driven by the shared registry keeps the signal in one
 * place, matching the precedent set by BridgeOfflineBanner (also one
 * strip, driven by aggregated bridge-status state) — but staleness is a
 * "the poll for THIS data went quiet" signal, distinct from "the bridge
 * process itself is unreachable", so it's a separate component rather
 * than folded into BridgeOfflineBanner's condition.
 *
 * Timestamp choice: shows the MOST RECENT successful fetch across all
 * registered fetchers (not the earliest-stale one) — that's the
 * honest "freshest data we can vouch for" answer, and matches the
 * intuitive reading of "Data as of HH:MM:SS".
 *
 * Retry affordance: retries every currently-stale registered fetcher
 * (calls each hook's `refetch()`) rather than a full page reload —
 * cheap, targeted, and reuses the same backoff-aware fetch path the
 * hook already has.
 */

const POLL_MS = 1000;

function formatClock(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function StalenessStrip() {
  const [summary, setSummary] = useState(() => getStaleFetchSummary());

  useEffect(() => {
    const recompute = () => setSummary(getStaleFetchSummary());
    recompute();
    const unsubscribe = subscribeStaleFetchRegistry(recompute);
    const id = setInterval(recompute, POLL_MS);
    return () => {
      unsubscribe();
      clearInterval(id);
    };
  }, []);

  if (!summary.anyStale) return null;

  const asOf =
    summary.mostRecentSuccessAt !== null
      ? formatClock(summary.mostRecentSuccessAt)
      : "unknown";

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: "color-mix(in srgb, var(--amber) 14%, var(--surface))",
        borderBottom: "1px solid color-mix(in srgb, var(--amber) 40%, transparent)",
        padding: "8px 20px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        fontSize: "var(--fs-s)",
        color: "var(--ink-1)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "var(--amber)",
          flexShrink: 0,
        }}
      />
      <span>
        Data as of <strong>{asOf}</strong> — reconnecting…
      </span>

      <span style={{ flex: 1, minWidth: 12 }} aria-hidden="true" />

      <button
        type="button"
        onClick={() => summary.retryStale()}
        style={{
          background: "transparent",
          border: "1px solid color-mix(in srgb, var(--amber) 35%, transparent)",
          color: "var(--ink-2)",
          padding: "3px 10px",
          borderRadius: "var(--r-2)",
          fontSize: "var(--fs-xs)",
          cursor: "pointer",
        }}
      >
        Retry now
      </button>
    </div>
  );
}
