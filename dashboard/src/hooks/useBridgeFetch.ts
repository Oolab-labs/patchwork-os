"use client";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";

export interface UseBridgeFetchResult<T> {
  data: T | null;
  error: string | undefined;
  loading: boolean;
  status: number | null;
  unsupported: boolean;
}

const MAX_BACKOFF_MS = 30_000;

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
  },
): UseBridgeFetchResult<T> {
  const intervalMs = options?.intervalMs ?? 5000;
  const enabled = options?.enabled ?? true;
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

  useEffect(() => {
    if (!enabled) return;

    let alive = true;
    let failures = 0;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch(apiPath(path));
        if (!alive) return;
        setStatus(res.status);

        if (res.status === 404) {
          setUnsupported(true);
          setData(unsupportedValueRef.current);
          setError(undefined);
          setLoading(false);
          failures = 0;
          schedule(intervalMs);
          return;
        }

        if (res.status === 503) {
          setError("Bridge not running");
          setLoading(false);
          failures++;
          schedule(nextDelay(failures, intervalMs));
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
  }, [path, intervalMs, enabled]);

  return { data, error, loading, status, unsupported };
}
