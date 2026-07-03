"use client";

/**
 * Tiny module-level registry that `useBridgeFetch` instances opt into
 * (via `options.trackStaleness`) so `Shell` can render ONE aggregate
 * "data may be stale" strip instead of a banner per page/poll.
 *
 * Deliberately not React context: `useBridgeFetch` is called from deep
 * leaf components on many different pages, and a context provider would
 * need to wrap the whole app just to carry a handful of numbers that
 * change on independent timers. A plain subscribable module singleton
 * is simpler and avoids re-rendering the entire tree on every tick.
 */

export interface StaleEntry {
  /** Stable per-hook-instance id, e.g. `${path}#${mountIndex}`. */
  id: string;
  /** Epoch ms of the last successful fetch, or null if none yet. */
  lastSuccessAt: number | null;
  /** ms since lastSuccessAt after which this entry counts as stale. */
  staleAfterMs: number;
  /** Re-runs the underlying hook's fetch immediately. */
  refetch: () => void;
}

type Listener = () => void;

const entries = new Map<string, StaleEntry>();
const listeners = new Set<Listener>();

function notify() {
  for (const l of listeners) l();
}

export function registerStaleFetch(entry: StaleEntry): () => void {
  entries.set(entry.id, entry);
  notify();
  return () => {
    entries.delete(entry.id);
    notify();
  };
}

export function updateStaleFetch(id: string, lastSuccessAt: number | null): void {
  const existing = entries.get(id);
  if (!existing) return;
  existing.lastSuccessAt = lastSuccessAt;
  notify();
}

export function subscribeStaleFetchRegistry(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface StaleFetchSummary {
  /** True when at least one registered fetcher is currently stale. */
  anyStale: boolean;
  /**
   * Most recent successful fetch across ALL registered fetchers (not
   * just the stale ones) — this is the freshest timestamp we can
   * honestly show the user as "data as of".
   */
  mostRecentSuccessAt: number | null;
  /** Retry every currently-stale fetcher. */
  retryStale: () => void;
}

export function getStaleFetchSummary(): StaleFetchSummary {
  const now = Date.now();
  let anyStale = false;
  let mostRecentSuccessAt: number | null = null;
  const staleIds: string[] = [];

  for (const entry of entries.values()) {
    if (entry.lastSuccessAt !== null) {
      if (mostRecentSuccessAt === null || entry.lastSuccessAt > mostRecentSuccessAt) {
        mostRecentSuccessAt = entry.lastSuccessAt;
      }
    }
    const isStale =
      entry.lastSuccessAt !== null && now - entry.lastSuccessAt > entry.staleAfterMs;
    if (isStale) {
      anyStale = true;
      staleIds.push(entry.id);
    }
  }

  return {
    anyStale,
    mostRecentSuccessAt,
    retryStale: () => {
      for (const id of staleIds) {
        entries.get(id)?.refetch();
      }
    },
  };
}

/** Test-only escape hatch to reset module state between test files. */
export function __resetStaleFetchRegistryForTests(): void {
  entries.clear();
  listeners.clear();
}

// ---------------------------------------------------------------------------
// useManualPollStaleness
// ---------------------------------------------------------------------------
//
// Some pages' primary data feed predates `useBridgeFetch` and runs its own
// hand-rolled `useEffect` + `setInterval` poll loop (e.g. runs/page.tsx's
// filter-driven /api/bridge/runs fetch, page.tsx's Promise.all tick()).
// Rewriting those loops onto `useBridgeFetch` is out of scope for wiring up
// staleness — they carry request-cancellation, multi-endpoint fan-out, and
// filter-dependency behavior `useBridgeFetch` doesn't support. This hook
// lets them opt into the SAME registry `useBridgeFetch({ trackStaleness })`
// writes to, by calling `markSuccess()` from inside their existing tick()
// on every successful poll — no fetch/timer logic duplicated here.

import { useEffect, useId, useRef } from "react";

export function useManualPollStaleness(options: {
  /** Human-readable key, e.g. "/api/bridge/runs". Combined with a stable
   *  React id so multiple pages using the same endpoint don't collide. */
  key: string;
  /** Same semantics as useBridgeFetch's intervalMs — the poll's normal
   *  cadence; staleness threshold is 3x this. */
  intervalMs: number;
  /** Call to force an immediate reload (wired to the strip's retry). */
  refetch: () => void;
  enabled?: boolean;
}): { markSuccess: () => void } {
  const { key, intervalMs, refetch, enabled = true } = options;
  const reactId = useId();
  const idRef = useRef(`${key}#${reactId}`);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    if (!enabled) return;
    const unregister = registerStaleFetch({
      id: idRef.current,
      lastSuccessAt: null,
      staleAfterMs: 3 * intervalMs,
      refetch: () => refetchRef.current(),
    });
    return unregister;
  }, [enabled, intervalMs]);

  return {
    markSuccess: () => {
      if (!enabled) return;
      updateStaleFetch(idRef.current, Date.now());
    },
  };
}
