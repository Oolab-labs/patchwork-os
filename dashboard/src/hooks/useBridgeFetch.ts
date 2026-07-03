"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { registerStaleFetch, updateStaleFetch } from "@/lib/staleFetchRegistry";

export interface UseBridgeFetchResult<T> {
  data: T | null;
  error: string | undefined;
  loading: boolean;
  status: number | null;
  unsupported: boolean;
  refetch: () => void;
  /**
   * True when it's been more than 3x intervalMs since the last successful
   * fetch. `data` is never cleared on failure (see tick()'s error
   * branches), so without this flag a stalled poll loop is
   * indistinguishable from "nothing is happening" — the dashboard would
   * silently show frozen numbers. Only meaningful when
   * `options.trackStaleness` is set; otherwise always false.
   */
  stale: boolean;
}

const MAX_BACKOFF_MS = 30_000;
/** How far past a successful fetch before we call the data "stale". */
const STALE_AFTER_INTERVALS = 3;
/** Cadence of the staleness re-check ticker — cheap re-render trigger,
 *  NOT a new fetch. Independent of intervalMs so this stays correct even
 *  if the poll loop itself has stalled entirely (e.g. every scheduled
 *  tick is awaiting a hung fetch). */
const STALE_CHECK_MS = 1000;

function nextDelay(failures: number, baseMs: number): number {
  const exp = Math.min(baseMs * 2 ** failures, MAX_BACKOFF_MS);
  // ±20% jitter to avoid thundering-herd when multiple hooks recover together
  return exp * (0.8 + Math.random() * 0.4);
}

export function useBridgeFetch<T>(
  path: string,
  options?: {
    intervalMs?: number;
    transform?: (data: unknown) => T;
    unsupportedValue?: T | null;
    enabled?: boolean;
    /**
     * Opt-in: registers this hook's staleness with the global
     * staleFetchRegistry (drives Shell's single aggregate strip) and
     * computes `stale` on the returned result. Off by default — most
     * `useBridgeFetch` call sites are secondary/background polls (KPI
     * widgets, outcomes tables, etc.) where flagging global staleness
     * for a poll nobody's watching would be a false positive. Set this
     * on the handful of call sites that represent a page's primary,
     * user-visible data feed.
     */
    trackStaleness?: boolean;
  },
): UseBridgeFetchResult<T> {
  const intervalMs = options?.intervalMs ?? 5000;
  const enabled = options?.enabled ?? true;
  const trackStaleness = options?.trackStaleness ?? false;
  const transformRef = useRef(options?.transform);
  transformRef.current = options?.transform;
  // Hold unsupportedValue in a ref so the effect doesn't restart when callers
  // pass an inline literal (object/array) — that triggered a fetch storm.
  const unsupportedValueRef = useRef<T | null>(
    (options?.unsupportedValue ?? null) as T | null,
  );
  unsupportedValueRef.current = (options?.unsupportedValue ?? null) as T | null;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<number | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  // Caller-triggered re-fetch token; bumping it triggers an immediate tick.
  const [refetchToken, setRefetchToken] = useState(0);
  const refetch = useCallback(() => setRefetchToken((n) => n + 1), []);

  // Epoch ms of the last successful fetch (res.ok + JSON parsed). Read
  // from a ref so the staleness ticker below can recompute `stale` on its
  // own cadence without depending on tick()'s closures.
  const lastSuccessAtRef = useRef<number | null>(null);
  const [stale, setStale] = useState(false);
  const staleAfterMs = STALE_AFTER_INTERVALS * intervalMs;

  // Stable per-hook-instance id for the registry.
  const reactId = useId();
  const registryId = `${path}#${reactId}`;

  useEffect(() => {
    if (!enabled) return;

    // Audit 2026-06-10 (dashboard-ui-3): reset to the loading state whenever the
    // effect re-runs (e.g. `path` changed). Otherwise the hook keeps loading=false
    // and exposes the previous path's stale `data` until the new fetch lands.
    setLoading(true);
    setData(null);

    let alive = true;
    let failures = 0;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch(apiPath(path), { cache: "no-store" });
        if (!alive) return;
        setStatus(res.status);

        if (res.status === 404) {
          // 404 is a stable terminal state: either the endpoint isn't
          // implemented by this bridge version (older bridge) or the resource
          // ID doesn't exist (e.g. /sessions/<gone-uuid>). Polling won't make
          // either appear — and on session-detail pages with a 3s interval it
          // generates a 404-per-tick stream that fills server logs and burns
          // network. Stop the loop. Callers that want to retry call refetch().
          setUnsupported(true);
          setData(unsupportedValueRef.current);
          setError(undefined);
          setLoading(false);
          return;
        }

        if (res.status === 503) {
          setError("Bridge not running");
          setLoading(false);
          failures++;
          schedule(nextDelay(failures, intervalMs));
          return;
        }

        // #605 BLOCKER: 401/403 used to fall through to the generic
        // !res.ok branch and re-schedule indefinitely — persistent auth
        // failure (cookie expired, password rotated) became a forever
        // poll at the backoff cap. Treat as terminal like 404; the
        // dashboard's session-required middleware redirects html navs
        // to /login on its own, and refetch() can resume after re-auth.
        if (res.status === 401 || res.status === 403) {
          setError(res.status === 401 ? "Not signed in" : "Forbidden");
          setLoading(false);
          return;
        }

        if (!res.ok) {
          setError(`Request failed: ${res.status}`);
          setLoading(false);
          failures++;
          schedule(nextDelay(failures, intervalMs));
          return;
        }

        const raw: unknown = await res.json();
        if (!alive) return;
        const result = transformRef.current ? transformRef.current(raw) : (raw as T);
        setData(result);
        setUnsupported(false);
        setError(undefined);
        setLoading(false);
        failures = 0;
        lastSuccessAtRef.current = Date.now();
        setStale(false);
        if (trackStaleness) updateStaleFetch(registryId, lastSuccessAtRef.current);
        schedule(intervalMs);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
        failures++;
        schedule(nextDelay(failures, intervalMs));
      }
    };

    function schedule(ms: number) {
      if (!alive) return;
      timerId = setTimeout(tick, ms);
    }

    tick();
    return () => {
      alive = false;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [path, intervalMs, enabled, refetchToken, trackStaleness, registryId]);

  // Staleness re-check ticker: recomputes `stale` on a cheap fixed
  // cadence (no fetch, just a Date.now() comparison) so staleness still
  // flips even if the poll loop itself has stalled entirely — e.g. every
  // scheduled tick is awaiting a hung fetch and never reaches a
  // success/failure branch to reschedule.
  useEffect(() => {
    if (!enabled) return;
    const recompute = () => {
      const last = lastSuccessAtRef.current;
      const isStale = last !== null && Date.now() - last > staleAfterMs;
      setStale(isStale);
    };
    recompute();
    const id = setInterval(recompute, STALE_CHECK_MS);
    return () => clearInterval(id);
  }, [enabled, staleAfterMs]);

  // Registry registration: opt-in only. Registers once per mount and
  // exposes a refetch() so the global staleness strip can retry this
  // fetcher specifically.
  useEffect(() => {
    if (!trackStaleness || !enabled) return;
    const unregister = registerStaleFetch({
      id: registryId,
      lastSuccessAt: lastSuccessAtRef.current,
      staleAfterMs,
      refetch,
    });
    return unregister;
  }, [trackStaleness, enabled, registryId, staleAfterMs, refetch]);

  return { data, error, loading, status, unsupported, refetch, stale: trackStaleness ? stale : false };
}
